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

import { ReconciliationLoop } from "../orchestrator/tick-loop";
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
const PAUSE_RESUME_CONTINUE_MESSAGE = "[SYSTEM] Daemon resumed after pause. Continue from your existing session and proceed with remaining work.";

interface PausedRuntimeSnapshot {
  runtimeId: string;
  templateAgentId: string;
  taskId: string | null;
  parentInstanceId: string | null;
  rootInstanceId: string | null;
  sessionId: string | null;
  isStreaming: boolean;
}

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
  private exitHandler: ((event: AgentExitEvent) => void) | null = null;
  private signalHandler: ((event: AgentSignalEvent) => void) | null = null;
  private taskStateHandler: ((event: import("../events/bus").TaskStateChangedEvent) => void) | null = null;
  private pendingDelegationSignals: Map<string, number> = new Map();
  private deferredExitEvents: Map<string, AgentExitEvent> = new Map();
  private pauseInterruptedAgents: Set<string> = new Set();
  private pausedRuntimeSnapshots: PausedRuntimeSnapshot[] = [];

  // Orchestrator modules
  private reconciliationLoop: ReconciliationLoop;
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

    // Create ReconciliationLoop (orchestrates all modules)
    this.reconciliationLoop = new ReconciliationLoop(
      this.db,
      this.agentManager,
      this.taskRunner,
      this.recoveryManager,
      this.delegationManager,
      this.healthMonitor,
    );

    this.registerExitHandler();
    this.registerSignalHandler();
    this.registerTaskStateHandler();
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

  getReconciliationLoop(): ReconciliationLoop {
    return this.reconciliationLoop;
  }

  /** @deprecated Use getReconciliationLoop() */
  getDaemonLoop(): ReconciliationLoop {
    return this.reconciliationLoop;
  }

  // --- Lifecycle (delegated to ReconciliationLoop) ---

  async start(): Promise<void> {
    return this.reconciliationLoop.start();
  }

  stop(): void {
    this.reconciliationLoop.stop();
  }

  getStatus(): { state: "running" | "pausing" | "paused" | "stopped"; uptime: number } {
    return this.reconciliationLoop.getStatus();
  }

  pause(): Promise<void> {
    return this.pauseDaemonAndAgents();
  }

  resume(): void {
    this.resumeDaemonAndAgents();
  }

  async tick(): Promise<void> {
    return this.reconciliationLoop.tick();
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

    this.exitHandler = (event: AgentExitEvent) => {
      this.agentManager.waitForStreamsDrained(event.agentId, STREAMS_DRAIN_TIMEOUT_MS)
        .then(() => this.handleAgentExit(event));
    };
    eventBus.on("agent:exit", this.exitHandler);
  }

  private registerSignalHandler(): void {
    if (this.signalHandlerRegistered) return;
    this.signalHandlerRegistered = true;

    this.signalHandler = (event: AgentSignalEvent) => {
      try {
        this.handleAgentSignal(event);
      } catch (err) {
        logError(this.db, "agent_signal_handler", { agentId: event.agentId, signalType: event.signalType }, err);
      }
    };
    eventBus.on("agent:signal", this.signalHandler);
  }

  private handleAgentSignal(event: AgentSignalEvent): void {
    switch (event.signalType) {
      case "delegate":
        if (event.targetAgent && event.content) {
          // Block self-delegation at signal-parse time
          const templateId = this.agentManager.getTemplateAgentId(event.agentId) ?? event.agentId;
          const targetAgent = this.agentManager.getAgent(event.targetAgent);
          if (targetAgent && targetAgent.id === templateId) break;

          this.incrementPendingDelegationSignal(event.agentId);
          this.delegationManager.handleDelegation(event.agentId, event.targetAgent, event.content)
            .catch((err) => logError(this.db, "delegation_signal", { agentId: event.agentId, targetAgent: event.targetAgent }, err))
            .finally(() => this.decrementPendingDelegationSignal(event.agentId));
        }
        break;

      case "delegate_batch":
        if (event.content) {
          this.incrementPendingDelegationSignal(event.agentId);
          this.delegationManager.handleDelegationBatchSignal(event.agentId, event.content)
            .catch((err) => logError(this.db, "delegation_batch_signal", { agentId: event.agentId }, err))
            .finally(() => this.decrementPendingDelegationSignal(event.agentId));
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

  private registerTaskStateHandler(): void {
    this.taskStateHandler = (event: import("../events/bus").TaskStateChangedEvent) => {
      if (event.newStatus === "approved") {
        this.taskRunner.processTaskQueue().catch((err) => {
          logError(this.db, "reactive_task_dispatch", { taskId: event.taskId }, err);
        });
      }

      if (event.newStatus === "completed" || event.newStatus === "failed") {
        try {
          this.recoveryManager.cleanupTerminalTaskState(event.taskId);
        } catch (err) {
          logError(this.db, "terminal_task_cleanup_handler", { taskId: event.taskId, newStatus: event.newStatus }, err);
        }
        // Try to pick up the next approved task immediately
        this.taskRunner.processTaskQueue().catch((err) => {
          logError(this.db, "reactive_task_dispatch_after_terminal", { taskId: event.taskId }, err);
        });
      }
    };
    eventBus.on("task:state_changed", this.taskStateHandler);
  }

  destroy(): void {
    if (this.exitHandler) {
      eventBus.off("agent:exit", this.exitHandler);
      this.exitHandler = null;
    }
    if (this.signalHandler) {
      eventBus.off("agent:signal", this.signalHandler);
      this.signalHandler = null;
    }
    if (this.taskStateHandler) {
      eventBus.off("task:state_changed", this.taskStateHandler);
      this.taskStateHandler = null;
    }
    this.exitHandlerRegistered = false;
    this.signalHandlerRegistered = false;
  }

  private async handleAgentExit(event: AgentExitEvent): Promise<void> {
    // Track exit code for cluster detection
    this.healthMonitor.trackExitCode(event.agentId, event.code);

    if (event.isRespawn) return;
    if (event.hasDelegation) return;
    if (this.getPendingDelegationSignalCount(event.agentId) > 0) {
      this.deferredExitEvents.set(event.agentId, event);
      return;
    }
    if (this.pauseInterruptedAgents.has(event.agentId)) {
      this.pauseInterruptedAgents.delete(event.agentId);
      this.pendingDelegationSignals.delete(event.agentId);
      this.deferredExitEvents.delete(event.agentId);
      return;
    }

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
        await this.phaseManager.handleSuccessfulExit(task, event.agentId);
      } else {
        try {
          this.taskScheduler.failTask(taskId, `Agent exited with code ${event.code}`);
        } catch (err) {
          logError(this.db, "agent_exit_fail_task", { agentId: event.agentId, taskId: taskId, exitCode: event.code }, err);
        }
      }

      this.db
        .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
        .run(event.agentId);
      this.db
        .prepare(
          "UPDATE agent_instances SET status = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(event.code === 0 ? "completed" : "failed", event.agentId);
    } catch (err) {
      logError(this.db, "agent_exit_handler", { agentId: event.agentId, method: "handleAgentExit" }, err);
    }
  }

  private incrementPendingDelegationSignal(agentId: string): void {
    const count = this.pendingDelegationSignals.get(agentId) ?? 0;
    this.pendingDelegationSignals.set(agentId, count + 1);
  }

  private decrementPendingDelegationSignal(agentId: string): void {
    const count = this.pendingDelegationSignals.get(agentId) ?? 0;
    if (count <= 1) {
      this.pendingDelegationSignals.delete(agentId);
      this.flushDeferredExit(agentId);
      return;
    }
    this.pendingDelegationSignals.set(agentId, count - 1);
  }

  private getPendingDelegationSignalCount(agentId: string): number {
    return this.pendingDelegationSignals.get(agentId) ?? 0;
  }

  private flushDeferredExit(agentId: string): void {
    const deferred = this.deferredExitEvents.get(agentId);
    if (!deferred) return;
    this.deferredExitEvents.delete(agentId);
    this.handleAgentExit(deferred);
  }

  private async pauseDaemonAndAgents(): Promise<void> {
    const running = Array.from(this.agentManager.getRunningAgents().values());

    this.pausedRuntimeSnapshots = running.map((runtime) => {
      const agent = this.agentManager.getAgent(runtime.templateAgentId);
      const typeDef = agent ? getAgentTypeDefinition(agent.type, this.db) : null;
      return {
        runtimeId: runtime.id,
        templateAgentId: runtime.templateAgentId,
        taskId: runtime.taskId ?? null,
        parentInstanceId: runtime.parentInstanceId ?? null,
        rootInstanceId: runtime.rootInstanceId ?? null,
        sessionId: runtime.sessionId ?? this.agentManager.getSessionId(runtime.id),
        isStreaming: typeDef?.supports_stdin ?? false,
      };
    });

    for (const snapshot of this.pausedRuntimeSnapshots) {
      this.pauseInterruptedAgents.add(snapshot.runtimeId);
      this.agentManager.killAgent(snapshot.runtimeId);
    }

    await Promise.all(
      this.pausedRuntimeSnapshots.map((snapshot) => this.agentManager.waitForExit(snapshot.runtimeId, STREAMS_DRAIN_TIMEOUT_MS)),
    );

    if (this.pausedRuntimeSnapshots.length > 0) {
      const placeholders = this.pausedRuntimeSnapshots.map(() => "?").join(", ");
      this.db
        .prepare(`UPDATE agent_instances SET status = 'stopped', updated_at = datetime('now') WHERE id IN (${placeholders})`)
        .run(...this.pausedRuntimeSnapshots.map((snapshot) => snapshot.runtimeId));
      const templateIds = Array.from(new Set(this.pausedRuntimeSnapshots.map((snapshot) => snapshot.templateAgentId)));
      const templatePlaceholders = templateIds.map(() => "?").join(", ");
      this.db
        .prepare(`UPDATE agents SET process_pid = NULL, status = 'stopped', updated_at = datetime('now') WHERE id IN (${templatePlaceholders})`)
        .run(...templateIds);
    }

    await this.reconciliationLoop.pause();
  }

  private resumeDaemonAndAgents(): void {
    const snapshots = [...this.pausedRuntimeSnapshots];
    this.pausedRuntimeSnapshots = [];

    for (const snapshot of snapshots) {
      const templateAgent = this.agentManager.getAgent(snapshot.templateAgentId);
      const typeDef = templateAgent ? getAgentTypeDefinition(templateAgent.type, this.db) : null;
      if (!templateAgent || !typeDef) continue;

      const spawnPromise = snapshot.runtimeId === snapshot.templateAgentId
        ? this.agentManager.spawnAgent(snapshot.templateAgentId, {
            workingDir: process.cwd(),
            sessionId: snapshot.sessionId ?? undefined,
          })
        : this.agentManager.spawnAgentInstance(snapshot.templateAgentId, snapshot.runtimeId, {
            workingDir: process.cwd(),
            sessionId: snapshot.sessionId ?? undefined,
            taskId: snapshot.taskId,
            parentInstanceId: snapshot.parentInstanceId,
            rootInstanceId: snapshot.rootInstanceId,
          });

      spawnPromise
        .then(() => {
          if (snapshot.runtimeId === snapshot.templateAgentId && snapshot.taskId) {
            this.db
              .prepare(
                "UPDATE agent_instances SET status = 'running', process_pid = ?, session_id = ?, updated_at = datetime('now') WHERE id = ?",
              )
              .run(
                this.agentManager.getRunningAgent(snapshot.runtimeId)?.process.pid ?? null,
                snapshot.sessionId,
                snapshot.runtimeId,
              );
          }
          this.db
            .prepare("UPDATE agents SET current_task_id = ?, status = 'busy', updated_at = datetime('now') WHERE id = ?")
            .run(snapshot.taskId, snapshot.templateAgentId);

          const closeStdin = !(typeDef.supports_stdin ?? false);
          this.agentManager.sendInput(snapshot.runtimeId, PAUSE_RESUME_CONTINUE_MESSAGE, closeStdin);
        })
        .catch((err) => {
          logError(this.db, "daemon_resume_spawn", { runtimeId: snapshot.runtimeId, templateAgentId: snapshot.templateAgentId }, err);
        });
    }

    this.reconciliationLoop.resume();
  }
}
