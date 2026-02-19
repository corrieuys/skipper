import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";

export type ScheduleUnit = "minutes" | "hours" | "days";

export interface ScheduledTask {
  id: string;
  title: string;
  description: string | null;
  team_id: string | null;
  working_directory: string;
  schedule_unit: ScheduleUnit;
  schedule_amount: number;
  status: "draft" | "approved";
  task_config: Record<string, unknown>;
  next_run_at: string | null;
  last_run_at: string | null;
  // When true, each fire re-uses the ONE backing tasks row + its Skipper
  // session (--resume) instead of creating a new task per fire. The end of
  // each fire flips tasks.pending_compact=1 so the next fire's prompt starts
  // with a context-compaction instruction.
  single_instance: boolean;
  created_at: string;
  updated_at: string;
}

interface ScheduledTaskRow {
  id: string;
  title: string;
  description: string | null;
  team_id: string | null;
  working_directory: string;
  schedule_unit: string;
  schedule_amount: number;
  status: string;
  task_config: string;
  next_run_at: string | null;
  last_run_at: string | null;
  single_instance: number;
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
    schedule_unit: row.schedule_unit as ScheduleUnit,
    schedule_amount: row.schedule_amount,
    status: row.status as ScheduledTask["status"],
    task_config: taskConfig,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    single_instance: Number(row.single_instance ?? 0) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CreateScheduledTaskInput {
  title: string;
  description?: string;
  teamId?: string;
  workingDirectory: string;
  scheduleUnit: ScheduleUnit;
  scheduleAmount: number;
  taskConfig?: Record<string, unknown>;
  singleInstance?: boolean;
}

export interface UpdateScheduledTaskInput {
  title: string;
  description?: string;
  teamId?: string;
  workingDirectory?: string;
  scheduleUnit?: ScheduleUnit;
  scheduleAmount?: number;
  taskConfig?: Record<string, unknown>;
  singleInstance?: boolean;
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
        `INSERT INTO scheduled_tasks (id, title, description, team_id, working_directory, schedule_unit, schedule_amount, task_config, single_instance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.description ?? null,
        input.teamId ?? null,
        workingDirectory,
        input.scheduleUnit,
        input.scheduleAmount,
        taskConfig,
        input.singleInstance ? 1 : 0,
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

    const singleInstance = input.singleInstance === undefined
      ? (task.single_instance ? 1 : 0)
      : (input.singleInstance ? 1 : 0);

    this.db
      .prepare(
        `UPDATE scheduled_tasks
         SET title = ?, description = ?, team_id = ?, working_directory = ?,
             schedule_unit = ?, schedule_amount = ?, task_config = ?, single_instance = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        input.title.trim(),
        input.description?.trim() ? input.description.trim() : null,
        input.teamId?.trim() ? input.teamId.trim() : null,
        workingDirectory,
        input.scheduleUnit ?? task.schedule_unit,
        input.scheduleAmount ?? task.schedule_amount,
        taskConfig,
        singleInstance,
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

    const nextRunAt = this.calculateNextRunAt(task.schedule_unit, task.schedule_amount);

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

    const nextRunAt = this.calculateNextRunAt(task.schedule_unit, task.schedule_amount);

    this.db
      .prepare(
        `UPDATE scheduled_tasks
         SET last_run_at = datetime('now'), next_run_at = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(nextRunAt, id);
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
