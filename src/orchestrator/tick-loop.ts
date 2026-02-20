import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { TaskRunner } from "./task-runner";
import type { RecoveryManager } from "./recovery-manager";
import type { DelegationManager } from "./delegation-manager";
import type { HealthMonitor } from "./health-monitor";
import { logError } from "../logging";

const DAEMON_INTERVAL_MS = 30_000;

export class DaemonLoop {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  _paused = false;
  _pauseRequested = false;
  _tickRunning = false;

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

    if (this.loadPausedState()) {
      this._paused = true;
      this._pauseRequested = false;
      return;
    }

    this.recoveryManager.cleanupStaleState();
    await this.recoveryManager.recoverAllStaleTasks();

    this.tick();
    this.intervalId = setInterval(() => this.tick(), DAEMON_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
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
      const check = setInterval(() => {
        if (!this._tickRunning) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
  }

  resume(): void {
    if (!this._paused && !this._pauseRequested) return;

    this._paused = false;
    this._pauseRequested = false;
    this.deletePausedState();

    if (!this.intervalId) {
      this.tick();
      this.intervalId = setInterval(() => this.tick(), DAEMON_INTERVAL_MS);
    }
  }

  async tick(): Promise<void> {
    this._tickRunning = true;
    const runId = this.recordDaemonRun();
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
        this.healthMonitor.runStuckDetection();
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
    } finally {
      this.completeDaemonRun(runId, tasksProcessed, agentsChecked, errors);
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

  private recordDaemonRun(): number {
    try {
      const result = this.db
        .prepare("INSERT INTO manager_runs (started_at) VALUES (datetime('now'))")
        .run();
      return Number(result.lastInsertRowid);
    } catch (err) {
      logError(this.db, "daemon_run_record", { method: "recordDaemonRun" }, err);
      return 0;
    }
  }

  private completeDaemonRun(
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
      logError(this.db, "daemon_run_complete", { runId, tasksProcessed, agentsChecked, method: "completeDaemonRun" }, err);
    }
  }
}
