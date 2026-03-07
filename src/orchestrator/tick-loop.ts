import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { TaskRunner } from "./task-runner";
import type { RecoveryManager } from "./recovery-manager";
import type { DelegationManager } from "./delegation-manager";
import type { HealthMonitor } from "./health-monitor";
import { logError } from "../logging";

const RECONCILIATION_INTERVAL_MS = 30_000;
const LOG_RETENTION_HOURS = 24;
const RECONCILIATION_OWNER_PID_KEY = "owner_pid";

export class ReconciliationLoop {
  private intervalId: ReturnType<typeof setInterval> | null = null;
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
  ) {}

  async start(): Promise<void> {
    if (this.intervalId) return;
    this.stopExistingDaemonOwner();
    this.claimDaemonOwnership();

    if (this.loadPausedState()) {
      this._paused = true;
      this._pauseRequested = false;
      return;
    }

    this.recoveryManager.cleanupStaleState();
    await this.recoveryManager.recoverAllStaleTasks();

    this.tick();
    this.intervalId = setInterval(() => this.tick(), RECONCILIATION_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.releaseDaemonOwnership();
  }

  getStatus(): { state: "running" | "pausing" | "paused" | "stopped"; uptime: number } {
    let state: "running" | "pausing" | "paused" | "stopped";
    if (this._paused) {
      state = "paused";
    } else if (this._pauseRequested) {
      state = "pausing";
    } else if (this.intervalId) {
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

    if (!this.intervalId) {
      this.tick();
      this.intervalId = setInterval(() => this.tick(), RECONCILIATION_INTERVAL_MS);
    }
  }

  hasTransitionedThisTick(taskId: string): boolean {
    return this.transitionsThisTick.has(taskId);
  }

  recordTransitionThisTick(taskId: string): void {
    this.transitionsThisTick.add(taskId);
  }

  async tick(): Promise<void> {
    this._tickRunning = true;
    this.transitionsThisTick.clear();
    const runId = this.recordReconciliationRun();
    let tasksProcessed = 0;
    let agentsChecked = 0;
    const errors: string[] = [];

    try {
      try {
        this.healthMonitor.checkProcessHealth();
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      try {
        this.healthMonitor.checkInstanceProcessHealth();
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      try {
        this.healthMonitor.runStuckDetection();
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      try {
        this.healthMonitor.checkDelegationOrphans();
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      try {
        this.healthMonitor.checkOrphanedTasks();
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      if (this._paused || this._pauseRequested) {
        if (this._pauseRequested) {
          this.enterPausedState();
        }
        return;
      }

      try {
        await this.recoveryManager.recoverAllStaleTasks();
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      if (this._pauseRequested) { this.enterPausedState(); return; }

      try {
        const result = await this.taskRunner.processTaskQueue();
        tasksProcessed = result.processed;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      if (this._pauseRequested) { this.enterPausedState(); return; }

      try {
        this.delegationManager.checkStaleDelegations();
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      try {
        this.delegationManager.checkStaleDelegationGroups();
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      if (this._pauseRequested) { this.enterPausedState(); return; }

      try {
        agentsChecked = this.agentManager.getRunningAgents().size;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      try {
        this.recoveryManager.persistCheckpoints(
          (agentId: string) => this.delegationManager.getActiveDelegationForParent(agentId),
        );
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      try {
        this.cleanupOldTerminalOutputs();
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
    try {
      this.db
        .prepare("DELETE FROM terminal_outputs WHERE created_at < datetime('now', ? || ' hours')")
        .run(-LOG_RETENTION_HOURS);
      this.db
        .prepare("DELETE FROM agent_sessions WHERE created_at < datetime('now', ? || ' hours')")
        .run(-LOG_RETENTION_HOURS);
      this.db
        .prepare("DELETE FROM events WHERE created_at < datetime('now', ? || ' hours')")
        .run(-LOG_RETENTION_HOURS);
    } catch (err) {
      logError(this.db, "terminal_output_cleanup", { retentionHours: LOG_RETENTION_HOURS }, err);
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
