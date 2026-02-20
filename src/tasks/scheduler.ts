import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { eventBus } from "../events/bus";

export interface Task {
  id: string;
  title: string;
  description: string | null;
  team_id: string | null;
  status: "draft" | "approved" | "running" | "completed" | "failed";
  current_phase: number;
  priority: number;
  result: unknown | null;
  orchestration_state: Record<string, unknown>;
  regression_count: number;
  created_at: string;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  team_id: string | null;
  status: string;
  current_phase: number;
  priority: number;
  result: string | null;
  orchestration_state: string;
  regression_count: number;
  created_at: string;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    team_id: row.team_id,
    status: row.status as Task["status"],
    current_phase: row.current_phase,
    priority: row.priority,
    result: row.result ? JSON.parse(row.result) : null,
    orchestration_state: JSON.parse(row.orchestration_state),
    regression_count: row.regression_count,
    created_at: row.created_at,
    approved_at: row.approved_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    updated_at: row.updated_at,
  };
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  teamId?: string;
  priority?: number;
}

export interface UpdateTaskInput {
  title: string;
  description?: string;
  teamId?: string;
  priority?: number;
}

export class TaskScheduler {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDb();
  }

  createTask(input: CreateTaskInput): Task {
    const id = crypto.randomUUID();
    const priority = input.priority ?? 5;

    if (priority < 1 || priority > 10) {
      throw new Error("Priority must be between 1 and 10");
    }

    this.db
      .prepare(
        `INSERT INTO tasks (id, title, description, team_id, priority)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.title, input.description ?? null, input.teamId ?? null, priority);

    return this.getTask(id)!;
  }

  getTask(id: string): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id) as TaskRow | null;
    return row ? rowToTask(row) : null;
  }

  listTasks(): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks ORDER BY priority ASC, created_at ASC")
      .all() as TaskRow[];
    return rows.map(rowToTask);
  }

  updateTask(id: string, input: UpdateTaskInput): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status !== "draft") {
      throw new Error(`Can only edit draft tasks, current status: ${task.status}`);
    }

    const priority = input.priority ?? task.priority;
    if (priority < 1 || priority > 10) {
      throw new Error("Priority must be between 1 and 10");
    }

    this.db
      .prepare(
        `UPDATE tasks
         SET title = ?, description = ?, team_id = ?, priority = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        input.title.trim(),
        input.description?.trim() ? input.description.trim() : null,
        input.teamId?.trim() ? input.teamId.trim() : null,
        priority,
        id,
      );

    return this.getTask(id)!;
  }

  approveTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status !== "draft") {
      throw new Error(`Can only approve draft tasks, current status: ${task.status}`);
    }
    if (!task.team_id) {
      throw new Error("Task must have a team assigned before approval");
    }

    this.db
      .prepare(
        `UPDATE tasks SET status = 'approved', approved_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(id);

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "draft",
      newStatus: "approved",
    });
    return updated;
  }

  startTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status !== "approved") {
      throw new Error(`Can only start approved tasks, current status: ${task.status}`);
    }

    this.db
      .prepare(
        `UPDATE tasks SET status = 'running', started_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(id);

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "approved",
      newStatus: "running",
    });
    return updated;
  }

  completeTask(id: string, result?: unknown): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status !== "running") {
      throw new Error(`Can only complete running tasks, current status: ${task.status}`);
    }

    this.db
      .prepare(
        `UPDATE tasks SET status = 'completed', result = ?, completed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(result ? JSON.stringify(result) : null, id);

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "running",
      newStatus: "completed",
    });
    return updated;
  }

  failTask(id: string, error?: string): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status !== "running") {
      throw new Error(`Can only fail running tasks, current status: ${task.status}`);
    }

    const result = error ? JSON.stringify({ error }) : null;

    this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', result = ?, completed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(result, id);

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "running",
      newStatus: "failed",
    });
    return updated;
  }

  retryTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status !== "failed") {
      throw new Error(`Can only retry failed tasks, current status: ${task.status}`);
    }

    this.db
      .prepare(
        `UPDATE tasks SET status = 'draft', current_phase = 0, result = NULL, regression_count = 0,
         started_at = NULL, completed_at = NULL, approved_at = NULL, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(id);

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "failed",
      newStatus: "draft",
    });
    return updated;
  }

  cancelTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status === "completed" || task.status === "failed") {
      throw new Error(`Cannot cancel a ${task.status} task`);
    }

    const previousStatus = task.status;

    this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', result = ?, completed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(JSON.stringify({ error: "Cancelled by user" }), id);

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus,
      newStatus: "failed",
    });
    return updated;
  }

  getNextApprovedTask(): Task | null {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status = 'approved' ORDER BY priority ASC, created_at ASC LIMIT 1",
      )
      .get() as TaskRow | null;
    return row ? rowToTask(row) : null;
  }

  advancePhase(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status !== "running") {
      throw new Error(`Can only advance phase on running tasks`);
    }

    this.db
      .prepare(
        `UPDATE tasks SET current_phase = current_phase + 1, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(id);

    return this.getTask(id)!;
  }

  regressPhase(id: string, targetPhase: number): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status !== "running") {
      throw new Error(`Can only regress phase on running tasks`);
    }
    if (targetPhase < 0 || targetPhase >= task.current_phase) {
      throw new Error(`Invalid target phase: ${targetPhase}`);
    }

    this.db
      .prepare(
        `UPDATE tasks SET current_phase = ?, regression_count = regression_count + 1, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(targetPhase, id);

    return this.getTask(id)!;
  }

  updateOrchestrationState(id: string, key: string, value: unknown): void {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);

    const state = { ...task.orchestration_state, [key]: value };

    this.db
      .prepare(
        `UPDATE tasks SET orchestration_state = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(JSON.stringify(state), id);
  }

  cleanupStaleState(): void {
    // Reset any tasks stuck in 'running' state on startup
    this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', result = ?, completed_at = datetime('now'), updated_at = datetime('now')
         WHERE status = 'running'`,
      )
      .run(JSON.stringify({ error: "Server restart - task was running" }));
  }
}
