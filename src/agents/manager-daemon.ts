import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { AgentManager } from "./manager";
import { PromptBuilder } from "./prompt-builder";
import { TaskScheduler } from "../tasks/scheduler";
import { TeamManager } from "../teams/manager";
import { StateTracker } from "./state-tracker";
import { eventBus } from "../events/bus";
import type { AgentExitEvent } from "../events/bus";
import { logError } from "../logging";

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

/**
 * Thin facade that wires together the focused orchestrator modules
 * and preserves backward compatibility for external consumers.
 */
export class ManagerDaemon {
  private db: Database;
  private agentManager: AgentManager;
  private taskScheduler: TaskScheduler;
  private stateTracker: StateTracker;
  private exitHandlerRegistered = false;

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

      if (event.code === 0) {
        this.phaseManager.handleSuccessfulExit(task, event.agentId);
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
    } catch (err) {
      logError(this.db, "agent_exit_handler", { agentId: event.agentId, method: "handleAgentExit" }, err);
    }
  }
}
