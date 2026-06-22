import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { AgentManager } from "./manager";
import { PromptBuilder } from "./prompt-builder";
import { TaskScheduler } from "../tasks/scheduler";
import { TeamManager } from "../teams/manager";
import { StateTracker } from "./state-tracker";
import { EscalationManager } from "../escalations/manager";
import { ConversationManager } from "../conversations/manager";
import { HookManager } from "../hooks/manager";
import { eventBus } from "../events/bus";
import type { AgentExitEvent, AgentSignalEvent } from "../events/bus";
import { logError } from "../logging";
import { agentTypeUsesInlinePrompt, getAgentTypeDefinition } from "./types";

import { ReconciliationLoop } from "../orchestrator/tick-loop";
import { TaskRunner } from "../orchestrator/task-runner";
import { PhaseManager } from "../orchestrator/phase-manager";
import { DelegationManager } from "../orchestrator/delegation-manager";
import type { Delegation } from "../orchestrator/delegation-manager";
import { RecoveryManager } from "../orchestrator/recovery-manager";
import { IdlePokeManager } from "../orchestrator/idle-poke-manager";
import { HealthMonitor } from "../orchestrator/health-monitor";
import { ArtifactManager } from "../orchestrator/artifact-manager";
import { WorktreeManager } from "../orchestrator/worktree-manager";
import { ConsensusManager } from "../orchestrator/consensus-manager";
import { RealtimeSessionManager } from "../orchestrator/realtime-session";
import type { OrchestrationState, PausedAgentSnapshot, TaskCheckpoint } from "../orchestrator/types";
import type { Escalation } from "../escalations/manager";
import { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";


export type { Delegation };
export type { OrchestrationState, TaskCheckpoint };

const STREAMS_DRAIN_TIMEOUT_MS = 5_000;
const PROMPT_TOO_LONG_PATTERN = /prompt.*(too long|too large)|context.*(too long|exceeded|overflow)|token.*limit.*exceeded/i;
const INTERRUPTED_EXIT_PATTERN = /(interrupted|sigint|sigterm|terminated by signal|killed by signal)/i;
const MAX_PROMPT_TOO_LONG_RETRIES = 1;
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

export interface RuntimeSteeringOption {
  id: string;
  status: string;
  task_id: string;
  task_title: string | null;
  created_at: string;
  session_id: string | null;
  process_pid: number | null;
  can_steer: boolean;
  disabled_reason: string | null;
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
  private pauseInterruptedAgents: Set<string> = new Set();
  private pausedRuntimeSnapshots: PausedRuntimeSnapshot[] = [];

  // Orchestrator modules
  private reconciliationLoop: ReconciliationLoop;
  private taskRunner: TaskRunner;
  private phaseManager: PhaseManager;
  private delegationManager: DelegationManager;
  private recoveryManager: RecoveryManager;
  private idlePokeManager: IdlePokeManager;
  private healthMonitor: HealthMonitor;
  private teamManager: TeamManager;
  private artifactManager: ArtifactManager;
  private worktreeManager: WorktreeManager;
  private consensusManager: ConsensusManager;
  private realtimeSessionManager: RealtimeSessionManager;
  private conversationManager: ConversationManager;
  private hookManager: HookManager;
  private scheduledTaskScheduler: ScheduledTaskScheduler;

  constructor(db?: Database) {
    this.db = db ?? getDb();
    this.agentManager = new AgentManager(this.db);
    this.taskScheduler = new TaskScheduler(this.db);
    this.teamManager = new TeamManager(this.db);
    const teamManager = this.teamManager;
    this.stateTracker = new StateTracker(this.db, this.agentManager);
    this.artifactManager = new ArtifactManager(this.db);
    const promptBuilder = new PromptBuilder(this.db, this.artifactManager);
    this.realtimeSessionManager = new RealtimeSessionManager(this.db, this.artifactManager, this.agentManager, this.taskScheduler);

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
      setAgentState,
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
      (taskId: string) => this.idlePokeManager.clearIdle(taskId),
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

    // Create WorktreeManager and ConsensusManager
    this.worktreeManager = new WorktreeManager(this.db);
    this.consensusManager = new ConsensusManager(
      this.db,
      this.agentManager,
      promptBuilder,
      this.taskScheduler,
      this.worktreeManager,
      this.artifactManager,
      updateOrchestrationState,
      writeCheckpoint,
    );

    // Wire consensus into PhaseManager and DelegationManager
    this.phaseManager.setConsensusManager(this.consensusManager);
    this.delegationManager.setConsensusGroupCheck((groupId) => this.worktreeManager.isConsensusGroup(groupId));

    // Listen for consensus phase advance events
    eventBus.on("consensus:phase_advance", (event) => {
      const task = this.taskScheduler.getTask(event.taskId);
      if (!task || task.status !== "running") return;
      const teamExec = task.team_id ? this.teamManager.getTeamForExecution(task.team_id) : null;
      if (!teamExec) return;
      const phases = (teamExec.team.phases as { name: string; prompt: string }[]) ?? [];
      this.phaseManager.advanceAndRespawn(task, event.entrypointAgentId, phases).catch((err) => {
        logError(this.db, "consensus_phase_advance", { taskId: event.taskId }, err);
      });
    });

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
    this.taskRunner.setConsensusManager(this.consensusManager);

    // Create HealthMonitor
    this.healthMonitor = new HealthMonitor(
      this.db,
      this.agentManager,
      this.taskScheduler,
      this.stateTracker,
      (childAgentId: string) => this.delegationManager.getActiveDelegationForChild(childAgentId),
    );

    // Create EscalationManager
    this.escalationManager = new EscalationManager(this.db, this.agentManager, promptBuilder);

    this.idlePokeManager = new IdlePokeManager(
      this.db,
      this.agentManager,
      this.taskScheduler,
      this.teamManager,
      this.escalationManager,
      (parentRuntimeId: string) => this.delegationManager.getActiveDelegationForParent(parentRuntimeId),
      promptBuilder,
    );

    this.scheduledTaskScheduler = new ScheduledTaskScheduler(this.db);

    // Create ReconciliationLoop (orchestrates all modules)
    this.reconciliationLoop = new ReconciliationLoop(
      this.db,
      this.agentManager,
      this.taskRunner,
      this.recoveryManager,
      this.delegationManager,
      this.healthMonitor,
      this.worktreeManager,
      this.escalationManager,
      () => this.processScheduledTasks(),
      this.idlePokeManager,
    );

    this.conversationManager = new ConversationManager(this.db, this.agentManager);
    this.hookManager = new HookManager(this.db);

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

  getIdlePokeManager(): IdlePokeManager {
    return this.idlePokeManager;
  }

  getHealthMonitor(): HealthMonitor {
    return this.healthMonitor;
  }

  getEscalationManager(): EscalationManager {
    return this.escalationManager;
  }

  getArtifactManager(): ArtifactManager {
    return this.artifactManager;
  }

  getRealtimeSessionManager(): RealtimeSessionManager {
    return this.realtimeSessionManager;
  }

  getConsensusManager(): ConsensusManager {
    return this.consensusManager;
  }

  getConversationManager(): ConversationManager {
    return this.conversationManager;
  }

  listRuntimeSteeringOptions(templateAgentId: string): RuntimeSteeringOption[] {
    const templateAgent = this.agentManager.getAgent(templateAgentId);
    if (!templateAgent) return [];

    const typeDef = getAgentTypeDefinition(templateAgent.type, this.db);
    const supportsResume = !!typeDef?.supports_resume;
    const rows = this.db.prepare(
      `SELECT ai.id, ai.status, ai.task_id, t.title AS task_title, ai.created_at, ai.process_pid
       FROM agent_instances ai
       LEFT JOIN tasks t ON t.id = ai.task_id
       WHERE ai.template_agent_id = ?
         AND ai.status IN ('running', 'waiting_delegation', 'pending')
       ORDER BY ai.created_at DESC`,
    ).all(templateAgentId) as Array<{
      id: string;
      status: string;
      task_id: string;
      task_title: string | null;
      created_at: string;
      process_pid: number | null;
    }>;

    return rows.map((row) => {
      const runningRuntime = this.agentManager.getRunningAgent(row.id);
      const sessionId = this.agentManager.getSessionId(row.id);

      let disabledReason: string | null = null;
      if (!supportsResume) {
        disabledReason = "Agent type does not support resume.";
      } else if (row.status !== "running") {
        disabledReason = row.status === "waiting_delegation"
          ? "Runtime is waiting on delegation and cannot be steered."
          : "Runtime is not currently running.";
      } else if (!runningRuntime || !row.process_pid) {
        disabledReason = "Runtime is no longer live.";
      } else if (!sessionId) {
        disabledReason = "Runtime has no resumable session yet.";
      }

      return {
        id: row.id,
        status: row.status,
        task_id: row.task_id,
        task_title: row.task_title,
        created_at: row.created_at,
        session_id: sessionId,
        process_pid: row.process_pid,
        can_steer: disabledReason == null,
        disabled_reason: disabledReason,
      };
    });
  }

  async steerRuntime(templateAgentId: string, runtimeId: string, message: string): Promise<void> {
    const normalized = message.trim();
    if (!normalized) {
      throw new Error("message is required");
    }

    const templateAgent = this.agentManager.getAgent(templateAgentId);
    if (!templateAgent) {
      throw new Error("Agent not found");
    }

    const steeringOptions = this.listRuntimeSteeringOptions(templateAgentId);
    const runtime = steeringOptions.find((option) => option.id === runtimeId);
    if (!runtime) {
      throw new Error("Runtime does not belong to agent");
    }
    if (!runtime.can_steer) {
      throw new Error(runtime.disabled_reason ?? "Runtime is not steerable");
    }

    const wrappedMessage = `[SYSTEM] Operator steering message from Skipper. Your previous run was interrupted. Continue the same task with this updated guidance:\n\n${normalized}`;
    const closeStdin = this.shouldCloseStdinForAgent(runtimeId);
    await this.agentManager.sendResumeMessage(runtimeId, wrappedMessage, closeStdin);

    try {
      this.agentManager.appendSyntheticOutput(
        runtimeId,
        `[SKIPPER] Operator steer injected for runtime ${runtimeId}: ${normalized}`,
      );
    } catch (err) {
      logError(this.db, "steering.synthetic_output", { templateAgentId, runtimeId }, err);
    }
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
    // Restore active conversations from previous server session
    this.conversationManager.restoreConversations().catch((err) => {
      logError(this.db, "conversation.restore_all", {}, err);
    });
    return this.reconciliationLoop.start();
  }

  stop(): void {
    this.reconciliationLoop.stop();
    this.realtimeSessionManager.dispose();
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

  handlePhaseComplete(agentId: string): Promise<import("../orchestrator/phase-manager").PhaseCompleteOutcome> {
    return this.phaseManager.handlePhaseComplete(agentId);
  }

  handlePhaseRegression(agentId: string, targetPhaseOneIndexed: number, reason: string): void {
    this.phaseManager.handlePhaseRegression(agentId, targetPhaseOneIndexed, reason);
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

  async resolveEscalation(escalationId: string, response: string): Promise<void> {
    const escalation = this.escalationManager.getEscalation(escalationId);
    if (!escalation) {
      throw new Error(`Escalation not found: ${escalationId}`);
    }
    await this.escalationManager.resolveEscalation(escalationId, response);
    if (!this.hasOpenEscalations(escalation.task_id)) {
      this.resumeTaskFromEscalationWait(escalation.task_id);
    }
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
    // Route conversation-agent signals separately; skip task orchestration signals for them
    if (this.conversationManager.isConversationAgent(event.agentId)) {
      this.handleConversationSignal(event).catch((err) => {
        logError(this.db, "conversation_signal_handler", { agentId: event.agentId, signalType: event.signalType }, err);
      });
      return;
    }

    // Track signal activity for stuck-agent detection.
    // Use the template agent ID so the state row is always on the canonical agent.
    const templateAgentId = this.agentManager.getTemplateAgentId(event.agentId) ?? event.agentId;
    this.stateTracker.updateLastSignalAt(templateAgentId);

    // Skipper signalled activity — clear any pending idle-poke for this task.
    // Only the root entrypoint instance matters; delegated children don't reset the idle gate.
    try {
      const inst = this.db
        .prepare("SELECT task_id, parent_instance_id FROM agent_instances WHERE id = ?")
        .get(event.agentId) as { task_id: string; parent_instance_id: string | null } | null;
      if (inst && inst.parent_instance_id === null && inst.task_id) {
        this.idlePokeManager.clearIdle(inst.task_id);
      }
    } catch (err) {
      logError(this.db, "idle_poke_clear_on_signal", { agentId: event.agentId }, err);
    }

    switch (event.signalType) {
      case "delegate_complete":
        if (event.content) {
          this.delegationManager.handleDelegateComplete(event.agentId, event.content);
        }
        break;

      default:
        break;
    }
  }

  private async handleConversationSignal(event: AgentSignalEvent): Promise<void> {
    const conversationId = this.conversationManager.isConversationAgent(event.agentId);
    if (!conversationId) return;

    const runtimeId = event.agentId;

    const injectResult = async (result: string): Promise<void> => {
      const closeStdin = this.shouldCloseStdinForAgent(runtimeId);
      try {
        await this.agentManager.sendResumeMessage(runtimeId, `[SYSTEM] Command result:\n\n${result}`, closeStdin);
      } catch (err) {
        logError(this.db, "conversation_signal_inject", { conversationId, signalType: event.signalType }, err);
      }
    };

    switch (event.signalType) {
      case "conversation_query_tasks": {
        const tasks = this.db
          .prepare(
            `SELECT id, title, status, current_phase, team_id, created_at, updated_at
             FROM tasks
             WHERE task_type != 'real_time'
             ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'approved' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, updated_at DESC
             LIMIT 20`,
          )
          .all() as { id: string; title: string; status: string; current_phase: number; team_id: string | null; created_at: string }[];
        const lines = tasks.map((t) => `- [${t.id}] ${t.title} | status: ${t.status} | phase: ${t.current_phase}`);
        await injectResult(lines.length > 0 ? lines.join("\n") : "No tasks found.");
        break;
      }

      case "conversation_query_task": {
        if (!event.content) break;
        const match = event.content.match(/\[QUERY_TASK\s+id:(\S+)\]/);
        if (!match) break;
        const taskId = match[1]!;
        const task = this.taskScheduler.getTask(taskId);
        if (!task) {
          await injectResult(`Task not found: ${taskId}`);
          break;
        }
        const notes = this.db
          .prepare("SELECT content, agent_id, created_at FROM task_notes WHERE task_id = ? ORDER BY created_at DESC LIMIT 5")
          .all(taskId) as { content: string; agent_id: string; created_at: string }[];
        const noteLines = notes.map((n) => `  - [${n.agent_id}] ${n.content.slice(0, 200)}`).join("\n");
        const result = [
          `Task: ${task.title} (${task.id})`,
          `Status: ${task.status}`,
          `Phase: ${task.current_phase}`,
          `Description: ${task.description ?? "(none)"}`,
          notes.length > 0 ? `Recent notes:\n${noteLines}` : "Notes: none",
        ].join("\n");
        await injectResult(result);
        break;
      }

      case "conversation_create_task": {
        if (!event.content) break;
        const match = event.content.match(/\[CREATE_TASK\s+title:(.+?)\s+team:(\S+)(?:\s+description:(.+))?\]/);
        if (!match) break;
        const title = match[1]!;
        const teamId = match[2]!;
        const description = match[3];
        try {
          const task = this.taskScheduler.createTask({
            title: title.trim(),
            description: description?.trim() || undefined,
            teamId: teamId.trim(),
            workingDirectory: process.cwd(),
          });
          await injectResult(`Task created: [${task.id}] ${task.title} | status: draft`);
        } catch (err) {
          await injectResult(`Failed to create task: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case "conversation_task_status": {
        if (!event.content) break;
        const match = event.content.match(/\[TASK_STATUS\s+task:(\S+)\s+status:(\S+)\]/);
        if (!match) break;
        const taskId = match[1]!;
        const newStatus = match[2]!;
        try {
          const validStatuses = ["draft", "approved", "completed", "failed"];
          if (!validStatuses.includes(newStatus)) {
            await injectResult(`Invalid status '${newStatus}'. Valid: ${validStatuses.join(", ")}`);
            break;
          }
          if (newStatus === "approved") this.taskScheduler.approveTask(taskId);
          else if (newStatus === "completed") this.taskScheduler.completeTask(taskId);
          else if (newStatus === "failed") this.taskScheduler.failTask(taskId, "Set via conversation Skipper");
          else {
            this.db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, taskId);
          }
          await injectResult(`Task ${taskId} status updated to: ${newStatus}`);
        } catch (err) {
          await injectResult(`Failed to update task status: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case "conversation_steer": {
        if (!event.content) break;
        const match = event.content.match(/\[STEER\s+agent:(\S+)\s+message:(.+)\]/);
        if (!match) break;
        const targetRuntimeId = match[1]!;
        const steerMessage = match[2]!;
        // Find the template agent for this runtime
        const templateId = this.agentManager.getTemplateAgentId(targetRuntimeId);
        if (!templateId) {
          await injectResult(`Agent runtime not found: ${targetRuntimeId}`);
          break;
        }
        try {
          await this.steerRuntime(templateId, targetRuntimeId, steerMessage.trim());
          await injectResult(`Steering message sent to agent ${targetRuntimeId}.`);
        } catch (err) {
          await injectResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case "conversation_task_note": {
        if (!event.content) break;
        const match = event.content.match(/\[TASK_NOTE\s+task:(\S+)\s+content:(.+)\]/);
        if (!match) break;
        const taskId = match[1]!;
        const noteContent = match[2]!;
        const task = this.taskScheduler.getTask(taskId);
        if (!task) {
          await injectResult(`Task not found: ${taskId}`);
          break;
        }
        try {
          const noteId = crypto.randomUUID();
          // Find entrypoint agent for FK constraint
          let agentId = "user";
          if (task.team_id) {
            const teamRow = this.db.prepare("SELECT entrypoint_agent_id FROM teams WHERE id = ?").get(task.team_id) as { entrypoint_agent_id: string | null } | null;
            if (teamRow?.entrypoint_agent_id) agentId = teamRow.entrypoint_agent_id;
          }
          this.db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content, source) VALUES (?, ?, ?, ?, 'user')").run(noteId, taskId, agentId, noteContent.trim());
          eventBus.emit("task:note_added", { noteId, taskId, agentId, content: noteContent.trim() });
          await injectResult(`Note added to task ${taskId}.`);
        } catch (err) {
          await injectResult(`Failed to add note: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      default:
        // Non-conversation signals from conversation agents are silently ignored
        break;
    }
  }

  private shouldCloseStdinForAgent(agentId: string): boolean {
    const templateAgentId = this.agentManager.getTemplateAgentId(agentId) ?? agentId;
    const agent = this.agentManager.getAgent(templateAgentId);
    if (!agent) return true;
    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    return !(typeDef?.supports_stdin ?? false);
  }

  private resolveTaskIdForAgent(agentId: string): string | null {
    // Try agent_instances first — per-spawn, per-task truth (supports parallel tasks)
    const instanceRow = this.db
      .prepare("SELECT task_id FROM agent_instances WHERE id = ?")
      .get(agentId) as { task_id: string } | null;
    if (instanceRow?.task_id) return instanceRow.task_id;

    // Fall back to agents table (template agents, backwards compat)
    const agentRow = this.db
      .prepare("SELECT current_task_id FROM agents WHERE id = ?")
      .get(agentId) as { current_task_id: string | null } | null;
    return agentRow?.current_task_id ?? null;
  }

  private resumeTaskFromEscalationWait(taskId: string): void {
    const task = this.taskScheduler.getTask(taskId);
    if (!task || task.status !== "running") return;

    const previous = this.recoveryManager.getOrchestrationState(taskId);
    this.recoveryManager.updateOrchestrationState(taskId, {
      step: "AGENT_RUNNING",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: previous?.session_id ?? null,
      active_delegation_group_id: null,
      active_delegation_child_count: 0,
      active_delegation_settled_count: 0,
      phase_guards: previous?.phase_guards ?? [],
      pending_regression: previous?.pending_regression ?? null,
      checkpoint_prompt_hash: previous?.checkpoint_prompt_hash ?? null,
    });
    this.recoveryManager.writeCheckpoint(taskId, "ESCALATION_RESOLVED");
  }

  private hasOpenEscalations(taskId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM escalations WHERE task_id = ? AND status = 'open' LIMIT 1")
      .get(taskId);
    return !!row;
  }

  /**
   * Returns true when the task is backed by a single_instance scheduled task.
   * Used by handleAgentExit to short-circuit the standard
   * complete/fail/markIdle path — single_instance tasks stay running forever
   * and are re-fired by the scheduler at the configured interval.
   */
  private isSingleInstanceTask(taskId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT st.single_instance AS si
         FROM tasks t
         JOIN scheduled_tasks st ON st.id = t.source_scheduled_task_id
         WHERE t.id = ?`,
      )
      .get(taskId) as { si: number } | null;
    return !!(row && Number(row.si) === 1);
  }

  private async processScheduledTasks(): Promise<void> {
    try {
      const dueTasks = this.scheduledTaskScheduler.getDueScheduledTasks();
      for (const scheduled of dueTasks) {
        try {
          if (scheduled.single_instance) {
            await this.fireSingleInstanceScheduledTask(scheduled);
          } else {
            this.fireStandardScheduledTask(scheduled);
          }
        } catch (err) {
          logError(this.db, "scheduled_task_fire", { scheduledId: scheduled.id, single_instance: scheduled.single_instance, method: "processScheduledTasks" }, err);
        }
      }
    } catch (err) {
      logError(this.db, "scheduled_task_processing", { method: "processScheduledTasks" }, err);
    }
  }

  /** Standard scheduled task fire — create a new task per fire, queued for TaskRunner. */
  private fireStandardScheduledTask(scheduled: import("../tasks/scheduled-scheduler").ScheduledTask): void {
    const queuedCount = (this.db
      .prepare(
        "SELECT COUNT(*) as c FROM tasks WHERE source_scheduled_task_id = ? AND status = 'approved'",
      )
      .get(scheduled.id) as { c: number }).c;
    if (queuedCount > 0) return;

    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const baseDesc = scheduled.description ?? undefined;
    let finalDesc = baseDesc;
    const tplId = (scheduled.task_config as Record<string, unknown>)?.template_id;
    if (typeof tplId === "string" && tplId) {
      const { getTemplateSkipperPrompt } = require("../templates/helpers");
      const sp = getTemplateSkipperPrompt(this.db, tplId);
      if (sp) finalDesc = baseDesc ? `${baseDesc}\n\n${sp}` : sp;
    }
    const task = this.taskScheduler.createTask({
      title: `${scheduled.title} (${timestamp})`,
      description: finalDesc,
      teamId: scheduled.team_id ?? undefined,
      workingDirectory: scheduled.working_directory,
      taskConfig: scheduled.task_config as import("../tasks/scheduler").RealtimeTaskConfig,
    });

    this.db
      .prepare("UPDATE tasks SET source_scheduled_task_id = ? WHERE id = ?")
      .run(scheduled.id, task.id);

    this.taskScheduler.approveTask(task.id);
    this.scheduledTaskScheduler.recordRun(scheduled.id);
  }

  /**
   * Single-instance scheduled task fire. Uses ONE persistent backing tasks
   * row per scheduled task; each fire respawns the entrypoint Skipper against
   * that same task with --resume <sessionId>, prepending a context-compaction
   * instruction when handleAgentExit has flagged pending_compact=1.
   *
   * First fire: defers to the standard path (createTask → approveTask →
   * TaskRunner spawn) so the initial Skipper + session exist. The new
   * handleAgentExit short-circuit then keeps the task running forever.
   * Subsequent fires: skip task creation entirely, just respawn Skipper.
   */
  private async fireSingleInstanceScheduledTask(scheduled: import("../tasks/scheduled-scheduler").ScheduledTask): Promise<void> {
    const existing = this.db
      .prepare("SELECT id, status FROM tasks WHERE source_scheduled_task_id = ? ORDER BY created_at LIMIT 1")
      .get(scheduled.id) as { id: string; status: string } | null;

    if (!existing) {
      // First fire — create the backing task via the standard flow so
      // TaskRunner spawns the initial entrypoint Skipper + session.
      this.fireStandardScheduledTask(scheduled);
      return;
    }

    if (existing.status === "failed") {
      // Don't auto-fire a failed single_instance task; let the operator
      // investigate. We also don't recordRun so the timer doesn't advance.
      logError(this.db, "single_instance_failed_backing_task", { scheduledId: scheduled.id, taskId: existing.id, method: "fireSingleInstanceScheduledTask" }, new Error("backing task is failed"));
      return;
    }

    const teamExec = scheduled.team_id ? this.teamManager.getTeamForExecution(scheduled.team_id) : null;
    if (!teamExec) {
      logError(this.db, "single_instance_no_team", { scheduledId: scheduled.id, taskId: existing.id, method: "fireSingleInstanceScheduledTask" }, new Error("team missing or invalid"));
      return;
    }
    const entrypointAgentId = teamExec.entrypoint_agent_id;

    // Don't double-fire: if Skipper is mid-fire from the previous slot, just
    // advance next_run_at so we don't queue up forever, and bail.
    const running = this.db
      .prepare(
        "SELECT id FROM agent_instances WHERE task_id = ? AND template_agent_id = ? AND status = 'running' AND process_pid IS NOT NULL LIMIT 1",
      )
      .get(existing.id, entrypointAgentId) as { id: string } | null;
    if (running) {
      this.scheduledTaskScheduler.recordRun(scheduled.id);
      return;
    }

    const pendingCompact = (this.db
      .prepare("SELECT pending_compact FROM tasks WHERE id = ?")
      .get(existing.id) as { pending_compact: number } | null)?.pending_compact ?? 0;

    const fireTs = new Date().toISOString();
    const descBody = scheduled.description?.trim() || scheduled.title;
    let prompt = `[SCHEDULED_FIRE @ ${fireTs}]\n\n${descBody}\n\nThis is a recurring single-instance scheduled task. When you've completed this fire's work, end your turn naturally — do NOT call complete_phase or complete_task. The task stays running and the next fire (at the configured interval) will resume from this point.`;
    if (pendingCompact) {
      prompt = `[SYSTEM: CONTEXT_COMPACTION] Before doing anything else this fire, summarize the prior conversation into a short context block (key decisions, recent findings, open items) and acknowledge the discard of verbose history. THEN proceed with the new fire instruction below.\n\n${prompt}`;
    }

    const agent = this.agentManager.getAgent(entrypointAgentId);
    if (!agent) return;
    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    if (!typeDef) return;
    const sessionId = this.agentManager.getEntrypointSessionIdForTask(existing.id, entrypointAgentId);
    const canResume = (typeDef.supports_resume ?? false) && !!sessionId;
    const usesInlinePrompt = agentTypeUsesInlinePrompt(typeDef, canResume ? sessionId : null);
    const isStreaming = typeDef.supports_stdin ?? false;

    try {
      const workingDir = scheduled.working_directory || process.cwd();
      const spawnOpts = canResume
        ? { workingDir, taskId: existing.id, sessionId: sessionId!, initialPrompt: usesInlinePrompt ? prompt : undefined }
        : { workingDir, taskId: existing.id, initialPrompt: usesInlinePrompt ? prompt : undefined };
      await this.agentManager.spawnAgent(entrypointAgentId, spawnOpts);
    } catch (err) {
      logError(this.db, "single_instance_spawn", { scheduledId: scheduled.id, taskId: existing.id, method: "fireSingleInstanceScheduledTask" }, err);
      return;
    }

    this.db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(existing.id, entrypointAgentId);

    if (!usesInlinePrompt) {
      const closeStdin = !isStreaming;
      try {
        this.agentManager.sendInput(entrypointAgentId, prompt, closeStdin);
      } catch (err) {
        logError(this.db, "single_instance_send_input", { scheduledId: scheduled.id, taskId: existing.id, method: "fireSingleInstanceScheduledTask" }, err);
        return;
      }
    }

    // Prompt successfully dispatched — clear the compact flag so we don't
    // re-issue the compaction instruction on the next fire.
    if (pendingCompact) {
      this.db.prepare("UPDATE tasks SET pending_compact = 0, updated_at = datetime('now') WHERE id = ?").run(existing.id);
    }

    this.scheduledTaskScheduler.recordRun(scheduled.id);
  }

  getScheduledTaskScheduler(): ScheduledTaskScheduler {
    return this.scheduledTaskScheduler;
  }

  private registerTaskStateHandler(): void {
    this.taskStateHandler = (event: import("../events/bus").TaskStateChangedEvent) => {
      // Iterate/retry/resume — task is going from a terminal state back into the
      // active pipeline. Drop the in-memory phase-completion dedup so the new
      // run's first complete_phase call isn't swallowed by a stale guard.
      const fromTerminal = event.previousStatus === "completed" || event.previousStatus === "failed";
      const toActive = event.newStatus === "approved" || event.newStatus === "draft";
      if (fromTerminal && toActive) {
        this.phaseManager.clearTaskState(event.taskId);
      }

      if (event.newStatus === "approved") {
        this.taskRunner.processTaskQueue().catch((err) => {
          logError(this.db, "reactive_task_dispatch", { taskId: event.taskId }, err);
        });
      }

      if (event.newStatus === "completed" || event.newStatus === "failed") {
        // Close any active realtime session for this task (without finalization on cancel/fail)
        try {
          if (this.realtimeSessionManager.isSessionActive(event.taskId)) {
            this.realtimeSessionManager.closeSession(event.taskId);
          }
        } catch (err) {
          logError(this.db, "realtime_session_cleanup", { taskId: event.taskId, newStatus: event.newStatus }, err);
        }
        try {
          this.recoveryManager.cleanupTerminalTaskState(event.taskId);
        } catch (err) {
          logError(this.db, "terminal_task_cleanup_handler", { taskId: event.taskId, newStatus: event.newStatus }, err);
        }
        if (event.newStatus === "completed") {
          this.taskRunner.processTaskQueue().catch((err) => {
            logError(this.db, "reactive_task_dispatch_after_terminal", { taskId: event.taskId }, err);
          });
        }
      }
    };
    eventBus.on("task:state_changed", this.taskStateHandler);
  }

  destroy(): void {
    this.realtimeSessionManager.dispose();
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
    this.hookManager.destroy();
    this.exitHandlerRegistered = false;
    this.signalHandlerRegistered = false;
  }

  private async handleAgentExit(event: AgentExitEvent): Promise<void> {
    if (event.isRespawn) {
      logError(this.db, "agent_exit_bail", { agentId: event.agentId, reason: "isRespawn", method: "handleAgentExit" }, new Error("bail"));
      return;
    }
    if (event.hasDelegation) {
      logError(this.db, "agent_exit_bail", { agentId: event.agentId, reason: "hasDelegation", method: "handleAgentExit" }, new Error("bail"));
      return;
    }
    if (this.pauseInterruptedAgents.has(event.agentId)) {
      logError(this.db, "agent_exit_bail", { agentId: event.agentId, reason: "pause_interrupted", method: "handleAgentExit" }, new Error("bail"));
      this.pauseInterruptedAgents.delete(event.agentId);
      return;
    }

    try {
      // Consensus agent exit — handled by ConsensusManager
      if (this.consensusManager.isConsensusInstance(event.agentId)) {
        const handled = await this.consensusManager.handleConsensusAgentExit(event.agentId, event.code);
        if (handled) return;
      }

      // Consensus reviewer exit
      if (this.consensusManager.isReviewerInstance(event.agentId)) {
        const handled = await this.consensusManager.handleReviewerExit(event.agentId, event.code);
        if (handled) return;
      }

      // Resolve runtime ID → task via agent_instances (supports parallel tasks).
      // Done early because the open-escalation gate below also needs the taskId.
      const taskId = this.resolveTaskIdForAgent(event.agentId);

      // If any escalation is open on this task, halt the exit pipeline before
      // it routes a delegation result back to Skipper. The previous version
      // checked escalations AFTER the delegation branch — a child that
      // escalated and then exited would still wake Skipper via
      // routeResultToParent. The task must hang until the operator resolves
      // the escalation, at which point injectResponse resumes the escalating
      // runtime (not Skipper).
      if (taskId && this.hasOpenEscalations(taskId)) {
        this.db
          .prepare(
            "UPDATE agent_instances SET status = 'stopped', process_pid = NULL, updated_at = datetime('now') WHERE id = ?",
          )
          .run(event.agentId);
        logError(this.db, "agent_exit_bail", { agentId: event.agentId, taskId, reason: "open_escalation", method: "handleAgentExit" }, new Error("bail"));
        return;
      }

      const activeDelegation = this.delegationManager.getActiveDelegationForChild(event.agentId);
      if (activeDelegation) {
        this.delegationManager.handleChildExit(activeDelegation, event);
        return;
      }

      if (!taskId) {
        const templateId = this.agentManager.getTemplateAgentId(event.agentId) ?? event.agentId;
        logError(this.db, "agent_exit_bail", { agentId: event.agentId, templateId, reason: "no_task_id", method: "handleAgentExit" }, new Error("bail"));
        return;
      }
      const task = this.taskScheduler.getTask(taskId);
      if (!task || task.status !== "running") {
        logError(this.db, "agent_exit_bail", { agentId: event.agentId, taskId, reason: !task ? "task_not_found" : `task_status_${task.status}`, method: "handleAgentExit" }, new Error("bail"));
        return;
      }

      // Single-instance scheduled task short-circuit: the task is a
      // persistent shell that fires Skipper on schedule. A clean Skipper exit
      // means "this fire is done"; the task stays running, no phase
      // advancement, no idle-poke (that would compete with the scheduler),
      // no completeTask. Set pending_compact=1 so the next fire's prompt
      // prepends a context-compaction instruction. Non-zero exit codes still
      // fall through to the normal failure path so genuine crashes don't get
      // silently swallowed.
      if (event.code === 0 && this.isSingleInstanceTask(taskId)) {
        const templateId = this.agentManager.getTemplateAgentId(event.agentId) ?? event.agentId;
        this.db
          .prepare("UPDATE tasks SET pending_compact = 1, updated_at = datetime('now') WHERE id = ?")
          .run(taskId);
        this.db
          .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
          .run(templateId);
        this.db
          .prepare("UPDATE agent_instances SET status = 'completed', updated_at = datetime('now') WHERE id = ?")
          .run(event.agentId);
        return;
      }

      // Template ID resolution — used by the real-time cleanup and the
      // post-exit current_task_id reset below. Falls back to the runtime
      // id for legacy non-instance agents.
      const templateId = this.agentManager.getTemplateAgentId(event.agentId) ?? event.agentId;

      // Real-time tasks are never completed or failed by agent exit — they run
      // continuously until the user explicitly archives them. Clean up the agent
      // instance but leave the task running.
      if ((task as Record<string, unknown>).task_type === "real_time") {
        this.db
          .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
          .run(templateId);
        this.db
          .prepare(
            "UPDATE agent_instances SET status = ?, updated_at = datetime('now') WHERE id = ?",
          )
          .run(event.code === 0 ? "completed" : "failed", event.agentId);
        return;
      }

      // Don't complete/advance if this agent has an active delegation as parent
      const parentDelegation = this.delegationManager.getActiveDelegationForParent(event.agentId);
      if (parentDelegation) {
        logError(this.db, "agent_exit_bail", { agentId: event.agentId, taskId, reason: "active_parent_delegation", delegationId: (parentDelegation as { id?: string }).id ?? null, method: "handleAgentExit" }, new Error("bail"));
        // Parent exited while delegation is in progress — wait for child to finish
        return;
      }

      // Only track actionable failures for cluster incidents.
      // Respawns/delegations are filtered above; interrupted exits (130/143) are expected in
      // pause/resume and resume-capable workflows and should not trigger incident escalations.
      if (event.code !== 0 && !this.isInterruptedExit(event.code, event.stderrSnippet ?? "")) {
        this.healthMonitor.trackExitCode(event.agentId, event.code);
      }

      const respawned = false;
      if (event.code === 0) {
        const agent = this.agentManager.getAgent(templateId);
        const typeDef = agent ? getAgentTypeDefinition(agent.type, this.db) : null;
        const isStreaming = typeDef?.supports_stdin ?? false;
        if (!isStreaming && !this.hasCompletedTurnOutput(event.agentId)) {
          logError(this.db, "agent_exit_bail", { agentId: event.agentId, taskId, reason: "no_completed_turn_output", method: "handleAgentExit" }, new Error("bail"));
          try {
            this.taskScheduler.failTask(taskId, "Agent exited without completed turn output (missing result/turn.completed/step_finish)");
          } catch (err) {
            logError(this.db, "agent_exit_no_turn_output_fail_task", { agentId: event.agentId, taskId }, err);
          }
        } else {
          // Phase advancement is Skipper-explicit only. A clean exit with no
          // outstanding delegation / escalation simply means Skipper's turn
          // ended. Mark the task idle; the tick-loop poke will nudge Skipper
          // for a decision after IDLE_POKE_DELAY_MS.
          this.idlePokeManager.markIdle(taskId);
        }
      } else if (this.isPromptTooLongError(event.stderrSnippet)) {
        this.handlePromptTooLong(event.agentId, taskId, task).catch((err) => {
          logError(this.db, "prompt_too_long_recovery", { agentId: event.agentId, taskId, method: "handleAgentExit" }, err);
          try {
            this.taskScheduler.failTask(taskId, `Prompt too long recovery failed: ${err instanceof Error ? err.message : String(err)}`);
          } catch (innerErr) {
            logError(this.db, "prompt_too_long_fail_task", { taskId, method: "handleAgentExit" }, innerErr);
          }
        });
      } else if (this.isInterruptedExit(event.code, event.stderrSnippet ?? "")) {
        logError(this.db, "agent_exit_bail", { agentId: event.agentId, taskId, reason: "interrupted_exit", exitCode: event.code, method: "handleAgentExit" }, new Error("bail"));
        this.recoveryManager.writeCheckpoint(taskId, "AGENT_INTERRUPTED", {
          agent_id: event.agentId,
          exit_code: event.code,
        });
        return;
      } else {
        try {
          this.taskScheduler.failTask(taskId, `Agent exited with code ${event.code}`);
        } catch (err) {
          logError(this.db, "agent_exit_fail_task", { agentId: event.agentId, taskId: taskId, exitCode: event.code }, err);
        }
      }

      if (!respawned) {
        this.db
          .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
          .run(templateId);
        this.db
          .prepare(
            "UPDATE agent_instances SET status = ?, updated_at = datetime('now') WHERE id = ?",
          )
          .run(event.code === 0 ? "completed" : "failed", event.agentId);
      }
    } catch (err) {
      logError(this.db, "agent_exit_handler", { agentId: event.agentId, method: "handleAgentExit" }, err);
    }
  }

  private hasCompletedTurnOutput(agentId: string): boolean {
    try {
      const row = this.db
        .prepare("SELECT created_at, updated_at FROM agent_instances WHERE id = ?")
        .get(agentId) as { created_at: string; updated_at: string } | null;
      if (!row) return false;

      const completion = this.db
        .prepare(
          `SELECT 1
           FROM terminal_outputs
           WHERE agent_id = ?
             AND stream = 'stdout'
             AND created_at >= ?
             AND created_at <= datetime(?, '+60 seconds')
             AND json_valid(data)
             AND json_extract(data, '$.type') IN ('result', 'turn.completed', 'step_finish')
           LIMIT 1`,
        )
        .get(agentId, row.created_at, row.updated_at) as { 1: number } | null;
      return !!completion;
    } catch (err) {
      logError(this.db, "agent_exit_completion_check", { agentId, method: "hasCompletedTurnOutput" }, err);
      return false;
    }
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
          initialPrompt: agentTypeUsesInlinePrompt(typeDef, snapshot.sessionId) ? PAUSE_RESUME_CONTINUE_MESSAGE : undefined,
        })
        : this.agentManager.spawnAgentInstance(snapshot.templateAgentId, snapshot.runtimeId, {
          workingDir: process.cwd(),
          sessionId: snapshot.sessionId ?? undefined,
          taskId: snapshot.taskId,
          parentInstanceId: snapshot.parentInstanceId,
          rootInstanceId: snapshot.rootInstanceId,
          initialPrompt: agentTypeUsesInlinePrompt(typeDef, snapshot.sessionId) ? PAUSE_RESUME_CONTINUE_MESSAGE : undefined,
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
          if (!agentTypeUsesInlinePrompt(typeDef, snapshot.sessionId)) {
            this.agentManager.sendInput(snapshot.runtimeId, PAUSE_RESUME_CONTINUE_MESSAGE, closeStdin);
          }
        })
        .catch((err) => {
          logError(this.db, "daemon_resume_spawn", { runtimeId: snapshot.runtimeId, templateAgentId: snapshot.templateAgentId }, err);
        });
    }

    this.reconciliationLoop.resume();
  }

  // --- Per-task pause / resume (scoped variant of pauseDaemonAndAgents) ---
  //
  // Stop ALL of one task's agents and their subprocess trees at a point in time,
  // persisting enough state (session ids + snapshots in orchestration_state) to
  // respawn with --resume later — even across a server restart. Mirrors the
  // global daemon pause but does NOT pause the reconciliation loop (other tasks
  // keep running) and writes snapshots to the DB instead of memory.
  async pauseTaskAgents(taskId: string): Promise<PausedAgentSnapshot[]> {
    // step → PAUSING (best-effort; only if the task has orchestration state)
    const before = this.recoveryManager.getOrchestrationState(taskId);
    if (before) {
      this.recoveryManager.updateOrchestrationState(taskId, { ...before, step: "PAUSING" });
    }

    const runtimes = Array.from(this.agentManager.getRunningAgents().values())
      .filter((runtime) => runtime.taskId === taskId);

    // Snapshot only entrypoint-level runtimes (no parent) for resume; the
    // resumed root re-drives any delegation. Persist each session id BEFORE the
    // kill so it survives even if the exit handler's persist races the teardown.
    const snapshots: PausedAgentSnapshot[] = [];
    for (const runtime of runtimes) {
      if (runtime.parentInstanceId != null) continue;
      const sessionId = runtime.sessionId ?? this.agentManager.getSessionId(runtime.id);
      if (sessionId) {
        try {
          this.db
            .prepare("UPDATE agent_instances SET session_id = ?, updated_at = datetime('now') WHERE id = ?")
            .run(sessionId, runtime.id);
        } catch { /* row may not exist for template runtimes */ }
      }
      const attemptRow = this.db
        .prepare("SELECT attempt FROM agent_instances WHERE id = ?")
        .get(runtime.id) as { attempt: number } | null;
      snapshots.push({
        runtimeId: runtime.id,
        templateAgentId: runtime.templateAgentId,
        taskId,
        parentInstanceId: runtime.parentInstanceId ?? null,
        rootInstanceId: runtime.rootInstanceId ?? null,
        sessionId: sessionId ?? null,
        attempt: attemptRow?.attempt ?? 1,
        isTemplateRuntime: runtime.id === runtime.templateAgentId,
      });
    }

    // Kill the whole process tree of EVERY runtime for the task (root + any
    // delegated children). Flag each as pause-interrupted first so its natural
    // agent:exit is swallowed (handleAgentExit bails) instead of escalating or
    // completing the task.
    for (const runtime of runtimes) {
      this.pauseInterruptedAgents.add(runtime.id);
      this.agentManager.killAgentTree(runtime.id);
    }
    await Promise.all(
      runtimes.map((runtime) => this.agentManager.waitForExit(runtime.id, STREAMS_DRAIN_TIMEOUT_MS)),
    );

    // Kill any DB-tracked instance processes for the task that weren't in memory
    // (orphaned/untracked children), by their process group.
    const memPids = new Set(runtimes.map((r) => r.process.pid).filter((p): p is number => !!p));
    const orphanRows = this.db
      .prepare(
        "SELECT process_pid FROM agent_instances WHERE task_id = ? AND status IN ('running', 'waiting_delegation', 'pending') AND process_pid IS NOT NULL",
      )
      .all(taskId) as Array<{ process_pid: number }>;
    for (const row of orphanRows) {
      if (memPids.has(row.process_pid)) continue;
      try { process.kill(-row.process_pid, "SIGKILL"); }
      catch { try { process.kill(row.process_pid, "SIGKILL"); } catch { /* already dead */ } }
    }

    // Mark the task's live instances stopped (NOT failed) and clear pids so the
    // startup orphan sweep won't touch them after a restart.
    this.db
      .prepare(
        "UPDATE agent_instances SET status = 'stopped', process_pid = NULL, updated_at = datetime('now') WHERE task_id = ? AND status IN ('running', 'waiting_delegation', 'pending')",
      )
      .run(taskId);
    this.db
      .prepare("UPDATE agents SET process_pid = NULL, status = 'stopped', updated_at = datetime('now') WHERE current_task_id = ?")
      .run(taskId);

    // step → PAUSED + persist snapshots in a single orchestration_state write.
    const afterKill = this.recoveryManager.getOrchestrationState(taskId) ?? before;
    if (afterKill) {
      this.recoveryManager.updateOrchestrationState(taskId, {
        ...afterKill,
        step: "PAUSED",
        paused_snapshots: snapshots,
      });
    }

    return snapshots;
  }

  async resumeTaskAgents(taskId: string): Promise<void> {
    const state = this.recoveryManager.getOrchestrationState(taskId);
    const snapshots = state?.paused_snapshots ?? [];

    if (state) {
      this.recoveryManager.updateOrchestrationState(taskId, { ...state, step: "RECOVERING" });
    }

    const taskRow = this.db
      .prepare("SELECT working_directory FROM tasks WHERE id = ?")
      .get(taskId) as { working_directory: string } | null;
    const workingDir = taskRow?.working_directory || process.cwd();

    for (const snapshot of snapshots) {
      const templateAgent = this.agentManager.getAgent(snapshot.templateAgentId);
      const typeDef = templateAgent ? getAgentTypeDefinition(templateAgent.type, this.db) : null;
      if (!templateAgent || !typeDef) continue;

      this.pauseInterruptedAgents.delete(snapshot.runtimeId);
      const usesInline = agentTypeUsesInlinePrompt(typeDef, snapshot.sessionId);

      const spawnPromise = snapshot.isTemplateRuntime
        ? this.agentManager.spawnAgent(snapshot.templateAgentId, {
          workingDir,
          sessionId: snapshot.sessionId ?? undefined,
          initialPrompt: usesInline ? PAUSE_RESUME_CONTINUE_MESSAGE : undefined,
        })
        : this.agentManager.spawnAgentInstance(snapshot.templateAgentId, snapshot.runtimeId, {
          workingDir,
          sessionId: snapshot.sessionId ?? undefined,
          taskId: snapshot.taskId,
          parentInstanceId: snapshot.parentInstanceId,
          rootInstanceId: snapshot.rootInstanceId,
          attempt: snapshot.attempt,
          initialPrompt: usesInline ? PAUSE_RESUME_CONTINUE_MESSAGE : undefined,
        });

      await spawnPromise
        .then(() => {
          if (snapshot.isTemplateRuntime) {
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

          if (!usesInline) {
            const closeStdin = !(typeDef.supports_stdin ?? false);
            this.agentManager.sendInput(snapshot.runtimeId, PAUSE_RESUME_CONTINUE_MESSAGE, closeStdin);
          }
        })
        .catch((err) => {
          logError(this.db, "task_resume_spawn", { runtimeId: snapshot.runtimeId, templateAgentId: snapshot.templateAgentId, taskId }, err);
        });
    }

    // step → AGENT_RUNNING, drop the snapshots, and clear stale delegation
    // tracking (the open delegations were reconciled on pause; the resumed root
    // re-drives them fresh).
    const after = this.recoveryManager.getOrchestrationState(taskId);
    if (after) {
      const { paused_snapshots: _drop, ...rest } = after;
      this.recoveryManager.updateOrchestrationState(taskId, {
        ...rest,
        step: "AGENT_RUNNING",
        active_delegation_group_id: null,
        active_delegation_child_count: 0,
        active_delegation_settled_count: 0,
      });
    }
  }

  private isPromptTooLongError(stderrSnippet: string): boolean {
    return PROMPT_TOO_LONG_PATTERN.test(stderrSnippet);
  }

  private isInterruptedExit(code: number, stderrSnippet: string): boolean {
    return code === 130 || code === 143 || INTERRUPTED_EXIT_PATTERN.test(stderrSnippet);
  }

  private async handlePromptTooLong(
    agentId: string,
    taskId: string,
    task: import("../tasks/scheduler").Task,
  ): Promise<void> {
    const retryRow = this.db
      .prepare("SELECT COUNT(*) as count FROM error_log WHERE category = ? AND context LIKE ?")
      .get("agent.prompt_too_long_retry", `%"taskId":"${taskId}"%`) as { count: number };

    if (retryRow.count >= MAX_PROMPT_TOO_LONG_RETRIES) {
      logError(this.db, "agent.prompt_too_long_max_retries", {
        agentId, taskId, retries: retryRow.count, method: "handlePromptTooLong",
      });
      this.taskScheduler.failTask(
        taskId,
        `Prompt too long after ${retryRow.count} retry attempt(s). Task context exceeds CLI limits.`,
      );
      return;
    }

    logError(this.db, "agent.prompt_too_long_retry", {
      agentId, taskId, attempt: retryRow.count + 1, method: "handlePromptTooLong",
    });

    const teamExec = task.team_id
      ? this.teamManager.getTeamForExecution(task.team_id)
      : null;

    const entrypointAgentId = teamExec?.entrypoint_agent_id ?? agentId;
    const agent = this.agentManager.getAgent(entrypointAgentId);
    if (!agent) {
      this.taskScheduler.failTask(taskId, "Agent not found for prompt-too-long recovery");
      return;
    }

    if (this.agentManager.getRunningAgent(entrypointAgentId)) {
      this.agentManager.killAgent(entrypointAgentId);
      await this.agentManager.waitForExit(entrypointAgentId);
    }

    this.agentManager.clearSessionId(entrypointAgentId);
    const workingDir = process.cwd();

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
      "Complete the assigned work. When the current phase is done, call the `complete_phase` MCP tool (or `complete_task` if this is the final phase).",
    ].join("\n");

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    const isStreaming = typeDef?.supports_stdin ?? false;
    const usesInlinePrompt = typeDef ? agentTypeUsesInlinePrompt(typeDef) : false;
    await this.agentManager.spawnAgent(entrypointAgentId, {
      workingDir,
      taskId,
      initialPrompt: usesInlinePrompt ? recoveryPrompt : undefined,
    });

    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(taskId, entrypointAgentId);

    const closeStdin = !isStreaming;

    if (!usesInlinePrompt) {
      this.agentManager.sendInput(entrypointAgentId, recoveryPrompt, closeStdin);
    }
  }
}
