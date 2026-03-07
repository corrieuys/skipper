import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { AgentManager } from "./manager";
import { PromptBuilder } from "./prompt-builder";
import { TaskScheduler } from "../tasks/scheduler";
import { TeamManager } from "../teams/manager";
import { StateTracker } from "./state-tracker";
import { EscalationManager } from "../escalations/manager";
import { eventBus } from "../events/bus";
import type { AgentExitEvent, AgentSignalEvent } from "../events/bus";
import { logError } from "../logging";
import { getAgentTypeDefinition } from "./types";

import { DaemonLoop } from "../orchestrator/tick-loop";
import { TaskRunner } from "../orchestrator/task-runner";
import { PhaseManager } from "../orchestrator/phase-manager";
import { DelegationManager } from "../orchestrator/delegation-manager";
import type { Delegation } from "../orchestrator/delegation-manager";
import { RecoveryManager } from "../orchestrator/recovery-manager";
import { HealthMonitor } from "../orchestrator/health-monitor";
import type { OrchestrationState, TaskCheckpoint } from "../orchestrator/types";

export type { Delegation };
export type { OrchestrationState, TaskCheckpoint };

const STREAMS_DRAIN_TIMEOUT_MS = 5_000;
const PROMPT_TOO_LONG_PATTERN = /prompt.*(too long|too large)|context.*(too long|exceeded|overflow)|token.*limit.*exceeded/i;
const MAX_PROMPT_TOO_LONG_RETRIES = 1;

/**
 * Thin facade that wires together the focused orchestrator modules
 * and preserves backward compatibility for external consumers.
 */
export class ManagerDaemon {
  private db: Database;
  private agentManager: AgentManager;
  private taskScheduler: TaskScheduler;
  private stateTracker: StateTracker;
  private escalationManager: EscalationManager;
  private exitHandlerRegistered = false;
  private signalHandlerRegistered = false;

  // Orchestrator modules
  private daemonLoop: DaemonLoop;
  private taskRunner: TaskRunner;
  private phaseManager: PhaseManager;
  private delegationManager: DelegationManager;
  private recoveryManager: RecoveryManager;
  private healthMonitor: HealthMonitor;

  constructor(db?: Database) {
    this.db = db ?? getDb();
    this.agentManager = new AgentManager(this.db);
    const promptBuilder = new PromptBuilder(this.db);
    this.taskScheduler = new TaskScheduler(this.db);
    const teamManager = new TeamManager(this.db);
    this.stateTracker = new StateTracker(this.db, this.agentManager);

    // Shared helpers used by multiple modules
    const setAgentState = (agentId: string, state: string, metadata?: Record<string, unknown>): void => {
      try {
        const metadataJson = metadata ? JSON.stringify(metadata) : "{}";
        this.db
          .prepare(
            `INSERT INTO agent_states (agent_id, state, state_metadata)
             VALUES (?, ?, ?)
             ON CONFLICT(agent_id) DO UPDATE SET
               state = ?,
               state_metadata = ?,
               updated_at = datetime('now')`,
          )
          .run(agentId, state, metadataJson, state, metadataJson);

        eventBus.emit("agent:state_changed", {
          agentId,
          previousState: "",
          newState: state,
        });
      } catch (err) {
        logError(this.db, "agent_state_update", { agentId, state, method: "setAgentState" }, err);
      }
    };

    // Create RecoveryManager (owns orchestration state + checkpoints)
    this.recoveryManager = new RecoveryManager(
      this.db,
      this.agentManager,
      promptBuilder,
      this.taskScheduler,
      teamManager,
      () => this.phaseManager.getPhaseCompleteHandled(),
      () => this.phaseManager.getPendingRegressions(),
      setAgentState,
      (id: string) => this.delegationManager.getDelegation(id),
    );

    // Bound references to recovery manager methods for other modules
    const updateOrchestrationState = (taskId: string, state: OrchestrationState): void => {
      this.recoveryManager.updateOrchestrationState(taskId, state);
    };
    const writeCheckpoint = (taskId: string, type: string, snapshot?: Record<string, unknown>): void => {
      this.recoveryManager.writeCheckpoint(taskId, type, snapshot);
    };

    // Create PhaseManager
    this.phaseManager = new PhaseManager(
      this.db,
      this.agentManager,
      promptBuilder,
      this.taskScheduler,
      teamManager,
      updateOrchestrationState,
      writeCheckpoint,
    );

    // Create DelegationManager
    this.delegationManager = new DelegationManager(
      this.db,
      this.agentManager,
      promptBuilder,
      this.taskScheduler,
      setAgentState,
      updateOrchestrationState,
      writeCheckpoint,
      () => this.phaseManager.getPhaseCompleteHandled(),
    );

    // Create TaskRunner
    this.taskRunner = new TaskRunner(
      this.db,
      this.agentManager,
      promptBuilder,
      this.taskScheduler,
      teamManager,
      updateOrchestrationState,
      writeCheckpoint,
    );

    // Create HealthMonitor
    this.healthMonitor = new HealthMonitor(
      this.db,
      this.agentManager,
      this.taskScheduler,
      this.stateTracker,
      (childAgentId: string) => this.delegationManager.getActiveDelegationForChild(childAgentId),
    );

    // Create EscalationManager
    this.escalationManager = new EscalationManager(this.db, this.agentManager);

    // Create DaemonLoop (orchestrates all modules)
    this.daemonLoop = new DaemonLoop(
      this.db,
      this.agentManager,
      this.taskRunner,
      this.recoveryManager,
      this.delegationManager,
      this.healthMonitor,
    );

    this.registerExitHandler();
    this.registerSignalHandler();
  }

  // --- Expose for testing ---

  getAgentManager(): AgentManager {
    return this.agentManager;
  }

  getTaskScheduler(): TaskScheduler {
    return this.taskScheduler;
  }

  getStateTracker(): StateTracker {
    return this.stateTracker;
  }

  getTaskRunner(): TaskRunner {
    return this.taskRunner;
  }

  getPhaseManager(): PhaseManager {
    return this.phaseManager;
  }

  getDelegationManager(): DelegationManager {
    return this.delegationManager;
  }

  getRecoveryManager(): RecoveryManager {
    return this.recoveryManager;
  }

  getHealthMonitor(): HealthMonitor {
    return this.healthMonitor;
  }

  getEscalationManager(): EscalationManager {
    return this.escalationManager;
  }

  getDaemonLoop(): DaemonLoop {
    return this.daemonLoop;
  }

  // --- Lifecycle (delegated to DaemonLoop) ---

  async start(): Promise<void> {
    return this.daemonLoop.start();
  }

  stop(): void {
    this.daemonLoop.stop();
  }

  getStatus(): { state: "running" | "pausing" | "paused" | "stopped"; uptime: number } {
    return this.daemonLoop.getStatus();
  }

  pause(): Promise<void> {
    return this.daemonLoop.pause();
  }

  resume(): void {
    this.daemonLoop.resume();
  }

  async tick(): Promise<void> {
    return this.daemonLoop.tick();
  }

  // --- Task Processing (delegated to TaskRunner) ---

  async processTaskQueue(): Promise<{ processed: number }> {
    return this.taskRunner.processTaskQueue();
  }

  // --- Health Checks (delegated to HealthMonitor) ---

  checkProcessHealth(): void {
    this.healthMonitor.checkProcessHealth();
  }

  // --- Phase Management (delegated to PhaseManager) ---

  handlePhaseComplete(agentId: string): void {
    this.phaseManager.handlePhaseComplete(agentId);
  }

  handlePhaseRegression(agentId: string, targetPhaseOneIndexed: number, reason: string): void {
    this.phaseManager.handlePhaseRegression(agentId, targetPhaseOneIndexed, reason);
  }

  getPendingRegression(agentId: string): { targetPhase: number; reason: string } | undefined {
    return this.phaseManager.getPendingRegression(agentId);
  }

  getPhaseCompleteHandled(): Set<string> {
    return this.phaseManager.getPhaseCompleteHandled();
  }

  // --- Delegation (delegated to DelegationManager) ---

  async handleDelegation(
    parentAgentId: string,
    childAgentId: string,
    delegationPrompt: string,
  ): Promise<Delegation | null> {
    return this.delegationManager.handleDelegation(parentAgentId, childAgentId, delegationPrompt);
  }

  handleDelegateComplete(childAgentId: string, result: string): void {
    this.delegationManager.handleDelegateComplete(childAgentId, result);
  }

  checkStaleDelegations(): number {
    return this.delegationManager.checkStaleDelegations();
  }

  getDelegation(id: string): Delegation | null {
    return this.delegationManager.getDelegation(id);
  }

  getActiveDelegationForParent(parentAgentId: string): Delegation | null {
    return this.delegationManager.getActiveDelegationForParent(parentAgentId);
  }

  getActiveDelegationForChild(childAgentId: string): Delegation | null {
    return this.delegationManager.getActiveDelegationForChild(childAgentId);
  }

  // --- Recovery & Resilience (delegated to RecoveryManager) ---

  cleanupStaleState(): void {
    this.recoveryManager.cleanupStaleState();
  }

  async recoverAllStaleTasks(): Promise<number> {
    return this.recoveryManager.recoverAllStaleTasks();
  }

  async recoverTask(taskId: string): Promise<boolean> {
    return this.recoveryManager.recoverTask(taskId);
  }

  // --- Orchestration State & Checkpoints (delegated to RecoveryManager) ---

  updateOrchestrationState(taskId: string, state: OrchestrationState): void {
    this.recoveryManager.updateOrchestrationState(taskId, state);
  }

  getOrchestrationState(taskId: string): OrchestrationState | null {
    return this.recoveryManager.getOrchestrationState(taskId);
  }

  writeCheckpoint(
    taskId: string,
    checkpointType: string,
    contextSnapshot: Record<string, unknown> = {},
  ): void {
    this.recoveryManager.writeCheckpoint(taskId, checkpointType, contextSnapshot);
  }

  getLatestCheckpoint(taskId: string): TaskCheckpoint | null {
    return this.recoveryManager.getLatestCheckpoint(taskId);
  }

  // --- Exit Handler ---

  private registerExitHandler(): void {
    if (this.exitHandlerRegistered) return;
    this.exitHandlerRegistered = true;

    eventBus.on("agent:exit", (event: AgentExitEvent) => {
      this.agentManager.waitForStreamsDrained(event.agentId, STREAMS_DRAIN_TIMEOUT_MS)
        .then(() => this.handleAgentExit(event));
    });
  }

  private registerSignalHandler(): void {
    if (this.signalHandlerRegistered) return;
    this.signalHandlerRegistered = true;

    eventBus.on("agent:signal", (event: AgentSignalEvent) => {
      try {
        this.handleAgentSignal(event);
      } catch (err) {
        logError(this.db, "agent_signal_handler", { agentId: event.agentId, signalType: event.signalType }, err);
      }
    });
  }

  private handleAgentSignal(event: AgentSignalEvent): void {
    switch (event.signalType) {
      case "delegate":
        if (event.targetAgent && event.content) {
          this.delegationManager.handleDelegation(event.agentId, event.targetAgent, event.content)
            .catch((err) => logError(this.db, "delegation_signal", { agentId: event.agentId, targetAgent: event.targetAgent }, err));
        }
        break;

      case "delegate_complete":
        if (event.content) {
          this.delegationManager.handleDelegateComplete(event.agentId, event.content);
        }
        break;

      case "escalate":
        if (event.content) {
          this.escalationManager.handleEscalation(event.agentId, event.content);
        }
        break;

      case "note":
        if (event.content) {
          this.handleNote(event.agentId, event.content);
        }
        break;

      case "phase_complete":
        this.phaseManager.handlePhaseComplete(event.agentId);
        break;

      case "phase_regression":
        if (event.targetPhase !== undefined && event.reason) {
          this.phaseManager.handlePhaseRegression(event.agentId, event.targetPhase, event.reason);
        }
        break;

      case "message":
        // Agent-to-agent messages: log to messages table for audit trail
        if (event.targetAgent && event.content) {
          try {
            // targetAgent may be an agent name — resolve to ID
            const targetRow = this.db
              .prepare("SELECT id FROM agents WHERE id = ? OR name = ? LIMIT 1")
              .get(event.targetAgent, event.targetAgent) as { id: string } | null;
            if (!targetRow) break;
            const agentRow = this.db
              .prepare("SELECT current_task_id FROM agents WHERE id = ?")
              .get(event.agentId) as { current_task_id: string | null } | null;
            this.db
              .prepare(
                "INSERT INTO messages (id, from_agent_id, to_agent_id, task_id, type, content) VALUES (?, ?, ?, ?, 'agent', ?)",
              )
              .run(crypto.randomUUID(), event.agentId, targetRow.id, agentRow?.current_task_id ?? null, event.content);
          } catch (err) {
            logError(this.db, "message_store", { agentId: event.agentId, targetAgent: event.targetAgent }, err);
          }
        }
        break;

      case "task_complete":
        // Explicit task completion signal — complete the task immediately
        if (event.taskId) {
          try {
            this.taskScheduler.completeTask(event.taskId);
          } catch (err) {
            logError(this.db, "task_complete_signal", { agentId: event.agentId, taskId: event.taskId }, err);
          }
        }
        break;

      default:
        // Unknown signal type — ignore
        break;
    }
  }

  private handleNote(agentId: string, content: string): void {
    const agentRow = this.db
      .prepare("SELECT current_task_id FROM agents WHERE id = ?")
      .get(agentId) as { current_task_id: string | null } | null;

    if (!agentRow?.current_task_id) return;

    try {
      const noteId = crypto.randomUUID();
      this.db
        .prepare(
          "INSERT INTO task_notes (id, task_id, agent_id, content) VALUES (?, ?, ?, ?)",
        )
        .run(noteId, agentRow.current_task_id, agentId, content);

      eventBus.emit("task:note_added", {
        noteId,
        taskId: agentRow.current_task_id,
        agentId,
        content,
      });
    } catch (err) {
      logError(this.db, "note_create", { agentId, method: "handleNote" }, err);
    }
  }

  private handleAgentExit(event: AgentExitEvent): void {
    if (event.isRespawn) return;
    if (event.hasDelegation) return;

    try {
      const activeDelegation = this.delegationManager.getActiveDelegationForChild(event.agentId);
      if (activeDelegation) {
        this.delegationManager.handleChildExit(activeDelegation, event);
        return;
      }

      const agentRow = this.db
        .prepare("SELECT current_task_id FROM agents WHERE id = ?")
        .get(event.agentId) as { current_task_id: string | null } | null;

      if (!agentRow?.current_task_id) return;

      const taskId = agentRow.current_task_id;
      const task = this.taskScheduler.getTask(taskId);
      if (!task || task.status !== "running") return;

      // Don't complete/advance if this agent has an active delegation as parent
      const parentDelegation = this.delegationManager.getActiveDelegationForParent(event.agentId);
      if (parentDelegation) {
        // Parent exited while delegation is in progress — wait for child to finish
        return;
      }

      if (event.code === 0) {
        this.phaseManager.handleSuccessfulExit(task, event.agentId);
      } else if (this.isPromptTooLongError(event.stderrSnippet)) {
        this.handlePromptTooLong(event.agentId, taskId, task).catch((err) => {
          logError(this.db, "prompt_too_long_recovery", { agentId: event.agentId, taskId, method: "handleAgentExit" }, err);
          try {
            this.taskScheduler.failTask(taskId, `Prompt too long recovery failed: ${err instanceof Error ? err.message : String(err)}`);
          } catch (innerErr) {
            logError(this.db, "prompt_too_long_fail_task", { taskId, method: "handleAgentExit" }, innerErr);
          }
        });
      } else {
        this.phaseManager.clearPendingRegression(event.agentId);
        try {
          this.taskScheduler.failTask(taskId, `Agent exited with code ${event.code}`);
        } catch (err) {
          logError(this.db, "agent_exit_fail_task", { agentId: event.agentId, taskId: taskId, exitCode: event.code }, err);
        }
      }

      this.db
        .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
        .run(event.agentId);
    } catch (err) {
      logError(this.db, "agent_exit_handler", { agentId: event.agentId, method: "handleAgentExit" }, err);
    }
  }

  private isPromptTooLongError(stderrSnippet: string): boolean {
    return PROMPT_TOO_LONG_PATTERN.test(stderrSnippet);
  }

  private async handlePromptTooLong(
    agentId: string,
    taskId: string,
    task: import("../tasks/scheduler").Task,
  ): Promise<void> {
    // Check retry count to avoid infinite loops
    const retryKey = `prompt_too_long:${taskId}`;
    const retryRow = this.db
      .prepare("SELECT COUNT(*) as count FROM error_log WHERE category = ? AND context LIKE ?")
      .get("agent.prompt_too_long_retry", `%"taskId":"${taskId}"%`) as { count: number };

    if (retryRow.count >= MAX_PROMPT_TOO_LONG_RETRIES) {
      logError(this.db, "agent.prompt_too_long_max_retries", {
        agentId, taskId, retries: retryRow.count, method: "handlePromptTooLong",
      });
      this.phaseManager.clearPendingRegression(agentId);
      this.taskScheduler.failTask(
        taskId,
        `Prompt too long after ${retryRow.count} retry attempt(s). Task context exceeds CLI limits.`,
      );
      return;
    }

    logError(this.db, "agent.prompt_too_long_retry", {
      agentId, taskId, attempt: retryRow.count + 1, method: "handlePromptTooLong",
    });

    // Respawn with a minimal prompt (no enrichment, truncated description)
    const teamExec = task.team_id
      ? this.teamManager.getTeamForExecution(task.team_id)
      : null;

    const entrypointAgentId = teamExec?.entrypoint_agent_id ?? agentId;
    const agent = this.agentManager.getAgent(entrypointAgentId);
    if (!agent) {
      this.taskScheduler.failTask(taskId, "Agent not found for prompt-too-long recovery");
      return;
    }

    // Kill any running instance and respawn
    if (this.agentManager.getRunningAgent(entrypointAgentId)) {
      this.agentManager.killAgent(entrypointAgentId);
      await this.agentManager.waitForExit(entrypointAgentId);
    }

    const workingDir = process.cwd();
    await this.agentManager.spawnAgent(entrypointAgentId, { workingDir });

    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(taskId, entrypointAgentId);

    // Build a minimal recovery prompt without enrichment
    const description = task.description
      ? task.description.slice(0, 2000)
      : "";
    const recoveryPrompt = [
      "EXECUTION CONTEXT:",
      "- You are running inside Skipper, a multi-agent orchestration system.",
      "- Previous attempt failed: prompt was too long for the CLI context window.",
      "- This is a retry with reduced context. Complete the task with the information below.",
      "",
      `TASK: ${task.title}`,
      description,
      "",
      "Complete the assigned work. Output [PHASE_COMPLETE] when done.",
    ].join("\n");

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    const isStreaming = typeDef?.supports_stdin ?? false;
    const closeStdin = !isStreaming;

    this.agentManager.sendInput(entrypointAgentId, recoveryPrompt, closeStdin);
  }
}
