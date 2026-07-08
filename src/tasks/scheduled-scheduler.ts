import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import type { TaskScheduler, Task } from "./scheduler";

export type ScheduleUnit = "minutes" | "hours" | "days";

export interface ScheduledTask {
  id: string;
  title: string;
  description: string | null;
  team_id: string | null;
  working_directory: string;
  // null interval = manual only: never auto-runs, can only fire via "Run Now".
  schedule_unit: ScheduleUnit | null;
  schedule_amount: number | null;
  status: "draft" | "approved";
  task_config: Record<string, unknown>;
  next_run_at: string | null;
  last_run_at: string | null;
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
  status: string;
  task_config: string;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToScheduledTask(row: ScheduledTaskRow): ScheduledTask {
  let taskConfig: Record<string, unknown> = {};
  try {
    taskConfig = row.task_config ? JSON.parse(row.task_config) : {};
  } catch { /* leave empty */ }

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    team_id: row.team_id,
    working_directory: row.working_directory ?? "",
    schedule_unit: (row.schedule_unit as ScheduleUnit | null) ?? null,
    schedule_amount: row.schedule_amount ?? null,
    status: row.status as ScheduledTask["status"],
    task_config: taskConfig,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
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
  taskConfig?: Record<string, unknown>;
}

export class ScheduledTaskScheduler {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDb();
  }

  createScheduledTask(input: CreateScheduledTaskInput): ScheduledTask {
    const id = crypto.randomUUID();
    const taskConfig = input.taskConfig ? JSON.stringify(input.taskConfig) : "{}";
    const workingDirectory = input.workingDirectory || process.cwd();

    this.db
      .prepare(
        `INSERT INTO scheduled_tasks (id, title, description, team_id, working_directory, schedule_unit, schedule_amount, task_config)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.description ?? null,
        input.teamId ?? null,
        workingDirectory,
        input.scheduleUnit ?? null,
        input.scheduleAmount ?? null,
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

    this.db
      .prepare(
        `UPDATE scheduled_tasks
         SET title = ?, description = ?, team_id = ?, working_directory = ?,
             schedule_unit = ?, schedule_amount = ?, task_config = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        input.title.trim(),
        input.description?.trim() ? input.description.trim() : null,
        input.teamId?.trim() ? input.teamId.trim() : null,
        workingDirectory,
        scheduleUnit,
        scheduleAmount,
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

    // Manual-only tasks (no interval) approve without a next_run_at, so the
    // tick loop never fires them — they only run via "Run Now".
    const nextRunAt = task.schedule_unit && task.schedule_amount
      ? this.calculateNextRunAt(task.schedule_unit, task.schedule_amount)
      : null;

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
    const nextRunAt = task.schedule_unit && task.schedule_amount
      ? this.calculateNextRunAt(task.schedule_unit, task.schedule_amount)
      : null;

    this.db
      .prepare(
        `UPDATE scheduled_tasks
         SET last_run_at = datetime('now'), next_run_at = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(nextRunAt, id);
  }

  // Clear the recurring interval so the task becomes manual-only: it stops
  // auto-firing (next_run_at cleared) but stays approved/runnable via "Run Now".
  clearSchedule(id: string): ScheduledTask {
    const task = this.getScheduledTask(id);
    if (!task) throw new Error(`Scheduled task not found: ${id}`);

    this.db
      .prepare(
        `UPDATE scheduled_tasks
         SET schedule_unit = NULL, schedule_amount = NULL, next_run_at = NULL, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(id);

    return this.getScheduledTask(id)!;
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
    const task = taskScheduler.createTask({
      title: `${scheduled.title} (${timestamp})`,
      description: scheduled.description ?? undefined,
      teamId: scheduled.team_id ?? undefined,
      workingDirectory: scheduled.working_directory,
      taskConfig: scheduled.task_config as any,
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
