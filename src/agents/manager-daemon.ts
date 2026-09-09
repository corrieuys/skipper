import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { AgentManager } from "./manager";
import { PromptBuilder } from "./prompt-builder";
import { TaskScheduler } from "../tasks/scheduler";
import { TeamManager } from "../teams/manager";
import { StateTracker } from "./state-tracker";
import { EscalationManager } from "../escalations/manager";
import { HookManager } from "../hooks/manager";
import { eventBus } from "../events/bus";
import { updateInstanceStatus, finalizeActiveInstancesForTask } from "./instance-status";
import type { AgentExitEvent, AgentSignalEvent } from "../events/bus";
import { logError } from "../logging";
import { agentTypeUsesInlinePrompt, getAgentTypeDefinition } from "./types";
import { isCustomAgentType } from "../custom-agents/store";
import { isTaskTitleGeneratorConfigured } from "../config/model-settings";
import { ensureTaskTitle } from "../tasks/title-generator";

import { ReconciliationLoop } from "../orchestrator/tick-loop";
import { TaskRunner } from "../orchestrator/task-runner";
import { PhaseManager } from "../orchestrator/phase-manager";
import { DelegationManager } from "../orchestrator/delegation-manager";
import type { Delegation } from "../orchestrator/delegation-manager";
import { RecoveryManager } from "../orchestrator/recovery-manager";
import { IdlePokeManager } from "../orchestrator/idle-poke-manager";
import { HealthMonitor } from "../orchestrator/health-monitor";
import { ArtifactManager } from "../orchestrator/artifact-manager";
import { RealtimeSessionManager } from "../orchestrator/realtime-session";
import type { OrchestrationState, PausedAgentSnapshot, TaskCheckpoint } from "../orchestrator/types";
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
  private wakeRequestedHandler: ((event: import("../events/bus").TaskWakeRequestedEvent) => void) | null = null;
  private runSettledHandler: ((event: { taskId: string }) => void) | null = null;
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
  private realtimeSessionManager: RealtimeSessionManager;
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
    // Queued wakes deliver pending input through the pipeline (teamless tasks)
    // or as an INPUT_FEED block appended to the standard spawn prompt.
    this.taskRunner.setWakeFeeder(this.realtimeSessionManager);
    // Same feeder lets a parent resuming from a delegation result carry any
    // operator input that arrived while the delegation was open, instead of
    // deferring it to a whole new run.
    this.delegationManager.setWakeFeeder(this.realtimeSessionManager);

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
      this.escalationManager,
      () => this.processScheduledTasks(),
      this.idlePokeManager,
      this.taskScheduler,
    );

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
      if (isCustomAgentType(templateAgent.type)) {
        // An in-process run is one atomic generateText call — a mid-run steer
        // would kill and replay it, not inject guidance. Off until steering has
        // an in-process story; notes still reach the next spawn's prompt.
        disabledReason = "Steering is not available for custom agents. Add an operator note instead.";
      } else if (!supportsResume) {
        disabledReason = "Agent type does not support resume.";
      } else if (row.status !== "running") {
        disabledReason = row.status === "waiting_delegation"
          ? "Runtime is waiting on delegation and cannot be steered."
          : "Runtime is not currently running.";
      } else if (!runningRuntime || (!row.process_pid && runningRuntime.process.pid !== null)) {
        // A pid-less row is only dead if the runtime was supposed to have one.
        // In-process agents (custom agents) never do — the in-memory runtime is
        // their liveness signal.
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

  /**
   * Unified input entry point: text sent to a task from any surface (web
   * composer, /input routes, Slack thread reply, Connect). Behavior by state:
   *   draft            → appended to the description (becomes part of the ask)
   *   settled          → auto-revive, then treated as active
   *   active + review  → clears the review gate; input is the review response
   *   active           → timeline entry; wakes the root through the queue when
   *                      it is idle, or accumulates until its turn ends.
   */
  async inputTask(taskId: string, text: string, source: string = "user"): Promise<{ delivered: "draft" | "queued" | "accumulated" }> {
    const normalized = text.trim();
    if (!normalized) throw new Error("Input text is required");

    const task = this.taskScheduler.getTask(taskId);
    if (!task) throw new Error("Task not found");

    if (task.status === "draft") {
      const description = task.description ? `${task.description}\n\n${normalized}` : normalized;
      this.taskScheduler.updateTask(taskId, {
        title: task.title,
        description,
        teamId: task.team_id ?? undefined,
        workingDirectory: task.working_directory,
        mode: task.mode,
        taskConfig: task.task_config,
      });
      return { delivered: "draft" };
    }

    // Settled → revive; review gate → cleared (the input IS the review
    // response). Shared with file uploads (ingestArtifactUpload) so both kinds
    // of input admit a task the same way.
    this.realtimeSessionManager.prepareTaskForInput(taskId);

    await this.realtimeSessionManager.ingestInput(taskId, {
      sourceType: "text",
      contentBody: normalized,
      metadata: { source },
    }, source);

    // ingestInput requests a wake itself when the root is idle; report whether
    // the input is queued for delivery or accumulating behind a busy root.
    const busy = this.realtimeSessionManager.isSkipperBusy(taskId);
    return { delivered: busy ? "accumulated" : "queued" };
  }

  /**
   * Resume the latest instance of an agent on a COMPLETED task for a one-off,
   * single-turn run outside the normal task workflow. Reuses the steer/resume
   * path (`sendResumeMessage`) so the agent picks up its prior session context.
   * The task stays `completed`; the daemon does no phase/complete/recovery logic
   * for it (see `handleAgentExit`). The instance is flagged
   * `state_metadata.oneshot=true` so the MCP session omits phase-lifecycle tools
   * and the exit handler finalizes cleanly.
   */
  async resumeOneshotRun(templateAgentId: string, taskId: string, prompt: string): Promise<void> {
    const normalized = prompt.trim();
    if (!normalized) {
      throw new Error("message is required");
    }

    const templateAgent = this.agentManager.getAgent(templateAgentId);
    if (!templateAgent) {
      throw new Error("Agent not found");
    }

    const task = this.db
      .prepare("SELECT id, status FROM tasks WHERE id = ?")
      .get(taskId) as { id: string; status: string } | null;
    if (!task) throw new Error("Task not found");
    if (task.status !== "settled") {
      throw new Error("One-off runs are only allowed on settled tasks");
    }

    // Latest instance of this agent on this task.
    const instance = this.db
      .prepare(
        `SELECT id, session_id, status FROM agent_instances
         WHERE task_id = ? AND template_agent_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId, templateAgentId) as { id: string; session_id: string | null; status: string } | null;
    if (!instance) {
      throw new Error("This agent never ran on this task");
    }

    const typeDef = getAgentTypeDefinition(templateAgent.type, this.db);
    if (!typeDef?.supports_resume) {
      throw new Error("This agent's type does not support resume");
    }
    if (!instance.session_id) {
      throw new Error("This agent has no resumable session on this task");
    }

    // One-off at a time: block if this instance is live, or any one-off is
    // already active on the task.
    if (["running", "waiting_delegation", "pending"].includes(instance.status)) {
      throw new Error("This agent is already running on this task");
    }
    const activeOneshot = this.db
      .prepare(
        `SELECT id FROM agent_instances
         WHERE task_id = ?
           AND json_extract(state_metadata, '$.oneshot') = 1
           AND status IN ('running', 'waiting_delegation', 'pending')
         LIMIT 1`,
      )
      .get(taskId) as { id: string } | null;
    if (activeOneshot) {
      throw new Error("A one-off run is already active on this task");
    }

    // Mark the instance one-off BEFORE resume. The resume respawn's
    // INSERT ... ON CONFLICT does not touch state_metadata, so this survives.
    this.db
      .prepare(
        `UPDATE agent_instances
         SET state_metadata = json_set(COALESCE(state_metadata, '{}'), '$.oneshot', json('true'))
         WHERE id = ?`,
      )
      .run(instance.id);

    const wrapped = `[SYSTEM] One-off operator run OUTSIDE the normal task workflow. This task is SETTLED and stays settled. You CANNOT advance/regress phases or complete the task — those tools are unavailable to you. You MAY read/create notes and artifacts, and delegate to teammates (the orchestrator resumes you when a delegate finishes). When your turn ends, the run simply stops.\n\n${normalized}`;
    const closeStdin = this.shouldCloseStdinForAgent(instance.id);
    await this.agentManager.sendResumeMessage(instance.id, wrapped, closeStdin);

    try {
      this.agentManager.appendSyntheticOutput(
        instance.id,
        `[SKIPPER] One-off operator run started on settled task: ${normalized}`,
      );
    } catch (err) {
      logError(this.db, "oneshot.synthetic_output", { templateAgentId, taskId, instanceId: instance.id }, err);
    }
  }

  getReconciliationLoop(): ReconciliationLoop {
    return this.reconciliationLoop;
  }

  // --- Lifecycle (delegated to ReconciliationLoop) ---

  async start(): Promise<void> {
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
    noteLimit?: number,
    workingDirectory?: string,
  ): Promise<Delegation | null> {
    return this.delegationManager.handleDelegation(
      parentAgentId,
      childAgentId,
      delegationPrompt,
      noteLimit,
      workingDirectory,
    );
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
    if (!task || task.status !== "active" || task.paused) return;

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

  private processScheduledTasks(): void {
    try {
      const dueTasks = this.scheduledTaskScheduler.getDueScheduledTasks();
      for (const scheduled of dueTasks) {
        try {
          this.fireStandardScheduledTask(scheduled);
        } catch (err) {
          logError(this.db, "scheduled_task_fire", { scheduledId: scheduled.id, method: "processScheduledTasks" }, err);
        }
      }
    } catch (err) {
      logError(this.db, "scheduled_task_processing", { method: "processScheduledTasks" }, err);
    }
  }

  /** Each scheduled fire creates a new, fresh task, queued for TaskRunner. */
  private fireStandardScheduledTask(scheduled: import("../tasks/scheduled-scheduler").ScheduledTask): void {
    // Singleton guard: never overlap two runs of the same recurring task. A
    // prior run that is still active (queued, running, or paused) blocks the
    // new slot — dropped, not queued. This is what prevents the catch-up storm
    // when the daemon wakes from sleep with several overdue slots while a long
    // run is still in flight (each investigation can run for hours). recordRun
    // below still advances next_run_at to the next FUTURE slot, so the schedule
    // resumes cleanly rather than replaying every missed hour.
    const activeCount = (this.db
      .prepare(
        "SELECT COUNT(*) as c FROM tasks WHERE source_scheduled_task_id = ? AND status = 'active'",
      )
      .get(scheduled.id) as { c: number }).c;
    if (activeCount > 0) {
      console.log(
        `[scheduled] skip fire for "${scheduled.title}" (${scheduled.id}): a prior run is still active`,
      );
      // Advance the schedule past this slot so we don't re-evaluate it every
      // tick while the prior run drags on.
      this.scheduledTaskScheduler.recordRun(scheduled.id);
      return;
    }

    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const seriesTitle = scheduled.title?.trim();
    const generatorOn = isTaskTitleGeneratorConfigured(this.db);
    // Cron firing carries no per-run input; use the series title stamped with the
    // run time, else generate from the description (or timestamp when no generator).
    const initialTitle = seriesTitle ? `${seriesTitle} (${timestamp})` : generatorOn ? "" : timestamp;
    // The global-store contract rides in the run's task_config so the prompt
    // builder can inject it (same merge as runTaskNow).
    const task = this.taskScheduler.createTask({
      title: initialTitle,
      description: scheduled.description ?? undefined,
      teamId: scheduled.team_id ?? undefined,
      workingDirectory: scheduled.working_directory,
      taskConfig: {
        ...scheduled.task_config,
        ...(scheduled.global_store_instructions ? { global_store_instructions: scheduled.global_store_instructions } : {}),
      } as import("../tasks/scheduler").RealtimeTaskConfig,
    });

    this.db
      .prepare("UPDATE tasks SET source_scheduled_task_id = ? WHERE id = ?")
      .run(scheduled.id, task.id);

    if (!initialTitle) {
      void ensureTaskTitle(this.db, this.taskScheduler, task.id);
    }

    this.taskScheduler.approveTask(task.id);
    this.scheduledTaskScheduler.recordRun(scheduled.id);
  }

  getScheduledTaskScheduler(): ScheduledTaskScheduler {
    return this.scheduledTaskScheduler;
  }

  private registerTaskStateHandler(): void {
    this.taskStateHandler = (event: import("../events/bus").TaskStateChangedEvent) => {
      // Revive — the task returns to the active pipeline. Drop the in-memory
      // phase-completion dedup so a re-run's first complete_phase call isn't
      // swallowed by a stale guard.
      if (event.previousStatus === "settled" && event.newStatus === "active") {
        this.phaseManager.clearTaskState(event.taskId);
      }

      if (event.newStatus === "active" && event.previousStatus === "draft") {
        // Approval queues the first start; dispatch immediately instead of
        // waiting for the queue timer. Centralised here so every approve
        // surface (HTML, /data, MCP, connect, Slack) behaves identically.
        this.taskRunner.processTaskQueue().catch((err) => {
          logError(this.db, "reactive_task_dispatch", { taskId: event.taskId }, err);
        });
      }

      if (event.newStatus === "settled") {
        // Close any live input-pipeline session for this task.
        try {
          if (this.realtimeSessionManager.isSessionActive(event.taskId)) {
            this.realtimeSessionManager.closeSession(event.taskId);
          }
        } catch (err) {
          logError(this.db, "input_session_cleanup", { taskId: event.taskId, newStatus: event.newStatus }, err);
        }
        try {
          this.recoveryManager.cleanupTerminalTaskState(event.taskId);
        } catch (err) {
          logError(this.db, "terminal_task_cleanup_handler", { taskId: event.taskId, newStatus: event.newStatus }, err);
        }
        this.taskRunner.processTaskQueue().catch((err) => {
          logError(this.db, "reactive_task_dispatch_after_terminal", { taskId: event.taskId }, err);
        });
      }
    };
    eventBus.on("task:state_changed", this.taskStateHandler);

    this.wakeRequestedHandler = (event: import("../events/bus").TaskWakeRequestedEvent) => {
      // New input while at rest. Drop stale phase dedup (the woken run may
      // legitimately complete the same phase again), then dispatch — input
      // wakes go through the queue so they respect the concurrency cap.
      this.phaseManager.clearTaskState(event.taskId);
      this.taskRunner.processTaskQueue().catch((err) => {
        logError(this.db, "reactive_wake_dispatch", { taskId: event.taskId }, err);
      });
    };
    eventBus.on("task:wake_requested", this.wakeRequestedHandler);

    this.runSettledHandler = (event: { taskId: string }) => {
      // A run settled (complete_task / run failure). completeRun/failRun moved
      // the task to its resting state already; park the orchestration step at
      // IDLE and clear idle-poke bookkeeping. The settled-status branch of
      // taskStateHandler closes sessions, cleans runtime state, and frees the
      // concurrency slot.
      try {
        const prev = this.recoveryManager.getOrchestrationState(event.taskId);
        this.recoveryManager.updateOrchestrationState(event.taskId, {
          step: "IDLE",
          last_checkpoint_ts: new Date().toISOString(),
          session_id: prev?.session_id ?? null,
          active_delegation_group_id: null,
          active_delegation_child_count: 0,
          active_delegation_settled_count: 0,
          phase_guards: [],
          pending_regression: null,
          checkpoint_prompt_hash: null,
        });
      } catch (err) {
        logError(this.db, "run_settled_state", { taskId: event.taskId }, err);
      }
      try {
        this.idlePokeManager.clearIdle(event.taskId);
      } catch (err) {
        logError(this.db, "run_settled_idle_clear", { taskId: event.taskId }, err);
      }
    };
    eventBus.on("task:run_completed", this.runSettledHandler);
    eventBus.on("task:run_failed", this.runSettledHandler);
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
    if (this.wakeRequestedHandler) {
      eventBus.off("task:wake_requested", this.wakeRequestedHandler);
      this.wakeRequestedHandler = null;
    }
    if (this.runSettledHandler) {
      eventBus.off("task:run_completed", this.runSettledHandler);
      eventBus.off("task:run_failed", this.runSettledHandler);
      this.runSettledHandler = null;
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
        updateInstanceStatus(this.db, event.agentId, "stopped", { clearPid: true });
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
      // One-off run: the operator resumed this instance on an already-completed
      // task, outside the normal workflow. Finalize the instance cleanly and
      // stop — no phase/complete/fail/idle logic. Its children (if it delegated)
      // resume it via the normal delegation path before it reaches here.
      const oneshotRow = this.db
        .prepare("SELECT json_extract(state_metadata, '$.oneshot') AS oneshot FROM agent_instances WHERE id = ?")
        .get(event.agentId) as { oneshot: number | null } | null;
      if (oneshotRow?.oneshot === 1) {
        const templateId = this.agentManager.getTemplateAgentId(event.agentId) ?? event.agentId;
        updateInstanceStatus(this.db, event.agentId, event.code === 0 ? "completed" : "failed", { clearPid: true });
        this.db.prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?").run(templateId);
        logError(this.db, "agent_exit_bail", { agentId: event.agentId, taskId, reason: "oneshot_finalized", method: "handleAgentExit" }, new Error("bail"));
        return;
      }

      const task = this.taskScheduler.getTask(taskId);
      if (!task || task.status !== "active") {
        logError(this.db, "agent_exit_bail", { agentId: event.agentId, taskId, reason: !task ? "task_not_found" : `task_status_${task.status}`, method: "handleAgentExit" }, new Error("bail"));
        return;
      }

      // Template ID resolution — used by the real-time cleanup and the
      // post-exit current_task_id reset below. Falls back to the runtime
      // id for legacy non-instance agents.
      const templateId = this.agentManager.getTemplateAgentId(event.agentId) ?? event.agentId;

      // Conversational tasks are never failed by agent exit — idle with no
      // agents is their resting state; the input pipeline re-feeds them when
      // new input arrives. Clean up the instance and leave the task active.
      if (task.mode !== "workflow") {
        this.db
          .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
          .run(templateId);
        const settledStatus = event.code === 0 ? "completed" : "failed";
        updateInstanceStatus(this.db, event.agentId, settledStatus);
        const relRow = this.db
          .prepare("SELECT parent_instance_id, root_instance_id FROM agent_instances WHERE id = ?")
          .get(event.agentId) as { parent_instance_id: string | null; root_instance_id: string | null } | null;
        eventBus.emit("instance:state_changed", {
          instanceId: event.agentId,
          templateAgentId: templateId,
          taskId,
          parentInstanceId: relRow?.parent_instance_id ?? null,
          rootInstanceId: relRow?.root_instance_id ?? null,
          status: settledStatus,
        });
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
          // Clean exit (code 0) but no completed-turn marker: the run's
          // tool/MCP session dropped or the turn aborted before emitting
          // result / turn.completed / step_finish. This is a TRANSIENT fault,
          // not a terminal one, so do NOT failTask here — that used to throw
          // away long-running multi-phase work on a single dropped turn.
          //
          // Leave the task active with no live instance and let the
          // tick-loop orphan recovery (recoverAllStaleTasks) treat it exactly
          // like a crashed/orphaned root agent: it respawns the entrypoint
          // (15s grace, session/context preserved) and, if that retry makes
          // no forward progress, pauses the task for human Resume with notes,
          // artifacts, escalations, and checkpoints intact — rather than a
          // silent hard failure. The `if (!respawned)` block below marks this
          // instance finished + clears current_task_id, which is what makes
          // the task look orphaned to the recovery loop.
          logError(this.db, "agent_exit_bail", { agentId: event.agentId, taskId, reason: "no_completed_turn_output_recoverable", method: "handleAgentExit" }, new Error("bail"));
        } else if ((task.orchestration_state as { step?: string }).step !== "IDLE") {
          // Phase advancement is Skipper-explicit only. A clean exit with no
          // outstanding delegation / escalation simply means Skipper's turn
          // ended. Mark the task idle; the tick-loop poke will nudge Skipper
          // for a decision after IDLE_POKE_DELAY_MS. A settled run (step IDLE,
          // set when complete_task or a run failure landed) rests instead.
          this.idlePokeManager.markIdle(taskId);
        }
      } else if (this.isPromptTooLongError(event.stderrSnippet)) {
        this.handlePromptTooLong(event.agentId, taskId, task).catch((err) => {
          logError(this.db, "prompt_too_long_recovery", { agentId: event.agentId, taskId, method: "handleAgentExit" }, err);
          try {
            this.taskScheduler.failRun(taskId, `Prompt too long recovery failed: ${err instanceof Error ? err.message : String(err)}`);
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
          this.taskScheduler.failRun(taskId, `Agent exited with code ${event.code}`);
        } catch (err) {
          logError(this.db, "agent_exit_fail_task", { agentId: event.agentId, taskId: taskId, exitCode: event.code }, err);
        }
      }

      if (!respawned) {
        this.db
          .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
          .run(templateId);
        const finalStatus = event.code === 0 ? "completed" : "failed";
        updateInstanceStatus(this.db, event.agentId, finalStatus);
        // Announce the settled status so the UI clears this agent's "active"
        // orb. updateInstanceStatus is a bare UPDATE that emits nothing, and the
        // ui-push agent:exit handler already ran synchronously BEFORE this line —
        // it read the instance as still 'running' and rebuilt the steer panel
        // with the orb lit. Without this follow-up event nothing re-pushes once
        // the status flips, so the orb stayed active until a manual refresh.
        const rel = this.db
          .prepare("SELECT parent_instance_id, root_instance_id FROM agent_instances WHERE id = ?")
          .get(event.agentId) as { parent_instance_id: string | null; root_instance_id: string | null } | null;
        eventBus.emit("instance:state_changed", {
          instanceId: event.agentId,
          templateAgentId: templateId,
          taskId,
          parentInstanceId: rel?.parent_instance_id ?? null,
          rootInstanceId: rel?.root_instance_id ?? null,
          status: finalStatus,
        });
        // Input arrived while this root was busy (wake marker persisted). Now
        // that its instance is finalized the queue can deliver immediately
        // instead of waiting for the next 60s tick.
        const settled = this.taskScheduler.getTask(taskId);
        if (settled?.status === "active" && settled.wake_requested_at) {
          this.taskRunner.processTaskQueue().catch((err) => {
            logError(this.db, "reactive_wake_after_exit", { taskId }, err);
          });
        }
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
      // The runtime's resolved provider, not the template row's type — an
      // overridden root must resume as the provider that owns its session.
      const typeDef = getAgentTypeDefinition(runtime.providerType, this.db);
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
      const typeDef = snapshot.runtimeId === snapshot.templateAgentId
        ? this.agentManager.getEffectiveRootTypeDef(snapshot.templateAgentId)
        : this.agentManager.getEffectiveTypeDefForInstance(snapshot.runtimeId, snapshot.templateAgentId);
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
    finalizeActiveInstancesForTask(this.db, taskId, "stopped");
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
      const typeDef = snapshot.isTemplateRuntime
        ? this.agentManager.getEffectiveRootTypeDef(snapshot.templateAgentId)
        : this.agentManager.getEffectiveTypeDefForInstance(snapshot.runtimeId, snapshot.templateAgentId);
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
      this.taskScheduler.failRun(
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
      this.taskScheduler.failRun(taskId, "Agent not found for prompt-too-long recovery");
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

    // Root spawn: match the provider spawnAgent will actually resolve.
    const typeDef = this.agentManager.getEffectiveRootTypeDef(agent.id);
    const isStreaming = typeDef?.supports_stdin ?? false;
    const usesInlinePrompt = typeDef ? agentTypeUsesInlinePrompt(typeDef) : false;
    const spawned = await this.agentManager.spawnAgent(entrypointAgentId, {
      workingDir,
      taskId,
      initialPrompt: usesInlinePrompt ? recoveryPrompt : undefined,
    });

    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(taskId, entrypointAgentId);

    const closeStdin = !isStreaming;

    if (!usesInlinePrompt) {
      // Target the runtime instance just spawned, not the template id —
      // sendInput(templateId) misroutes to a sibling same-team task's stdin.
      this.agentManager.sendInput(spawned.id, recoveryPrompt, closeStdin);
    }
  }
}
