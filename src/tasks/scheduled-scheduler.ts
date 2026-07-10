import type { Database } from "bun:sqlite";
import { parseJsonOr } from "../db/json";
import { getDb } from "../db/connection";
import type { TaskScheduler, Task } from "./scheduler";

export type ScheduleUnit = "minutes" | "hours" | "days";

/**
 * Weekly schedule matrix: 7 rows (index 0 = Monday) of 24 hour cells (0/1).
 * An enabled cell fires one run at the top of that local hour. Mutually
 * exclusive with the fixed interval (schedule_unit/schedule_amount).
 */
export type ScheduleMatrix = number[][];

export function isValidScheduleMatrix(v: unknown): v is ScheduleMatrix {
  if (!Array.isArray(v) || v.length !== 7) return false;
  let enabled = 0;
  for (const row of v) {
    if (!Array.isArray(row) || row.length !== 24) return false;
    for (const cell of row) {
      if (cell !== 0 && cell !== 1) return false;
      if (cell === 1) enabled++;
    }
  }
  return enabled > 0;
}

export function parseScheduleMatrix(raw: string | null): ScheduleMatrix | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isValidScheduleMatrix(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Next fire time for a weekly matrix, as the same UTC "YYYY-MM-DD HH:MM:SS"
 * string calculateNextRunAt produces (comparable to SQLite datetime('now')).
 * Matrix cells are LOCAL wall-clock time: we take the local top-of-hour and
 * scan forward one hour-instant at a time, mapping each instant back to its
 * local (day, hour). The scan starts strictly after `from`, so a run fired at
 * 14:00:05 cannot re-match hour 14. Stepping instants (not wall hours) makes
 * DST self-handling: the spring-forward missing hour never occurs, and the
 * fall-back repeated hour can fire at both occurrences (one extra run once a
 * year, accepted for simplicity).
 */
export function calculateNextRunFromMatrix(matrix: ScheduleMatrix, from?: Date): string | null {
  const d = new Date(from ?? new Date());
  d.setMinutes(0, 0, 0);
  const hourMs = 3_600_000;
  for (let i = 1; i <= 7 * 24 + 1; i++) {
    const c = new Date(d.getTime() + i * hourMs);
    const day = (c.getDay() + 6) % 7; // JS getDay: 0=Sunday; matrix: 0=Monday
    const hour = c.getHours();
    if (matrix[day]?.[hour] === 1) {
      return c.toISOString().replace("T", " ").slice(0, 19);
    }
  }
  return null;
}

export interface ScheduledTask {
  id: string;
  title: string;
  description: string | null;
  team_id: string | null;
  working_directory: string;
  // null interval = manual only: never auto-runs, can only fire via "Run Now".
  schedule_unit: ScheduleUnit | null;
  schedule_amount: number | null;
  // Weekly matrix mode; mutually exclusive with the interval fields.
  schedule_matrix: ScheduleMatrix | null;
  status: "draft" | "approved";
  task_config: Record<string, unknown>;
  next_run_at: string | null;
  last_run_at: string | null;
  /** Secret for the public webhook trigger URL via connect; null = disabled. */
  webhook_key: string | null;
  /** Debounce window in minutes (floor 1): webhooks arriving inside it are ignored. */
  webhook_debounce_minutes: number;
  /** Last incoming webhook (fired or ignored); cron and manual runs do not stamp this. */
  webhook_last_event_at: string | null;
  /**
   * Free-text contract for how runs use the cross-task global store (key
   * names, payload shape, rolling-window markers). Injected into every
   * spawned run's root prompt via the run task's task_config.
   */
  global_store_instructions: string | null;
  created_at: string;
  updated_at: string;
}

interface ScheduledTaskRow {
  id: string;
  title: string;
  description: string | null;
  team_id: string | null;
  working_directory: string;
  schedule_unit: string | null;
  schedule_amount: number | null;
  schedule_matrix: string | null;
  status: string;
  task_config: string;
  next_run_at: string | null;
  last_run_at: string | null;
  webhook_key: string | null;
  webhook_debounce_minutes: number | null;
  webhook_last_event_at: string | null;
  global_store_instructions: string | null;
  created_at: string;
  updated_at: string;
}

function rowToScheduledTask(row: ScheduledTaskRow): ScheduledTask {
  const taskConfig = parseJsonOr<Record<string, unknown>>(row.task_config, {});

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    team_id: row.team_id,
    working_directory: row.working_directory ?? "",
    schedule_unit: (row.schedule_unit as ScheduleUnit | null) ?? null,
    schedule_amount: row.schedule_amount ?? null,
    schedule_matrix: parseScheduleMatrix(row.schedule_matrix ?? null),
    status: row.status as ScheduledTask["status"],
    task_config: taskConfig,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    webhook_key: row.webhook_key ?? null,
    webhook_debounce_minutes: row.webhook_debounce_minutes ?? 1,
    webhook_last_event_at: row.webhook_last_event_at ?? null,
    global_store_instructions: row.global_store_instructions ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CreateScheduledTaskInput {
  title: string;
  description?: string;
  teamId?: string;
  workingDirectory: string;
  // Omit both to create a manual-only recurring task (no automatic firing).
  scheduleUnit?: ScheduleUnit | null;
  scheduleAmount?: number | null;
  // Weekly matrix mode; mutually exclusive with scheduleUnit/scheduleAmount.
  scheduleMatrix?: ScheduleMatrix | null;
  // Global-store usage contract, injected into every spawned run's prompt.
  globalStoreInstructions?: string;
  taskConfig?: Record<string, unknown>;
}

export interface UpdateScheduledTaskInput {
  title: string;
  description?: string;
  teamId?: string;
  workingDirectory?: string;
  // null clears the interval (manual-only); undefined keeps the existing value.
  scheduleUnit?: ScheduleUnit | null;
  scheduleAmount?: number | null;
  // Same convention: null clears the weekly matrix, undefined keeps it.
  scheduleMatrix?: ScheduleMatrix | null;
  // Global-store usage contract; empty/undefined clears (the edit form always
  // submits the field, matching the description semantics).
  globalStoreInstructions?: string;
  taskConfig?: Record<string, unknown>;
}

export class ScheduledTaskScheduler {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDb();
  }

  createScheduledTask(input: CreateScheduledTaskInput): ScheduledTask {
    if ((input.scheduleUnit || input.scheduleAmount) && input.scheduleMatrix) {
      throw new Error("A scheduled task uses either an interval or a weekly schedule, not both");
    }

    const id = crypto.randomUUID();
    const taskConfig = input.taskConfig ? JSON.stringify(input.taskConfig) : "{}";
    const workingDirectory = input.workingDirectory || process.cwd();

    this.db
      .prepare(
        `INSERT INTO scheduled_tasks (id, title, description, team_id, working_directory, schedule_unit, schedule_amount, schedule_matrix, global_store_instructions, task_config)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.description ?? null,
        input.teamId ?? null,
        workingDirectory,
        input.scheduleUnit ?? null,
        input.scheduleAmount ?? null,
        input.scheduleMatrix ? JSON.stringify(input.scheduleMatrix) : null,
        input.globalStoreInstructions?.trim() ? input.globalStoreInstructions.trim() : null,
        taskConfig,
      );

    return this.getScheduledTask(id)!;
  }

  getScheduledTask(id: string): ScheduledTask | null {
    const row = this.db
      .prepare("SELECT * FROM scheduled_tasks WHERE id = ?")
      .get(id) as ScheduledTaskRow | null;
    return row ? rowToScheduledTask(row) : null;
  }

  /**
   * Enable the public webhook trigger. Generates the secret on first enable
   * and keeps it stable afterwards, so re-enabling does not invalidate URLs
   * already pasted into external services - use regenerateWebhookKey for that.
   */
  enableWebhook(id: string): ScheduledTask {
    const task = this.getScheduledTask(id);
    if (!task) throw new Error(`Scheduled task not found: ${id}`);
    if (!task.webhook_key) {
      this.db
        .prepare("UPDATE scheduled_tasks SET webhook_key = ?, updated_at = datetime('now') WHERE id = ?")
        .run(crypto.randomUUID(), id);
    }
    return this.getScheduledTask(id)!;
  }

  /** Rotate the webhook secret - every previously shared URL stops working. */
  regenerateWebhookKey(id: string): ScheduledTask {
    const task = this.getScheduledTask(id);
    if (!task) throw new Error(`Scheduled task not found: ${id}`);
    this.db
      .prepare("UPDATE scheduled_tasks SET webhook_key = ?, updated_at = datetime('now') WHERE id = ?")
      .run(crypto.randomUUID(), id);
    return this.getScheduledTask(id)!;
  }

  /** Disable the webhook trigger entirely (clears the secret). */
  disableWebhook(id: string): ScheduledTask {
    const task = this.getScheduledTask(id);
    if (!task) throw new Error(`Scheduled task not found: ${id}`);
    this.db
      .prepare("UPDATE scheduled_tasks SET webhook_key = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(id);
    return this.getScheduledTask(id)!;
  }

  /** Set the webhook debounce window in minutes. Floor is 1. */
  setWebhookDebounce(id: string, minutes: number): ScheduledTask {
    const task = this.getScheduledTask(id);
    if (!task) throw new Error(`Scheduled task not found: ${id}`);
    if (!Number.isInteger(minutes) || minutes < 1) {
      throw new Error("Webhook debounce must be a whole number of minutes, at least 1");
    }
    this.db
      .prepare("UPDATE scheduled_tasks SET webhook_debounce_minutes = ?, updated_at = datetime('now') WHERE id = ?")
      .run(minutes, id);
    return this.getScheduledTask(id)!;
  }

  /**
   * Fire a webhook-triggered run with leading-edge debounce: a webhook
   * arriving within webhook_debounce_minutes of the previous webhook is
   * ignored. EVERY webhook (fired or ignored) restamps webhook_last_event_at,
   * so sustained fires keep extending the quiet window and only the first
   * webhook of a burst runs. Cron and manual runs neither stamp nor consume
   * the window.
   */
  runWebhookTask(
    id: string,
    taskScheduler: TaskScheduler,
    runInput?: string,
  ): { debounced: false; task: Task } | { debounced: true } {
    const scheduled = this.getScheduledTask(id);
    if (!scheduled) throw new Error(`Scheduled task not found: ${id}`);

    const stamp = this.db
      .prepare("UPDATE scheduled_tasks SET webhook_last_event_at = datetime('now') WHERE id = ?");

    if (scheduled.webhook_last_event_at) {
      const lastMs = new Date(scheduled.webhook_last_event_at.replace(" ", "T") + "Z").getTime();
      const windowMs = Math.max(1, scheduled.webhook_debounce_minutes) * 60_000;
      if (Date.now() - lastMs < windowMs) {
        stamp.run(id);
        return { debounced: true };
      }
    }

    const task = this.runTaskNow(id, taskScheduler, runInput);
    stamp.run(id);
    return { debounced: false, task };
  }

  listScheduledTasks(): ScheduledTask[] {
    const rows = this.db
      .prepare("SELECT * FROM scheduled_tasks ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END, created_at DESC")
      .all() as ScheduledTaskRow[];
    return rows.map(rowToScheduledTask);
  }

  updateScheduledTask(id: string, input: UpdateScheduledTaskInput): ScheduledTask {
    const task = this.getScheduledTask(id);
    if (!task) throw new Error(`Scheduled task not found: ${id}`);
    if (task.status !== "draft") {
      throw new Error(`Can only edit draft scheduled tasks, current status: ${task.status}`);
    }

    const taskConfig = input.taskConfig ? JSON.stringify(input.taskConfig) : JSON.stringify(task.task_config);
    const workingDirectory = input.workingDirectory?.trim() ?? task.working_directory;

    // null = explicit clear (manual-only); undefined = keep existing.
    const scheduleUnit = input.scheduleUnit !== undefined ? input.scheduleUnit : task.schedule_unit;
    const scheduleAmount = input.scheduleAmount !== undefined ? input.scheduleAmount : task.schedule_amount;
    const scheduleMatrix = input.scheduleMatrix !== undefined ? input.scheduleMatrix : task.schedule_matrix;
    if ((scheduleUnit || scheduleAmount) && scheduleMatrix) {
      throw new Error("A scheduled task uses either an interval or a weekly schedule, not both");
    }

    this.db
      .prepare(
        `UPDATE scheduled_tasks
         SET title = ?, description = ?, team_id = ?, working_directory = ?,
             schedule_unit = ?, schedule_amount = ?, schedule_matrix = ?, global_store_instructions = ?, task_config = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        input.title.trim(),
        input.description?.trim() ? input.description.trim() : null,
        input.teamId?.trim() ? input.teamId.trim() : null,
        workingDirectory,
        scheduleUnit,
        scheduleAmount,
        scheduleMatrix ? JSON.stringify(scheduleMatrix) : null,
        input.globalStoreInstructions?.trim() ? input.globalStoreInstructions.trim() : null,
        taskConfig,
        id,
      );

    return this.getScheduledTask(id)!;
  }

  approveScheduledTask(id: string): ScheduledTask {
    const task = this.getScheduledTask(id);
    if (!task) throw new Error(`Scheduled task not found: ${id}`);
    if (task.status !== "draft") {
      throw new Error(`Can only approve draft scheduled tasks, current status: ${task.status}`);
    }
    if (!task.team_id) {
      throw new Error("Scheduled task must have a team assigned before approval");
    }

    // Manual-only tasks (no interval, no matrix) approve without a
    // next_run_at, so the tick loop never fires them: "Run Now" only.
    const nextRunAt = this.computeNextRunAt(task);

    this.db
      .prepare(
        `UPDATE scheduled_tasks SET status = 'approved', next_run_at = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'draft'`,
      )
      .run(nextRunAt, id);

    return this.getScheduledTask(id)!;
  }

  unapproveScheduledTask(id: string): ScheduledTask {
    const task = this.getScheduledTask(id);
    if (!task) throw new Error(`Scheduled task not found: ${id}`);
    if (task.status !== "approved") {
      throw new Error(`Can only unapprove approved scheduled tasks, current status: ${task.status}`);
    }

    this.db
      .prepare(
        `UPDATE scheduled_tasks SET status = 'draft', next_run_at = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'approved'`,
      )
      .run(id);

    return this.getScheduledTask(id)!;
  }

  deleteScheduledTask(id: string): void {
    const task = this.getScheduledTask(id);
    if (!task) throw new Error(`Scheduled task not found: ${id}`);

    this.db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
  }

  getDueScheduledTasks(): ScheduledTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_tasks
         WHERE status = 'approved'
           AND next_run_at IS NOT NULL
           AND next_run_at <= datetime('now')
         ORDER BY next_run_at ASC`,
      )
      .all() as ScheduledTaskRow[];
    return rows.map(rowToScheduledTask);
  }

  recordRun(id: string): void {
    const task = this.getScheduledTask(id);
    if (!task) return;

    // Manual-only tasks keep next_run_at = NULL so they never auto-fire again.
    // Rescans strictly forward from now, so a manual "Run Now" inside an
    // enabled matrix hour replaces that hour's automatic fire (same semantics
    // as interval mode).
    const nextRunAt = this.computeNextRunAt(task);

    this.db
      .prepare(
        `UPDATE scheduled_tasks
         SET last_run_at = datetime('now'), next_run_at = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(nextRunAt, id);
  }

  // Clear the recurring schedule (interval or weekly matrix) so the task
  // becomes manual-only: it stops auto-firing (next_run_at cleared) but stays
  // approved/runnable via "Run Now".
  clearSchedule(id: string): ScheduledTask {
    const task = this.getScheduledTask(id);
    if (!task) throw new Error(`Scheduled task not found: ${id}`);

    this.db
      .prepare(
        `UPDATE scheduled_tasks
         SET schedule_unit = NULL, schedule_amount = NULL, schedule_matrix = NULL, next_run_at = NULL, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(id);

    return this.getScheduledTask(id)!;
  }

  private computeNextRunAt(task: ScheduledTask): string | null {
    if (task.schedule_matrix) return calculateNextRunFromMatrix(task.schedule_matrix);
    if (task.schedule_unit && task.schedule_amount) {
      return this.calculateNextRunAt(task.schedule_unit, task.schedule_amount);
    }
    return null; // manual-only
  }

  calculateNextRunAt(unit: ScheduleUnit, amount: number, fromDate?: Date): string {
    const from = fromDate ?? new Date();
    const ms = from.getTime();
    let nextMs: number;

    switch (unit) {
      case "minutes":
        nextMs = ms + amount * 60 * 1000;
        break;
      case "hours":
        nextMs = ms + amount * 60 * 60 * 1000;
        break;
      case "days":
        nextMs = ms + amount * 24 * 60 * 60 * 1000;
        break;
    }

    return new Date(nextMs).toISOString().replace("T", " ").slice(0, 19);
  }

  runTaskNow(id: string, taskScheduler: TaskScheduler, runInput?: string): Task {
    const scheduled = this.getScheduledTask(id);
    if (!scheduled) throw new Error(`Scheduled task not found: ${id}`);
    if (scheduled.status !== "approved") throw new Error("Scheduled task must be approved to run");

    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    // The global-store contract rides in the run's task_config so the prompt
    // builder can inject it without a schema change on tasks.
    const task = taskScheduler.createTask({
      title: `${scheduled.title} (${timestamp})`,
      description: scheduled.description ?? undefined,
      teamId: scheduled.team_id ?? undefined,
      workingDirectory: scheduled.working_directory,
      taskConfig: {
        ...scheduled.task_config,
        ...(scheduled.global_store_instructions ? { global_store_instructions: scheduled.global_store_instructions } : {}),
      } as any,
    });

    // Optional one-off operator input injected into the run's prompt (below the
    // task description). Only manual "Run Now" carries this — cron firing does not.
    const trimmedInput = runInput?.trim();
    this.db
      .prepare("UPDATE tasks SET source_scheduled_task_id = ?, run_input = ? WHERE id = ?")
      .run(scheduled.id, trimmedInput || null, task.id);
    taskScheduler.approveTask(task.id);
    this.recordRun(scheduled.id);
    return task;
  }

  getRunsForScheduledTask(scheduledTaskId: string): Array<{
    id: string;
    title: string;
    status: string;
    started_at: string | null;
    completed_at: string | null;
    result: string | null;
    created_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, title, status, started_at, completed_at, result, created_at
         FROM tasks
         WHERE source_scheduled_task_id = ?
         ORDER BY created_at DESC
         LIMIT 50`,
      )
      .all(scheduledTaskId) as Array<{
      id: string;
      title: string;
      status: string;
      started_at: string | null;
      completed_at: string | null;
      result: string | null;
      created_at: string;
    }>;
  }
}
