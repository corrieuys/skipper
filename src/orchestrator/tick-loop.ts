import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { TaskRunner } from "./task-runner";
import type { RecoveryManager } from "./recovery-manager";
import type { DelegationManager } from "./delegation-manager";
import type { HealthMonitor } from "./health-monitor";
import type { WorktreeManager } from "./worktree-manager";
import type { EscalationManager } from "../escalations/manager";
import type { IdlePokeManager } from "./idle-poke-manager";
import { logError } from "../logging";
import { getNumberSetting, SETTING_LOG_RETENTION_HOURS } from "../config/app-settings";
const RECONCILIATION_OWNER_PID_KEY = "owner_pid";

interface TimerConfig {
  name: string;
  fn: () => void | Promise<void>;
  intervalMs: number;
}


export class ReconciliationLoop {
  private timerIds: Map<string, ReturnType<typeof setInterval>> = new Map();
  private timers: TimerConfig[] = [];
  _paused = false;
  _pauseRequested = false;
  _tickRunning = false;
  private transitionsThisTick: Set<string> = new Set();

  constructor(
    private readonly db: Database,
    private readonly agentManager: AgentManager,
    private readonly taskRunner: TaskRunner,
    private readonly recoveryManager: RecoveryManager,
    private readonly delegationManager: DelegationManager,
    private readonly healthMonitor: HealthMonitor,
    private readonly worktreeManager?: WorktreeManager,
    private readonly escalationManager?: EscalationManager,
    private readonly scheduledTaskProcessor?: () => void | Promise<void>,
    private readonly idlePokeManager?: IdlePokeManager,
  ) {
    this.timers = [
      // Fast: process liveness
      { name: "process-health",     fn: () => this.healthMonitor.checkProcessHealth(),              intervalMs: 10_000 },
      { name: "instance-health",    fn: () => this.healthMonitor.checkInstanceProcessHealth(),      intervalMs: 10_000 },

      // Medium: state reconciliation
      { name: "stale-recovery",     fn: () => this.recoveryManager.recoverAllStaleTasks(),          intervalMs: 30_000 },
      { name: "idle-poke",          fn: () => this.idlePokeManager?.runIdlePokes(),                 intervalMs: 30_000 },
      { name: "task-queue",         fn: () => this.taskRunner.processTaskQueue(),                   intervalMs: 60_000 },
      { name: "checkpoints",        fn: () => this.recoveryManager.persistCheckpoints(
          (agentId: string) => this.delegationManager.getActiveDelegationForParent(agentId),
        ),                                                                                          intervalMs: 30_000 },
      { name: "stale-delegations",  fn: () => this.delegationManager.checkStaleDelegations(),       intervalMs: 60_000 },
      { name: "stale-groups",       fn: () => this.delegationManager.checkStaleDelegationGroups(),  intervalMs: 60_000 },

      // Slow: expensive checks
      { name: "stuck-detection",    fn: () => this.healthMonitor.runStuckDetection(),               intervalMs: 60_000 },
      { name: "delegation-orphans", fn: () => this.healthMonitor.checkDelegationOrphans(),          intervalMs: 60_000 },
      { name: "orphaned-tasks",     fn: () => this.healthMonitor.checkOrphanedTasks(),              intervalMs: 60_000 },
      { name: "escalation-recon",   fn: () => this.escalationManager?.reconcileOpenEscalationsForInactiveTasks(), intervalMs: 120_000 },

      // Infrequent: housekeeping
      { name: "worktree-cleanup",   fn: () => this.worktreeManager?.cleanupStaleWorktrees(),        intervalMs: 300_000 },
      { name: "terminal-cleanup",   fn: () => this.cleanupOldTerminalOutputs(),                     intervalMs: 300_000 },

      // Scheduled tasks (experimental)
      ...(this.scheduledTaskProcessor
        ? [{ name: "scheduled-tasks", fn: this.scheduledTaskProcessor, intervalMs: 60_000 }]
        : []),
    ];
  }

  async start(): Promise<void> {
    if (this.timerIds.size > 0) return;
    this.stopExistingDaemonOwner();
    this.claimDaemonOwnership();

    if (this.loadPausedState()) {
      this._paused = true;
      this._pauseRequested = false;
      return;
    }

    this.recoveryManager.cleanupStaleState();
    await this.recoveryManager.recoverAllStaleTasks();

    // Run one full tick synchronously, then start independent timers
    this.tick();
    this.startTimers();
  }

  private startTimers(): void {
    for (const timer of this.timers) {
      const id = setInterval(() => {
        if (this._paused || this._pauseRequested) return;
        try {
          const result = timer.fn();
          if (result instanceof Promise) {
            result.catch((err) => logError(this.db, `timer_${timer.name}`, {}, err));
          }
        } catch (err) {
          logError(this.db, `timer_${timer.name}`, {}, err);
        }
      }, timer.intervalMs);
      this.timerIds.set(timer.name, id);
    }
  }

  private stopTimers(): void {
    for (const [, id] of this.timerIds) {
      clearInterval(id);
    }
    this.timerIds.clear();
  }

  stop(): void {
    this.stopTimers();
    this.releaseDaemonOwnership();
  }

  getStatus(): { state: "running" | "pausing" | "paused" | "stopped"; uptime: number } {
    let state: "running" | "pausing" | "paused" | "stopped";
    if (this._paused) {
      state = "paused";
    } else if (this._pauseRequested) {
      state = "pausing";
    } else if (this.timerIds.size > 0) {
      state = "running";
    } else {
      state = "stopped";
    }
    return { state, uptime: process.uptime() };
  }

  pause(): Promise<void> {
    if (this._paused) return Promise.resolve();
    this._pauseRequested = true;

    if (!this._tickRunning) {
      this.enterPausedState();
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const PAUSE_TIMEOUT_MS = 30_000;
      const check = setInterval(() => {
        if (!this._tickRunning) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, PAUSE_TIMEOUT_MS);
    });
  }

  resume(): void {
    if (!this._paused && !this._pauseRequested) return;

    this._paused = false;
    this._pauseRequested = false;
    this.deletePausedState();

    if (this.timerIds.size === 0) {
      this.tick();
      this.startTimers();
    }
  }

  hasTransitionedThisTick(taskId: string): boolean {
    return this.transitionsThisTick.has(taskId);
  }

  recordTransitionThisTick(taskId: string): void {
    this.transitionsThisTick.add(taskId);
  }

  /** Runs all concerns once, sequentially. Used for startup, manual trigger, and tests. */
  async tick(): Promise<void> {
    this._tickRunning = true;
    this.transitionsThisTick.clear();
    const runId = this.recordReconciliationRun();
    let tasksProcessed = 0;
    let agentsChecked = 0;
    const errors: string[] = [];

    try {
      for (const timer of this.timers) {
        if (this._pauseRequested) {
          this.enterPausedState();
          return;
        }
        try {
          const result = timer.fn();
          if (result instanceof Promise) {
            await result;
          }
        } catch (err) {
          errors.push(`[${timer.name}] ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (this._pauseRequested) { this.enterPausedState(); return; }

      try {
        agentsChecked = this.agentManager.getRunningAgents().size;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    } finally {
      this.completeReconciliationRun(runId, tasksProcessed, agentsChecked, errors);
      this._tickRunning = false;
    }
  }

  private enterPausedState(): void {
    this._paused = true;
    this._pauseRequested = false;
    this.stop();
    this.persistPausedState();
  }

  private persistPausedState(): void {
    try {
      this.db
        .prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES ('paused', 'true')")
        .run();
    } catch (err) {
      logError(this.db, "pause_state_persist", { method: "persistPausedState" }, err);
    }
  }

  private deletePausedState(): void {
    try {
      this.db
        .prepare("DELETE FROM daemon_state WHERE key = 'paused'")
        .run();
    } catch (err) {
      logError(this.db, "pause_state_delete", { method: "deletePausedState" }, err);
    }
  }

  private loadPausedState(): boolean {
    try {
      const row = this.db
        .prepare("SELECT value FROM daemon_state WHERE key = 'paused'")
        .get() as { value: string } | null;
      return row?.value === "true";
    } catch (err) {
      logError(this.db, "pause_state_load", { method: "loadPausedState" }, err);
      return false;
    }
  }

  cleanupOldTerminalOutputs(): void {
    const retentionHours = getNumberSetting(this.db, SETTING_LOG_RETENTION_HOURS, 24);
    try {
      this.db
        .prepare("DELETE FROM terminal_outputs WHERE created_at < datetime('now', ? || ' hours')")
        .run(-retentionHours);
      this.db
        .prepare("DELETE FROM agent_sessions WHERE created_at < datetime('now', ? || ' hours')")
        .run(-retentionHours);
      this.db
        .prepare("DELETE FROM events WHERE created_at < datetime('now', ? || ' hours')")
        .run(-retentionHours);
    } catch (err) {
      logError(this.db, "terminal_output_cleanup", { retentionHours }, err);
    }
  }

  private recordReconciliationRun(): number {
    try {
      const result = this.db
        .prepare("INSERT INTO manager_runs (started_at) VALUES (datetime('now'))")
        .run();
      return Number(result.lastInsertRowid);
    } catch (err) {
      logError(this.db, "reconciliation_run_record", { method: "recordReconciliationRun" }, err);
      return 0;
    }
  }

  private completeReconciliationRun(
    runId: number,
    tasksProcessed: number,
    agentsChecked: number,
    errors: string[],
  ): void {
    if (runId === 0) return;
    try {
      this.db
        .prepare(
          `UPDATE manager_runs
           SET completed_at = datetime('now'),
               tasks_processed = ?,
               agents_checked = ?,
               errors = ?
           WHERE id = ?`,
        )
        .run(tasksProcessed, agentsChecked, JSON.stringify(errors), runId);
    } catch (err) {
      logError(this.db, "reconciliation_run_complete", { runId, tasksProcessed, agentsChecked, method: "completeReconciliationRun" }, err);
    }
  }

  private stopExistingDaemonOwner(): void {
    try {
      const row = this.db
        .prepare("SELECT value FROM daemon_state WHERE key = ?")
        .get(RECONCILIATION_OWNER_PID_KEY) as { value: string } | null;
      const existingPid = Number(row?.value);
      if (!Number.isFinite(existingPid) || existingPid <= 0 || existingPid === process.pid) {
        return;
      }

      if (!this.isProcessAlive(existingPid)) {
        this.db
          .prepare("DELETE FROM daemon_state WHERE key = ?")
          .run(RECONCILIATION_OWNER_PID_KEY);
        return;
      }

      process.kill(existingPid, "SIGTERM");
      this.db
        .prepare("DELETE FROM daemon_state WHERE key = ?")
        .run(RECONCILIATION_OWNER_PID_KEY);
    } catch (err) {
      logError(this.db, "daemon_owner_stop_existing", { method: "stopExistingDaemonOwner" }, err);
    }
  }

  private claimDaemonOwnership(): void {
    try {
      this.db
        .prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)")
        .run(RECONCILIATION_OWNER_PID_KEY, String(process.pid));
    } catch (err) {
      logError(this.db, "daemon_owner_claim", { method: "claimDaemonOwnership", pid: process.pid }, err);
    }
  }

  private releaseDaemonOwnership(): void {
    try {
      const row = this.db
        .prepare("SELECT value FROM daemon_state WHERE key = ?")
        .get(RECONCILIATION_OWNER_PID_KEY) as { value: string } | null;
      if (row?.value !== String(process.pid)) return;

      this.db
        .prepare("DELETE FROM daemon_state WHERE key = ?")
        .run(RECONCILIATION_OWNER_PID_KEY);
    } catch (err) {
      logError(this.db, "daemon_owner_release", { method: "releaseDaemonOwnership", pid: process.pid }, err);
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
