import type { Database } from "bun:sqlite";
import { parseJsonOr } from "../db/json";
import { getDb } from "../db/connection";
import { eventBus } from "../events/bus";
import { logError } from "../logging";

export type TaskType = "standard" | "real_time";

export interface PhaseOverride {
  review?: boolean;
  consensus?: import("../teams/manager").ConsensusConfig | null;
}

export interface RealtimeTaskConfig {
  window_seconds?: number;
  summary_cadence_seconds?: number;
  trigger_min_confidence?: number;
  max_pending_windows?: number;
  transcription_command?: string;
  transcription_args?: string[];
  phase_overrides?: Record<string, PhaseOverride>;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  team_id: string | null;
  working_directory: string;
  status: "draft" | "approved" | "running" | "paused" | "completed" | "failed";
  current_phase: number;
  result: unknown | null;
  orchestration_state: Record<string, unknown>;
  regression_count: number;
  iteration_count: number;
  needs_review: boolean;
  task_type: TaskType;
  task_config: RealtimeTaskConfig;
  source_scheduled_task_id: string | null;
  run_input: string | null;
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
  working_directory: string;
  status: string;
  current_phase: number;
  result: string | null;
  orchestration_state: string;
  regression_count: number;
  iteration_count: number;
  needs_review: number;
  task_type: string;
  task_config: string;
  source_scheduled_task_id: string | null;
  run_input: string | null;
  created_at: string;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  const taskConfig = parseJsonOr<RealtimeTaskConfig>(row.task_config, {});

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    team_id: row.team_id,
    working_directory: row.working_directory ?? "",
    status: row.status as Task["status"],
    current_phase: row.current_phase,
    result: row.result ? JSON.parse(row.result) : null,
    orchestration_state: JSON.parse(row.orchestration_state),
    regression_count: row.regression_count,
    iteration_count: row.iteration_count ?? 0,
    needs_review: !!(row.needs_review ?? 0),
    task_type: (row.task_type as TaskType) ?? "standard",
    task_config: taskConfig,
    source_scheduled_task_id: row.source_scheduled_task_id ?? null,
    run_input: row.run_input ?? null,
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
  workingDirectory: string;
  taskType?: TaskType;
  taskConfig?: RealtimeTaskConfig;
}

export interface UpdateTaskInput {
  title: string;
  description?: string;
  teamId?: string;
  workingDirectory?: string;
  taskType?: TaskType;
  taskConfig?: RealtimeTaskConfig;
}

export class TaskScheduler {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDb();
  }

  createTask(input: CreateTaskInput): Task {
    const id = crypto.randomUUID();
    const taskType = input.taskType ?? "standard";
    const taskConfig = input.taskConfig ? JSON.stringify(input.taskConfig) : "{}";
    const workingDirectory = input.workingDirectory || process.cwd();

    this.db
      .prepare(
        `INSERT INTO tasks (id, title, description, team_id, working_directory, task_type, task_config)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.title, input.description ?? null, input.teamId ?? null, workingDirectory, taskType, taskConfig);

    eventBus.emit("task:created", { taskId: id });

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
      .prepare("SELECT * FROM tasks ORDER BY created_at ASC, rowid ASC")
      .all() as TaskRow[];
    return rows.map(rowToTask);
  }

  private requireTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  /** Guard shared by every lifecycle transition: task exists and is in `status`. */
  private requireTaskStatus(id: string, status: Task["status"], action: string): Task {
    const task = this.requireTask(id);
    if (task.status !== status) {
      throw new Error(`Can only ${action}, current status: ${task.status}`);
    }
    return task;
  }

  updateTask(id: string, input: UpdateTaskInput): Task {
    const task = this.requireTaskStatus(id, "draft", "edit draft tasks");

    const taskType = input.taskType ?? task.task_type;
    const taskConfig = input.taskConfig ? JSON.stringify(input.taskConfig) : JSON.stringify(task.task_config);

    const workingDirectory = input.workingDirectory?.trim() ?? task.working_directory;

    this.db
      .prepare(
        `UPDATE tasks
         SET title = ?, description = ?, team_id = ?, working_directory = ?, task_type = ?, task_config = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        input.title.trim(),
        input.description?.trim() ? input.description.trim() : null,
        input.teamId?.trim() ? input.teamId.trim() : null,
        workingDirectory,
        taskType,
        taskConfig,
        id,
      );

    return this.getTask(id)!;
  }

  approveTask(id: string): Task {
    const task = this.requireTaskStatus(id, "draft", "approve draft tasks");
    if (task.task_type !== "real_time" && !task.team_id) {
      throw new Error("Task must have a team assigned before approval");
    }

    const changes = this.db
      .prepare(
        `UPDATE tasks SET status = 'approved', approved_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND status = 'draft'`,
      )
      .run(id).changes;

    if (changes === 0) {
      throw new Error(`Task ${id} was concurrently modified`);
    }

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "draft",
      newStatus: "approved",
    });
    return updated;
  }

  unapproveTask(id: string): Task {
    this.requireTaskStatus(id, "approved", "unapprove approved tasks");

    const changes = this.db
      .prepare(
        `UPDATE tasks SET status = 'draft', approved_at = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'approved'`,
      )
      .run(id).changes;

    if (changes === 0) {
      throw new Error(`Task ${id} was concurrently modified`);
    }

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "approved",
      newStatus: "draft",
    });
    return updated;
  }

  deleteTask(id: string): boolean {
    const task = this.requireTask(id);
    if (task.status === "running") {
      throw new Error("Cannot delete a running task");
    }

    const previousStatus = task.status;

    this.db.transaction(() => {
      // Collect every agent instance ID that ran under this task — terminal
      // outputs, sessions, state rows, and stuck-detection logs are keyed by
      // agent_id (the runtime instance UUID) with no FK to tasks, so they
      // need explicit cleanup before the agent_instances cascade fires.
      const instanceRows = this.db
        .prepare("SELECT id FROM agent_instances WHERE task_id = ?")
        .all(id) as { id: string }[];
      const instanceIds = instanceRows.map((r) => r.id);

      if (instanceIds.length > 0) {
        const placeholders = instanceIds.map(() => "?").join(",");
        // terminal_outputs.session_id has ON DELETE CASCADE to agent_sessions,
        // so deleting sessions first will sweep the matching outputs. The
        // direct agent_id delete below catches anything orphaned.
        this.db.prepare(`DELETE FROM agent_sessions WHERE agent_id IN (${placeholders})`).run(...instanceIds);
        this.db.prepare(`DELETE FROM terminal_outputs WHERE agent_id IN (${placeholders})`).run(...instanceIds);
        this.db.prepare(`DELETE FROM stuck_detection_logs WHERE agent_id IN (${placeholders})`).run(...instanceIds);
        this.db.prepare(`DELETE FROM agent_states WHERE agent_id IN (${placeholders})`).run(...instanceIds);
        this.db.prepare(`DELETE FROM agent_note_receipts WHERE agent_instance_id IN (${placeholders})`).run(...instanceIds);
      }

      // Remove non-cascading task references first.
      this.db.prepare("DELETE FROM delegations WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM escalations WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM events WHERE task_id = ?").run(id);

      // Clear any stale pointer from agents table.
      this.db.prepare("UPDATE agents SET current_task_id = NULL WHERE current_task_id = ?").run(id);

      // Delete task (cascades to checkpoints/instances/groups/notes/etc).
      this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    })();

    eventBus.emit("task:state_changed", { taskId: id, previousStatus, newStatus: "deleted" });

    return true;
  }

  startTask(id: string): Task {
    this.requireTaskStatus(id, "approved", "start approved tasks");

    const changes = this.db
      .prepare(
        `UPDATE tasks SET status = 'running', started_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND status = 'approved'`,
      )
      .run(id).changes;

    if (changes === 0) {
      throw new Error(`Task ${id} was concurrently modified`);
    }

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "approved",
      newStatus: "running",
    });
    return updated;
  }

  completeTask(id: string, result?: unknown): Task {
    const task = this.requireTaskStatus(id, "running", "complete running tasks");

    // Instrumentation: log the call site of every completeTask so we can
    // identify which path completed a task when something looks wrong
    // (e.g. a phase getting skipped because the task was completed earlier
    // than expected). Stack trace is captured cheaply via new Error().stack.
    logError(
      this.db,
      "task_complete_callsite",
      { taskId: id, currentPhase: task.current_phase, hasResult: result !== undefined },
      new Error("completeTask invoked"),
    );

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE tasks SET status = 'completed', needs_review = 0, result = ?, completed_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(result ? JSON.stringify(result) : null, id);
      this.finalizeTaskRuntime(id, {
        instanceStatus: "completed",
        delegationStatus: "completed",
        delegationActiveStatuses: ["running", "waiting_delegation", "pending"],
        delegationResult: "(auto-closed: task completed before delegation settled)",
        clearAgentPointer: true,
        escalationResponse: "Auto-resolved: task completed.",
      });
    })();

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "running",
      newStatus: "completed",
    });
    return updated;
  }

  failTask(id: string, error?: string): Task {
    this.requireTaskStatus(id, "running", "fail running tasks");

    const result = error ? JSON.stringify({ error }) : null;

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE tasks SET status = 'failed', needs_review = 0, result = ?, completed_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(result, id);
      this.finalizeTaskRuntime(id, {
        instanceStatus: "failed",
        delegationStatus: "failed",
        delegationActiveStatuses: ["pending", "running"],
        delegationResult: "Task cancelled before delegation settled",
        clearAgentPointer: true,
        escalationResponse: "Auto-resolved: task failed.",
      });
    })();

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "running",
      newStatus: "failed",
    });
    return updated;
  }

  retryTask(id: string): Task {
    this.requireTaskStatus(id, "failed", "retry failed tasks");
    this.resetTaskRuntimeData(id);

    this.db
      .prepare(
        `UPDATE tasks SET status = 'draft', current_phase = 0, needs_review = 0, result = NULL, regression_count = 0,
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

  resumeTask(id: string): Task {
    this.requireTaskStatus(id, "failed", "resume failed tasks");
    // Resume MUST keep notes, escalations, checkpoints, and events — the
    // resumed Skipper relies on them (and on the artifact list) to figure
    // out what was already done. retryTask still wipes them for a clean
    // start from phase 0.
    this.resetTaskRuntimeData(id, { preserveContext: true });

    this.db
      .prepare(
        `UPDATE tasks
         SET status = 'approved', needs_review = 0, result = NULL, approved_at = datetime('now'),
             started_at = NULL, completed_at = NULL, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(id);

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "failed",
      newStatus: "approved",
    });
    return updated;
  }

  iterateTask(id: string, additionalInput: string): Task {
    const task = this.requireTaskStatus(id, "completed", "iterate completed tasks");
    if (!additionalInput.trim()) {
      throw new Error("Additional input is required for iteration");
    }

    const newIteration = (task.iteration_count ?? 0) + 1;

    if (task.result) {
      // Find a valid agent_id to attribute the note to (entrypoint or first team member)
      const noteAgent = this.db.prepare(
        `SELECT COALESCE(t.entrypoint_agent_id, (SELECT agent_id FROM team_agents WHERE team_id = t.id LIMIT 1))
         AS agent_id FROM teams t WHERE t.id = (SELECT team_id FROM tasks WHERE id = ?)`,
      ).get(id) as { agent_id: string | null } | null;

      if (noteAgent?.agent_id) {
        const resultSummary = typeof task.result === "string"
          ? task.result.substring(0, 2000)
          : JSON.stringify(task.result).substring(0, 2000);
        this.db.prepare(
          `INSERT INTO task_notes (id, task_id, agent_id, content, created_at)
           VALUES (?, ?, ?, ?, datetime('now'))`,
        ).run(
          crypto.randomUUID(),
          id,
          noteAgent.agent_id,
          `[Iteration ${task.iteration_count ?? 0} result] ${resultSummary}`,
        );
      }
    }

    const separator = `\n\n---\nITERATION ${newIteration} (${new Date().toISOString()}):\n`;
    const newDescription = (task.description ?? "") + separator + additionalInput;

    this.db.transaction(() => {
      // Clear stale checkpoints only (not notes, not instances, not delegations)
      this.db.prepare("DELETE FROM task_checkpoints WHERE task_id = ?").run(id);

      this.db.prepare(
        `UPDATE tasks SET
           status = 'approved',
           description = ?,
           current_phase = 0,
           result = NULL,
           orchestration_state = '{}',
           regression_count = 0,
           iteration_count = ?,
           approved_at = datetime('now'),
           started_at = NULL,
           completed_at = NULL,
           updated_at = datetime('now')
         WHERE id = ?`,
      ).run(newDescription, newIteration, id);

      this.db.prepare(
        `UPDATE agents SET current_task_id = NULL
         WHERE current_task_id = ?`,
      ).run(id);

      // Detach ONLY the root Skipper's session so the next spawn starts a
      // fresh conversation. Resuming a completed root carries forward "task is
      // done, we're in Cleanup" context and confuses the new iteration's phase
      // boundaries (Skipper would make code changes itself or delegate to Coder
      // during Planning). Delegated children (parent_instance_id IS NOT NULL)
      // keep their session_id so they stay resumable — the new iteration's
      // Skipper can choose delegate_resume (continue a worker's conversation)
      // vs delegate (fresh child) per the PRIOR DELEGATIONS menu.
      // Notes, artifacts, and delegation rows stay intact for context.
      this.db.prepare(
        `UPDATE agent_instances SET session_id = NULL
         WHERE task_id = ? AND parent_instance_id IS NULL AND session_id IS NOT NULL`,
      ).run(id);
    })();

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "completed",
      newStatus: "approved",
    });
    return updated;
  }

  cancelTask(id: string): Task {
    const task = this.requireTask(id);
    if (task.status === "completed" || task.status === "failed") {
      throw new Error(`Cannot cancel a ${task.status} task`);
    }

    const previousStatus = task.status;

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE tasks SET status = 'failed', needs_review = 0, result = ?, completed_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(JSON.stringify({ error: "Cancelled by user" }), id);
      this.finalizeTaskRuntime(id, {
        instanceStatus: "failed",
        delegationStatus: "failed",
        delegationActiveStatuses: ["pending", "running"],
        delegationResult: "Task failed before delegation settled",
        clearAgentPointer: false,
        escalationResponse: "Auto-resolved: task cancelled.",
      });
    })();

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus,
      newStatus: "failed",
    });
    return updated;
  }

  // Pause a running task: flips status running→paused (the daemon stops the
  // agents + their process trees separately). Open delegations are reconciled to
  // a terminal state so the resumed root re-drives delegation fresh. Escalations
  // and result are deliberately left intact — this is NOT a terminal cancel.
  pauseTask(id: string): Task {
    this.requireTaskStatus(id, "running", "pause a running task");

    let changed = 0;
    this.db.transaction(() => {
      changed = this.db
        .prepare(
          "UPDATE tasks SET status = 'paused', updated_at = datetime('now') WHERE id = ? AND status = 'running'",
        )
        .run(id).changes;
      if (changed === 0) return; // raced to a terminal state; leave delegations alone
      this.db
        .prepare(
          `UPDATE delegations
           SET status = CASE WHEN status IN ('pending', 'running') THEN 'failed' ELSE status END,
               completed_at = COALESCE(completed_at, datetime('now')),
               result = COALESCE(result, 'Task paused before delegation settled')
           WHERE task_id = ?`,
        )
        .run(id);
      this.db
        .prepare(
          "UPDATE delegation_groups SET status = 'completed', completed_at = datetime('now') WHERE task_id = ? AND status = 'running'",
        )
        .run(id);
    })();

    if (changed === 0) {
      throw new Error("Task is no longer running");
    }

    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "running",
      newStatus: "paused",
    });
    return this.getTask(id)!;
  }

  // Resume a paused task: flips status paused→running (the daemon respawns the
  // snapshotted agents with --resume separately).
  resumeFromPause(id: string): Task {
    this.requireTaskStatus(id, "paused", "resume a paused task");

    const changed = this.db
      .prepare(
        "UPDATE tasks SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'paused'",
      )
      .run(id).changes;
    if (changed === 0) {
      throw new Error("Task is no longer paused");
    }

    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "paused",
      newStatus: "running",
    });
    return this.getTask(id)!;
  }

  getNextApprovedTask(): Task | null {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status = 'approved' AND task_type != 'real_time' ORDER BY created_at ASC LIMIT 1",
      )
      .get() as TaskRow | null;
    return row ? rowToTask(row) : null;
  }

  advancePhase(id: string): Task {
    const task = this.requireTask(id);
    if (task.status !== "running") {
      throw new Error(`Can only advance phase on running tasks`);
    }

    if (task.team_id) {
      const teamRow = this.db
        .prepare("SELECT phases FROM teams WHERE id = ?")
        .get(task.team_id) as { phases: string } | null;
      if (teamRow) {
        const phases = JSON.parse(teamRow.phases) as unknown[];
        if (phases.length > 0 && task.current_phase >= phases.length - 1) {
          throw new Error(`Cannot advance phase: already at last phase (${task.current_phase})`);
        }
      }
    }

    this.db
      .prepare(
        `UPDATE tasks SET current_phase = current_phase + 1, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(id);

    eventBus.emit("task:phase_changed", {
      taskId: id,
      previousPhase: task.current_phase,
      newPhase: task.current_phase + 1,
      direction: "advance",
    });

    return this.getTask(id)!;
  }

  setNeedsReview(id: string, value: boolean, phaseContext?: { phaseName: string; phaseIndex: number }): Task {
    const task = this.requireTask(id);
    if (task.status !== "running") {
      throw new Error(`Can only set review on running tasks`);
    }

    this.db
      .prepare(
        `UPDATE tasks SET needs_review = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(value ? 1 : 0, id);

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "running",
      newStatus: "running",
    });
    eventBus.emit("task:needs_review_changed", {
      taskId: id,
      needsReview: value,
      ...phaseContext,
    });
    return updated;
  }

  regressPhase(id: string, targetPhase: number): Task {
    const task = this.requireTask(id);
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

    eventBus.emit("task:phase_changed", {
      taskId: id,
      previousPhase: task.current_phase,
      newPhase: targetPhase,
      direction: "regress",
    });

    return this.getTask(id)!;
  }

  updateOrchestrationState(id: string, key: string, value: unknown): void {
    const task = this.requireTask(id);

    const state = { ...task.orchestration_state, [key]: value };

    this.db
      .prepare(
        `UPDATE tasks SET orchestration_state = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(JSON.stringify(state), id);
  }

  /**
   * Kills any live processes for the task and resets per-instance runtime
   * state. By default also wipes accumulated context (notes, escalations,
   * events, checkpoints) — that's what retry wants. Pass `preserveContext`
   * to keep that context intact, which is what resume needs: the resumed
   * Skipper reads prior notes/escalations/checkpoints to figure out where
   * the previous attempt left off.
   */
  private resetTaskRuntimeData(taskId: string, options: { preserveContext?: boolean } = {}): void {
    const instancePids = this.db
      .prepare(
        `SELECT process_pid
         FROM agent_instances
         WHERE task_id = ?
           AND process_pid IS NOT NULL
           AND status IN ('running', 'waiting_delegation', 'pending')`,
      )
      .all(taskId) as Array<{ process_pid: number | null }>;
    const agentPids = this.db
      .prepare(
        `SELECT process_pid
         FROM agents
         WHERE current_task_id = ?
           AND process_pid IS NOT NULL`,
      )
      .all(taskId) as Array<{ process_pid: number | null }>;

    for (const row of [...instancePids, ...agentPids]) {
      if (row.process_pid) this.terminateProcess(row.process_pid);
    }

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE agent_instances
           SET status = CASE WHEN status IN ('running', 'waiting_delegation', 'pending') THEN 'failed' ELSE status END,
               process_pid = NULL,
               updated_at = datetime('now')
           WHERE task_id = ?`,
        )
        .run(taskId);
      this.db
        .prepare(
          `UPDATE agents
           SET current_task_id = NULL,
               process_pid = NULL,
               status = CASE WHEN status = 'busy' THEN 'idle' ELSE status END,
               updated_at = datetime('now')
           WHERE current_task_id = ?`,
        )
        .run(taskId);
      if (!options.preserveContext) {
        this.db
          .prepare("DELETE FROM task_checkpoints WHERE task_id = ?")
          .run(taskId);
        this.db
          .prepare("DELETE FROM task_notes WHERE task_id = ?")
          .run(taskId);
        this.db
          .prepare("DELETE FROM escalations WHERE task_id = ?")
          .run(taskId);
        this.db
          .prepare("DELETE FROM events WHERE task_id = ?")
          .run(taskId);
      }
    })();
  }

  private terminateProcess(pid: number): void {
    try {
      process.kill(pid, 9);
    } catch {
      // Ignore missing/dead PID errors while cleaning stale runtime state.
    }
  }

  cleanupStaleState(): void {
    // Reset any tasks stuck in 'running' state on startup
    this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', result = ?, completed_at = datetime('now'), updated_at = datetime('now')
         WHERE status = 'running'`,
      )
      .run(JSON.stringify({ error: "Server restart - task was running" }));

    this.db
      .prepare(
        `UPDATE escalations
         SET status = 'resolved',
             response = COALESCE(response, 'Auto-resolved: task is no longer running.'),
             resolved_at = datetime('now')
         WHERE status = 'open'
           AND task_id IN (
             SELECT id FROM tasks WHERE status != 'running'
           )`,
      )
      .run();
  }

  /**
   * Close out live instances, delegations, and delegation groups when a task
   * reaches a terminal state. Runs inside the caller's transaction. The
   * delegation active-status sets and result messages differ per transition
   * and are preserved verbatim from the original per-method SQL.
   */
  private finalizeTaskRuntime(
    id: string,
    opts: {
      instanceStatus: "completed" | "failed";
      delegationStatus: "completed" | "failed";
      delegationActiveStatuses: readonly ("pending" | "running" | "waiting_delegation")[];
      delegationResult: string;
      clearAgentPointer: boolean;
      escalationResponse: string;
    },
  ): void {
    const activeIn = opts.delegationActiveStatuses.map((s) => `'${s}'`).join(", ");
    this.db
      .prepare(
        `UPDATE agent_instances
         SET status = CASE WHEN status IN ('running', 'waiting_delegation', 'pending') THEN '${opts.instanceStatus}' ELSE status END,
             updated_at = datetime('now')
         WHERE task_id = ?`,
      )
      .run(id);
    this.db
      .prepare(
        `UPDATE delegations
         SET status = CASE WHEN status IN (${activeIn}) THEN '${opts.delegationStatus}' ELSE status END,
             completed_at = COALESCE(completed_at, datetime('now')),
             result = COALESCE(result, ?)
         WHERE task_id = ?`,
      )
      .run(opts.delegationResult, id);
    this.db
      .prepare(
        "UPDATE delegation_groups SET status = 'completed', completed_at = datetime('now') WHERE task_id = ? AND status = 'running'",
      )
      .run(id);
    if (opts.clearAgentPointer) {
      this.db
        .prepare("UPDATE agents SET current_task_id = NULL WHERE current_task_id = ?")
        .run(id);
    }
    this.resolveOpenEscalationsForTask(id, opts.escalationResponse);
  }

  private resolveOpenEscalationsForTask(taskId: string, response: string): void {
    this.db
      .prepare(
        `UPDATE escalations
         SET status = 'resolved',
             response = COALESCE(response, ?),
             resolved_at = datetime('now')
         WHERE task_id = ? AND status = 'open'`,
      )
      .run(response, taskId);
  }
}
