// Read queries backing the command-center view. Extracted from
// src/html/view-models/command-center.vm.ts so the view-model is a pure
// assembler and the same rows can feed a JSON endpoint.
import type { Database } from "bun:sqlite";
import { deriveDisplayStatus } from "../tasks/status";

export interface CommandCenterTaskRow {
  id: string;
  title: string;
  description: string | null;
  /** Stored status: draft | active | settled. */
  status: string;
  current_phase: number;
  team_id: string | null;
  /** @deprecated compat mirror of `mode` ("real_time" when conversational, else "standard"). */
  task_type: string;
  /** Task mode: workflow | conversational. */
  mode?: string;
  /** Paused flag on active tasks (0/1). */
  paused?: number;
  /** Derived presentation status: draft|queued|working|idle|paused|review|blocked|completed|failed. */
  display_status?: string;
  needs_review: number;
  working_directory: string;
  created_at: string;
  completed_at: string | null;
  result: string | null;
  task_config: string | null;
  team_name: string | null;
  source_scheduled_task_id: string | null;
  /** Stored star (0/1) for the sidebar Favorites board. */
  starred?: number;
  /** Lucide icon id + hex tint. */
  icon?: string | null;
  icon_color?: string | null;
}

// Shared by the list and the single-task read so both return the same row shape
// and agree on which tasks are listed. The unary + keeps idx_tasks_source_scheduled
// off the IS NULL term so the list stays one table scan: with the index the OR
// becomes a multi-index OR over nearly every row, which measured slower.
const COMMAND_CENTER_TASK_SELECT =
  `SELECT t.id, t.title, t.description, t.status, t.current_phase, t.team_id, t.mode, t.paused, t.needs_review,
            t.working_directory, t.created_at, t.completed_at, t.result, t.task_config,
            t.source_scheduled_task_id, t.wake_requested_at, t.started_at,
            t.starred, t.icon, t.icon_color,
            tm.name AS team_name
     FROM tasks t LEFT JOIN teams tm ON tm.id = t.team_id`;
const LISTED_TASK_CONDITION =
  `(+t.source_scheduled_task_id IS NULL
        OR t.status = 'active'
        OR (t.status = 'settled' AND json_valid(t.result) AND json_extract(t.result, '$.error') IS NOT NULL))`;

type CommandCenterTaskQueryRow = CommandCenterTaskRow & { wake_requested_at: string | null; started_at: string | null };

function decorateCommandCenterTask(db: Database, row: CommandCenterTaskQueryRow): void {
  row.display_status = deriveDisplayStatus(db, row);
  row.task_type = row.mode === "conversational" ? "real_time" : "standard";
}

/**
 * Tasks with team names. Active and failed (settled-with-error) scheduled runs
 * stay in the list; cleanly settled ones are hidden (visible under the
 * recurring task's "runs" instead). `includeTaskId` force-includes one task so
 * its detail view can render.
 */
export function fetchCommandCenterTasks(db: Database, includeTaskId?: string): CommandCenterTaskRow[] {
  const rows = db.prepare(
    `${COMMAND_CENTER_TASK_SELECT}
     WHERE ${LISTED_TASK_CONDITION}
        OR t.id = ?
     ORDER BY t.created_at DESC`,
  ).all(includeTaskId ?? null) as CommandCenterTaskQueryRow[];
  for (const row of rows) decorateCommandCenterTask(db, row);
  return rows;
}

/**
 * One task as fetchCommandCenterTasks would list it (no includeTaskId), or null
 * when that list hides it. For per-task reads such as the phase-strip poll,
 * which must not pay for the whole list.
 */
export function fetchCommandCenterTask(db: Database, taskId: string): CommandCenterTaskRow | null {
  const row = db.prepare(
    `${COMMAND_CENTER_TASK_SELECT}
     WHERE t.id = ? AND ${LISTED_TASK_CONDITION}`,
  ).get(taskId) as CommandCenterTaskQueryRow | null;
  if (!row) return null;
  decorateCommandCenterTask(db, row);
  return row;
}

export interface ScheduledRunRow {
  id: string;
  title: string;
  status: string;
  result: string | null;
  created_at: string;
  completed_at: string | null;
  source_scheduled_task_id: string;
}

/**
 * The last `perTask` runs of every recurring task, newest first, keyed by the
 * recurring task id. Feeds the v2 sidebar's per-series run strip; the full run
 * history stays on the recurring task's detail view.
 */
export function fetchRecentScheduledRuns(db: Database, perTask = 5): Record<string, ScheduledRunRow[]> {
  const rows = db.prepare(
    `SELECT id, title, status, result, created_at, completed_at, source_scheduled_task_id
     FROM (
       SELECT t.id, t.title, t.status, t.result, t.created_at, t.completed_at, t.source_scheduled_task_id,
              ROW_NUMBER() OVER (PARTITION BY t.source_scheduled_task_id ORDER BY t.created_at DESC) AS rn
       FROM tasks t
       WHERE t.source_scheduled_task_id IS NOT NULL
     )
     WHERE rn <= ?
     ORDER BY source_scheduled_task_id, created_at DESC`,
  ).all(perTask) as ScheduledRunRow[];
  const byTask: Record<string, ScheduledRunRow[]> = {};
  for (const row of rows) {
    (byTask[row.source_scheduled_task_id] ??= []).push(row);
  }
  return byTask;
}

export interface DelegationPillInfo {
  id: string;
  status: string;
  promptPreview: string;
}

/** Delegation pill (prompt preview + status) per child instance id. */
export function fetchDelegationsByChildInstance(
  db: Database,
  instanceIds: string[],
): Record<string, DelegationPillInfo> {
  const byChild: Record<string, DelegationPillInfo> = {};
  if (instanceIds.length === 0) return byChild;
  const placeholders = instanceIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, child_instance_id, status, prompt
     FROM delegations
     WHERE child_instance_id IN (${placeholders})`,
  ).all(...instanceIds) as Array<{ id: string; child_instance_id: string | null; status: string; prompt: string }>;
  for (const d of rows) {
    if (!d.child_instance_id) continue;
    const preview = d.prompt.length > 60 ? d.prompt.slice(0, 60) + "…" : d.prompt;
    byChild[d.child_instance_id] = { id: d.id, status: d.status, promptPreview: preview };
  }
  return byChild;
}

/**
 * Name + raw phases JSON for every team, keyed by id. One query replaces the
 * per-task lookup the mission builder used to run (N+1 on dashboard load).
 */
export function fetchTeamPhasesById(db: Database): Record<string, { name: string; phases: string }> {
  const rows = db.prepare("SELECT id, name, phases FROM teams").all() as Array<{ id: string; name: string; phases: string }>;
  const byId: Record<string, { name: string; phases: string }> = {};
  for (const r of rows) byId[r.id] = { name: r.name, phases: r.phases };
  return byId;
}

/** Teams selectable for standard-task drafts: everything except the Real Time team. */
export interface TaskTeamRow { id: string; name: string; icon: string | null; icon_color: string | null; }

export function fetchStandardTaskTeams(db: Database): TaskTeamRow[] {
  const rtTeam = db.prepare("SELECT id FROM teams WHERE lower(name) = 'real time' LIMIT 1").get() as { id: string } | undefined;
  // The team icon lives in the runtime local_teams.team_config JSON (id matches
  // the flattened shared teams row); pull it here so the sidebar can render it.
  const rows = db.prepare(
    `SELECT t.id, t.name,
            json_extract(lt.team_config, '$.icon') AS icon,
            json_extract(lt.team_config, '$.iconColor') AS icon_color
     FROM teams t LEFT JOIN local_teams lt ON lt.id = t.id
     ORDER BY t.name`,
  ).all() as TaskTeamRow[];
  return rows.filter((t) => !rtTeam || t.id !== rtTeam.id);
}

export function fetchOpenEscalationTaskIds(db: Database): Set<string> {
  return new Set(
    (db.prepare("SELECT DISTINCT task_id FROM escalations WHERE status = 'open'").all() as Array<{ task_id: string }>)
      .map((r) => r.task_id),
  );
}

/** Per-task count of open escalations. Drives the task-header escalation label. */
export function fetchOpenEscalationCountsByTask(db: Database): Map<string, number> {
  const rows = db
    .prepare("SELECT task_id, COUNT(*) AS n FROM escalations WHERE status = 'open' GROUP BY task_id")
    .all() as Array<{ task_id: string; n: number }>;
  return new Map(rows.map((r) => [r.task_id, r.n]));
}

export function hasDaemonOwner(db: Database): boolean {
  return db.prepare("SELECT value FROM daemon_state WHERE key = 'owner_pid'").get() != null;
}

export interface ScheduledTaskRow {
  id: string;
  title: string;
  description: string | null;
  team_id: string | null;
  team_name: string | null;
  schedule_unit: string | null;
  schedule_amount: number | null;
  schedule_matrix: string | null;
  status: string;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  starred?: number;
  icon?: string | null;
  icon_color?: string | null;
}

export function fetchScheduledTaskRows(db: Database): ScheduledTaskRow[] {
  try {
    return db.prepare(
      `SELECT st.id, st.title, st.description, st.team_id, st.schedule_unit, st.schedule_amount,
              st.schedule_matrix, st.status, st.next_run_at, st.last_run_at, st.created_at,
              st.starred, st.icon, st.icon_color,
              tm.name AS team_name
       FROM scheduled_tasks st LEFT JOIN teams tm ON tm.id = st.team_id
       ORDER BY CASE st.status WHEN 'approved' THEN 0 ELSE 1 END, st.created_at DESC`,
    ).all() as ScheduledTaskRow[];
  } catch {
    return []; // table may not exist yet
  }
}
