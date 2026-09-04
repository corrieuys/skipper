import type { Database } from "bun:sqlite";
import { removeTaskArtifactFiles } from "../orchestrator/artifact-files";
import { parseJsonOr } from "../db/json";
import { getDb } from "../db/connection";
import { eventBus } from "../events/bus";
import { logError } from "../logging";

// workflow: the system drives the task to the end of its phases (pokes, recovery).
// conversational: the user drives via input; idle is the normal resting state.
// Both modes support phases, review gates, regression, escalation, delegation.
export type TaskMode = "workflow" | "conversational";

// draft: editable, not live. active: live (queued / working / idle / paused —
// derived, see getRuntimeState). settled: terminal, user-initiated only.
export type TaskStatus = "draft" | "active" | "settled";

// Derived presentation of an active task's current runtime situation.
export type TaskRuntimeState = "paused" | "blocked" | "review" | "working" | "queued" | "idle";

export interface PhaseOverride {
  review?: boolean;
}

// Per-task config JSON (tasks.task_config). Input-pipeline knobs apply to every
// task (audio input is always available); most are optional overrides of the
// global transcription settings.
export interface TaskConfig {
  window_seconds?: number;
  summary_cadence_seconds?: number;
  trigger_min_confidence?: number;
  max_pending_windows?: number;
  transcription_command?: string;
  transcription_args?: string[];
  phase_overrides?: Record<string, PhaseOverride>;
  /** Agent that condenses transcribed audio into timeline summaries. */
  summarizer_agent_id?: string;
  /** Extra delegation-eligible agents beyond the team roster. */
  assigned_agent_ids?: string[];
}

/** @deprecated transitional alias — realtime tasks merged into the unified model. */
export type RealtimeTaskConfig = TaskConfig;

export interface Task {
  id: string;
  title: string;
  description: string | null;
  team_id: string | null;
  working_directory: string;
  status: TaskStatus;
  mode: TaskMode;
  /** Derived from mode: workflow = autopilot on (system drives), conversational = off (operator drives). */
  autopilot: boolean;
  paused: boolean;
  current_phase: number;
  result: unknown | null;
  orchestration_state: Record<string, unknown>;
  regression_count: number;
  needs_review: boolean;
  task_config: TaskConfig;
  source_scheduled_task_id: string | null;
  run_input: string | null;
  wake_requested_at: string | null;
  created_at: string;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  settled_at: string | null;
  updated_at: string;
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  team_id: string | null;
  working_directory: string;
  status: string;
  mode: string;
  paused: number;
  current_phase: number;
  result: string | null;
  orchestration_state: string;
  regression_count: number;
  needs_review: number;
  task_config: string;
  source_scheduled_task_id: string | null;
  run_input: string | null;
  wake_requested_at: string | null;
  created_at: string;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  settled_at: string | null;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  const taskConfig = parseJsonOr<TaskConfig>(row.task_config, {});

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    team_id: row.team_id,
    working_directory: row.working_directory ?? "",
    status: row.status as TaskStatus,
    mode: (row.mode as TaskMode) ?? "workflow",
    autopilot: ((row.mode as TaskMode) ?? "workflow") === "workflow",
    paused: !!(row.paused ?? 0),
    current_phase: row.current_phase,
    result: row.result ? JSON.parse(row.result) : null,
    orchestration_state: JSON.parse(row.orchestration_state),
    regression_count: row.regression_count,
    needs_review: !!(row.needs_review ?? 0),
    task_config: taskConfig,
    source_scheduled_task_id: row.source_scheduled_task_id ?? null,
    run_input: row.run_input ?? null,
    wake_requested_at: row.wake_requested_at ?? null,
    created_at: row.created_at,
    approved_at: row.approved_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    settled_at: row.settled_at ?? null,
    updated_at: row.updated_at,
  };
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  teamId?: string;
  workingDirectory: string;
  mode?: TaskMode;
  taskConfig?: TaskConfig;
}

export interface UpdateTaskInput {
  title: string;
  description?: string;
  teamId?: string;
  workingDirectory?: string;
  mode?: TaskMode;
  taskConfig?: TaskConfig;
}

const LIVE_INSTANCE_STATUSES = "('running', 'waiting_delegation', 'pending')";

export class TaskScheduler {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDb();
  }

  createTask(input: CreateTaskInput): Task {
    const id = crypto.randomUUID();
    const mode = input.mode ?? "workflow";
    const taskConfig = input.taskConfig ? JSON.stringify(input.taskConfig) : "{}";
    const workingDirectory = input.workingDirectory || process.cwd();

    this.db
      .prepare(
        `INSERT INTO tasks (id, title, description, team_id, working_directory, mode, task_config)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.title, input.description ?? null, input.teamId ?? null, workingDirectory, mode, taskConfig);

    eventBus.emit("task:created", { taskId: id });

    return this.getTask(id)!;
  }

  /**
   * Update just the task title. Used by the async title generator that runs after
   * create when the title was left blank. Emits a same-status `task:state_changed`
   * so the UI title fragments refresh and Connect ships a fat task projection
   * carrying the new title, without the workspace teardown a real status change
   * would trigger (ui-push only re-runs the heavy refresh when the status
   * actually changes).
   */
  updateTitle(id: string, title: string): void {
    const task = this.getTask(id);
    if (!task) return;
    this.db
      .prepare("UPDATE tasks SET title = ?, updated_at = datetime('now') WHERE id = ?")
      .run(title, id);
    eventBus.emit("task:state_changed", { taskId: id, previousStatus: task.status, newStatus: task.status });
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
  private requireTaskStatus(id: string, status: TaskStatus, action: string): Task {
    const task = this.requireTask(id);
    if (task.status !== status) {
      throw new Error(`Can only ${action}, current status: ${task.status}`);
    }
    return task;
  }

  /** True when any agent instance for the task is live. */
  hasLiveInstances(id: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM agent_instances WHERE task_id = ? AND status IN ${LIVE_INSTANCE_STATUSES} LIMIT 1`,
      )
      .get(id);
    return !!row;
  }

  /**
   * Derive the presentation state of a task's runtime. Only meaningful for
   * active tasks; draft/settled callers should render the status itself.
   * Order matters: paused > blocked (open escalation) > review > working
   * (live agents or open delegations) > queued (wake pending / never started)
   * > idle.
   */
  getRuntimeState(id: string): TaskRuntimeState {
    const task = this.requireTask(id);
    if (task.paused) return "paused";
    const openEscalation = this.db
      .prepare("SELECT 1 FROM escalations WHERE task_id = ? AND status = 'open' LIMIT 1")
      .get(id);
    if (openEscalation) return "blocked";
    if (task.needs_review) return "review";
    if (this.hasLiveInstances(id)) return "working";
    const openDelegation = this.db
      .prepare("SELECT 1 FROM delegations WHERE task_id = ? AND status IN ('pending', 'running') LIMIT 1")
      .get(id);
    if (openDelegation) return "working";
    if (task.wake_requested_at || !task.started_at) return "queued";
    return "idle";
  }

  updateTask(id: string, input: UpdateTaskInput): Task {
    const task = this.requireTaskStatus(id, "draft", "edit draft tasks");

    const mode = input.mode ?? task.mode;
    const taskConfig = input.taskConfig ? JSON.stringify(input.taskConfig) : JSON.stringify(task.task_config);

    const workingDirectory = input.workingDirectory?.trim() ?? task.working_directory;

    this.db
      .prepare(
        `UPDATE tasks
         SET title = ?, description = ?, team_id = ?, working_directory = ?, mode = ?, task_config = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        input.title.trim(),
        input.description?.trim() ? input.description.trim() : null,
        input.teamId?.trim() ? input.teamId.trim() : null,
        workingDirectory,
        mode,
        taskConfig,
        id,
      );

    return this.getTask(id)!;
  }

  /** draft -> active. The wake marker queues the first start. */
  approveTask(id: string): Task {
    const task = this.requireTaskStatus(id, "draft", "approve draft tasks");
    if (task.mode !== "conversational" && !task.team_id) {
      throw new Error("Task must have a team assigned before approval");
    }

    const changes = this.db
      .prepare(
        `UPDATE tasks SET status = 'active', approved_at = datetime('now'), wake_requested_at = datetime('now'), updated_at = datetime('now')
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
      newStatus: "active",
    });
    return updated;
  }

  /** active -> draft. Only before the first run has started. */
  unapproveTask(id: string): Task {
    const task = this.requireTaskStatus(id, "active", "unapprove active tasks");
    if (task.started_at || this.hasLiveInstances(id)) {
      throw new Error("Cannot unapprove a task that has already started");
    }

    const changes = this.db
      .prepare(
        `UPDATE tasks SET status = 'draft', approved_at = NULL, wake_requested_at = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'active' AND started_at IS NULL`,
      )
      .run(id).changes;

    if (changes === 0) {
      throw new Error(`Task ${id} was concurrently modified`);
    }

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "active",
      newStatus: "draft",
    });
    return updated;
  }

  deleteTask(id: string): boolean {
    const task = this.requireTask(id);
    if (this.hasLiveInstances(id)) {
      throw new Error("Cannot delete a task with live agents; cancel or stop it first");
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
      this.db.prepare("DELETE FROM task_messages WHERE task_id = ?").run(id);

      // Clear any stale pointer from agents table.
      this.db.prepare("UPDATE agents SET current_task_id = NULL WHERE current_task_id = ?").run(id);

      // Delete task (cascades to checkpoints/instances/groups/notes/etc).
      this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    })();

    // File artifacts live outside the DB: sweep <data dir>/artifacts/<taskId>.
    removeTaskArtifactFiles(id);

    eventBus.emit("task:state_changed", { taskId: id, previousStatus, newStatus: "deleted" });

    return true;
  }

  /**
   * The queue picked this task: stamp started_at (first run only) and consume
   * the wake marker. Status does not change — active is active.
   */
  markStarted(id: string): Task {
    this.requireTaskStatus(id, "active", "start active tasks");

    this.db
      .prepare(
        `UPDATE tasks SET started_at = COALESCE(started_at, datetime('now')), wake_requested_at = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'active'`,
      )
      .run(id);

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "active",
      newStatus: "active",
    });
    return updated;
  }

  /**
   * Mark that input arrived for a task with no live root agent. The queue
   * (task-runner) starts or resumes the root when a concurrency slot frees.
   */
  requestWake(id: string): Task {
    this.requireTaskStatus(id, "active", "wake active tasks");

    this.db
      .prepare(
        `UPDATE tasks SET wake_requested_at = COALESCE(wake_requested_at, datetime('now')), updated_at = datetime('now')
         WHERE id = ? AND status = 'active'`,
      )
      .run(id);

    eventBus.emit("task:wake_requested", { taskId: id });
    return this.getTask(id)!;
  }

  /** Unfed input-pipeline entries pending delivery to the root agent. */
  private countUnfedInput(id: string): number {
    return (this.db
      .prepare("SELECT COUNT(*) AS c FROM realtime_timeline WHERE task_id = ? AND fed_to_skipper = 0")
      .get(id) as { c: number }).c;
  }

  /**
   * A run finished: the root completed the last phase or called complete_task.
   * The task settles to its resting state (stored `settled`, presented as
   * Completed) — new input revives it (inputTask auto-revives + wakes), so
   * "completed" is still not a dead end.
   */
  completeRun(id: string, result?: unknown): Task {
    const task = this.requireTaskStatus(id, "active", "complete a run on active tasks");
    // Operator input arrived during the run and was never delivered: do not
    // bury it under a settled task. Record the result but keep the task ACTIVE
    // with a pending wake, so the next run starts immediately and receives the
    // input as its INPUT_FEED.
    const pendingInput = this.countUnfedInput(id) > 0;

    // Instrumentation: log the call site of every completeRun so we can
    // identify which path finished a run when something looks wrong
    // (e.g. a phase getting skipped because the run was completed earlier
    // than expected). Stack trace is captured cheaply via new Error().stack.
    logError(
      this.db,
      "task_complete_callsite",
      { taskId: id, currentPhase: task.current_phase, hasResult: result !== undefined },
      new Error("completeRun invoked"),
    );

    this.db.transaction(() => {
      if (pendingInput) {
        this.db
          .prepare(
            `UPDATE tasks SET needs_review = 0, result = ?, wake_requested_at = datetime('now'),
               completed_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?`,
          )
          .run(result ? JSON.stringify(result) : null, id);
      } else {
        this.db
          .prepare(
            `UPDATE tasks SET status = 'settled', needs_review = 0, paused = 0, result = ?, wake_requested_at = NULL,
               completed_at = datetime('now'), settled_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?`,
          )
          .run(result ? JSON.stringify(result) : null, id);
      }
      this.finalizeTaskRuntime(id, {
        instanceStatus: "completed",
        delegationStatus: "completed",
        delegationActiveStatuses: ["running", "waiting_delegation", "pending"],
        delegationResult: "(auto-closed: run completed before delegation settled)",
        clearAgentPointer: true,
        escalationResponse: "Auto-resolved: run completed.",
      });
    })();

    const updated = this.getTask(id)!;
    eventBus.emit("task:run_completed", { taskId: id, result: result ?? null });
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "active",
      newStatus: pendingInput ? "active" : "settled",
    });
    if (pendingInput) {
      eventBus.emit("task:wake_requested", { taskId: id });
    }
    return updated;
  }

  /**
   * A run hit an unrecoverable error. The task settles to its resting state
   * (stored `settled`, presented as Failed): the error lands in result + a
   * note, and new input revives it (inputTask auto-revives + wakes).
   */
  failRun(id: string, error?: string): Task {
    this.requireTaskStatus(id, "active", "fail a run on active tasks");

    const result = error ? JSON.stringify({ error }) : null;
    // Same pending-input rule as completeRun: undelivered operator input keeps
    // the task active with a wake so the next run picks it up.
    const pendingInput = this.countUnfedInput(id) > 0;

    this.db.transaction(() => {
      if (pendingInput) {
        this.db
          .prepare(
            `UPDATE tasks SET needs_review = 0, result = ?, wake_requested_at = datetime('now'),
               completed_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?`,
          )
          .run(result, id);
      } else {
        this.db
          .prepare(
            `UPDATE tasks SET status = 'settled', needs_review = 0, paused = 0, result = ?, wake_requested_at = NULL,
               completed_at = datetime('now'), settled_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?`,
          )
          .run(result, id);
      }
      this.finalizeTaskRuntime(id, {
        instanceStatus: "failed",
        delegationStatus: "failed",
        delegationActiveStatuses: ["pending", "running"],
        delegationResult: "Run failed before delegation settled",
        clearAgentPointer: true,
        escalationResponse: "Auto-resolved: run failed.",
      });
    })();

    if (error) {
      // Best effort: the failure is already recorded in result; a missing team
      // entrypoint (deleted agent) must not turn the note insert into a throw.
      try {
        this.addExternalNote(id, `[system] Run failed: ${error}. Send new input to resume.`, "system");
      } catch {
        // note attribution failed — result carries the error regardless
      }
    }

    const updated = this.getTask(id)!;
    eventBus.emit("task:run_failed", { taskId: id, error: error ?? null });
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "active",
      newStatus: pendingInput ? "active" : "settled",
    });
    if (pendingInput) {
      eventBus.emit("task:wake_requested", { taskId: id });
    }
    return updated;
  }

  /**
   * active -> settled. The only terminal transition; always user-initiated
   * (cancel button, retention policy). Pass `error` for cancel-style
   * settles; pass `result` to preserve a final outcome.
   */
  settleTask(id: string, opts: { error?: string; result?: unknown } = {}): Task {
    this.requireTaskStatus(id, "active", "settle active tasks");

    const failed = opts.error !== undefined;
    const result = failed
      ? JSON.stringify({ error: opts.error })
      : opts.result !== undefined
        ? JSON.stringify(opts.result)
        : null;

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE tasks SET status = 'settled', needs_review = 0, paused = 0, wake_requested_at = NULL,
             result = COALESCE(?, result), settled_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ? AND status = 'active'`,
        )
        .run(result, id);
      this.finalizeTaskRuntime(id, {
        instanceStatus: failed ? "failed" : "completed",
        delegationStatus: failed ? "failed" : "completed",
        delegationActiveStatuses: ["pending", "running", "waiting_delegation"],
        delegationResult: "(auto-closed: task settled before delegation completed)",
        clearAgentPointer: true,
        escalationResponse: "Auto-resolved: task settled.",
      });
    })();

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "active",
      newStatus: "settled",
    });
    return updated;
  }

  /**
   * Toggle autopilot on a draft or active task. Autopilot on = the system
   * drives the task through its phases (pokes, recovery, auto-advance prompt);
   * off = the operator drives via input. Stored as mode workflow/conversational.
   */
  setAutopilot(id: string, on: boolean): Task {
    const task = this.requireTask(id);
    if (task.status === "settled") {
      throw new Error("Cannot change autopilot on a settled task; send input to revive it first");
    }
    this.db
      .prepare("UPDATE tasks SET mode = ?, updated_at = datetime('now') WHERE id = ?")
      .run(on ? "workflow" : "conversational", id);
    eventBus.emit("task:state_changed", { taskId: id, previousStatus: task.status, newStatus: task.status });
    return this.getTask(id)!;
  }

  /** settled -> active. New input auto-revives through this. */
  reviveTask(id: string): Task {
    this.requireTaskStatus(id, "settled", "revive settled tasks");

    const changes = this.db
      .prepare(
        `UPDATE tasks SET status = 'active', settled_at = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'settled'`,
      )
      .run(id).changes;

    if (changes === 0) {
      throw new Error(`Task ${id} was concurrently modified`);
    }

    const updated = this.getTask(id)!;
    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "settled",
      newStatus: "active",
    });
    return updated;
  }

  /**
   * Record a note authored outside the agent runtime — e.g. a human reply in the
   * task's originating Slack thread. Attributes it to the team's entrypoint agent
   * (or first team member) to satisfy the `task_notes.agent_id` FK; `source` marks
   * provenance. Returns the note id, or null if the task/agent can't be resolved or
   * the content is empty. Notes surface to the agent on its next prompt build.
   */
  addExternalNote(taskId: string, content: string, source: string = "user"): string | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const trimmed = content.trim();
    if (!trimmed) return null;
    if (!task.team_id) return null;
    const noteAgent = this.db.prepare(
      `SELECT COALESCE(t.entrypoint_agent_id, (SELECT agent_id FROM team_agents WHERE team_id = t.id LIMIT 1))
       AS agent_id FROM teams t WHERE t.id = ?`,
    ).get(task.team_id) as { agent_id: string | null } | null;
    const agentId = noteAgent?.agent_id;
    if (!agentId) return null;
    const noteId = crypto.randomUUID();
    this.db
      .prepare("INSERT INTO task_notes (id, task_id, agent_id, content, source) VALUES (?, ?, ?, ?, ?)")
      .run(noteId, taskId, agentId, trimmed, source);
    eventBus.emit("task:note_added", { noteId, taskId, agentId, content: trimmed });
    return noteId;
  }

  // Pause an active task: sets the paused flag (the daemon stops the agents +
  // their process trees separately). Open delegations are reconciled to a
  // terminal state so the resumed root re-drives delegation fresh. Escalations
  // and result are deliberately left intact — this does NOT settle the task.
  pauseTask(id: string): Task {
    const task = this.requireTaskStatus(id, "active", "pause an active task");
    if (task.paused) {
      throw new Error("Task is already paused");
    }

    let changed = 0;
    this.db.transaction(() => {
      changed = this.db
        .prepare(
          "UPDATE tasks SET paused = 1, updated_at = datetime('now') WHERE id = ? AND status = 'active' AND paused = 0",
        )
        .run(id).changes;
      if (changed === 0) return; // raced to a different state; leave delegations alone
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
      throw new Error("Task is no longer active");
    }

    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "active",
      newStatus: "active",
    });
    return this.getTask(id)!;
  }

  // Resume a paused task: clears the paused flag (the daemon respawns the
  // snapshotted agents with --resume separately).
  resumeFromPause(id: string): Task {
    const task = this.requireTaskStatus(id, "active", "resume a paused task");
    if (!task.paused) {
      throw new Error("Task is not paused");
    }

    const changed = this.db
      .prepare(
        "UPDATE tasks SET paused = 0, updated_at = datetime('now') WHERE id = ? AND status = 'active' AND paused = 1",
      )
      .run(id).changes;
    if (changed === 0) {
      throw new Error("Task is no longer paused");
    }

    eventBus.emit("task:state_changed", {
      taskId: id,
      previousStatus: "active",
      newStatus: "active",
    });
    return this.getTask(id)!;
  }

  /**
   * Next task the queue should start or wake: active, not paused, not waiting
   * on review, with either a pending wake or a first run that never started,
   * and no live agents. FIFO by wake time (falling back to approval time).
   * The concurrency cap is enforced by the caller (task-runner).
   */
  getNextStartableTask(): Task | null {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'active' AND paused = 0 AND needs_review = 0
           AND (started_at IS NULL OR wake_requested_at IS NOT NULL)
           AND id NOT IN (
             SELECT DISTINCT task_id FROM agent_instances WHERE status IN ${LIVE_INSTANCE_STATUSES}
           )
         ORDER BY COALESCE(wake_requested_at, approved_at, created_at) ASC, rowid ASC
         LIMIT 1`,
      )
      .get() as TaskRow | null;
    return row ? rowToTask(row) : null;
  }

  advancePhase(id: string): Task {
    const task = this.requireTask(id);
    if (task.status !== "active") {
      throw new Error(`Can only advance phase on active tasks`);
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
    if (task.status !== "active") {
      throw new Error(`Can only set review on active tasks`);
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
      previousStatus: "active",
      newStatus: "active",
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
    if (task.status !== "active") {
      throw new Error(`Can only regress phase on active tasks`);
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
   * Boot hygiene. Active tasks survive a restart untouched (running-with-no-
   * agents is a legal resting state now); only the runtime residue is swept:
   * instances that can't have survived the daemon are marked failed, agent
   * pointers cleared, and escalations on settled tasks auto-resolved. Open
   * escalations on active tasks deliberately persist across restarts.
   */
  cleanupStaleState(): void {
    this.db
      .prepare(
        `UPDATE agent_instances
         SET status = 'failed', process_pid = NULL, updated_at = datetime('now')
         WHERE status IN ${LIVE_INSTANCE_STATUSES}`,
      )
      .run();

    this.db
      .prepare(
        `UPDATE agents
         SET process_pid = NULL,
             status = CASE WHEN status = 'busy' THEN 'idle' ELSE status END,
             updated_at = datetime('now')
         WHERE process_pid IS NOT NULL OR status = 'busy'`,
      )
      .run();

    this.db
      .prepare(
        `UPDATE escalations
         SET status = 'resolved',
             response = COALESCE(response, 'Auto-resolved: task is settled.'),
             resolved_at = datetime('now')
         WHERE status = 'open'
           AND task_id IN (
             SELECT id FROM tasks WHERE status = 'settled'
           )`,
      )
      .run();
  }

  /**
   * Close out live instances, delegations, and delegation groups when a run
   * settles (run complete/fail, cancel). Runs inside the caller's transaction.
   * The delegation active-status sets and result messages differ per transition
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
