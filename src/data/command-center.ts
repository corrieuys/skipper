// Read queries backing the command-center view. Extracted from
// src/html/view-models/command-center.vm.ts so the view-model is a pure
// assembler and the same rows can feed a JSON endpoint.
import type { Database } from "bun:sqlite";

export interface CommandCenterTaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  current_phase: number;
  team_id: string | null;
  task_type: string;
  needs_review: number;
  working_directory: string;
  created_at: string;
  completed_at: string | null;
  result: string | null;
  task_config: string | null;
  team_name: string | null;
  source_scheduled_task_id: string | null;
}

/**
 * Tasks with team names. Running/approved/paused/failed scheduled runs stay in
 * the list; completed ones are hidden (visible under the recurring task's
 * "runs" instead). `includeTaskId` force-includes one task so its detail view
 * can render.
 */
export function fetchCommandCenterTasks(db: Database, includeTaskId?: string): CommandCenterTaskRow[] {
  return db.prepare(
    `SELECT t.id, t.title, t.description, t.status, t.current_phase, t.team_id, t.task_type, t.needs_review,
            t.working_directory, t.created_at, t.completed_at, t.result, t.task_config,
            t.source_scheduled_task_id,
            tm.name AS team_name
     FROM tasks t LEFT JOIN teams tm ON tm.id = t.team_id
     WHERE t.source_scheduled_task_id IS NULL
        OR t.status IN ('running', 'approved', 'paused', 'failed')
        OR t.id = ?
     ORDER BY t.created_at DESC`,
  ).all(includeTaskId ?? null) as CommandCenterTaskRow[];
}

export interface ActiveInstanceRow {
  id: string;
  template_agent_id: string;
  agent_name: string;
  parent_instance_id: string | null;
  root_instance_id: string | null;
  status: string;
  process_pid: number | null;
  task_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}

/** Active agents — includes recently completed ones on running tasks so the tree renders fully. */
export function fetchActiveInstanceRows(db: Database): ActiveInstanceRow[] {
  return db.prepare(
    `SELECT ai.id, ai.template_agent_id,
            CASE WHEN json_valid(ai.state_metadata) AND json_extract(ai.state_metadata, '$.role') = 'consensus_reviewer'
                 THEN COALESCE(a.name, ai.template_agent_id) || ' (Reviewer)'
                 ELSE COALESCE(a.name, ai.template_agent_id)
            END AS agent_name,
            ai.parent_instance_id, ai.root_instance_id, ai.status, ai.process_pid, ai.task_id,
            ai.input_tokens, ai.output_tokens,
            ai.cache_creation_tokens, ai.cache_read_tokens
     FROM agent_instances ai
     LEFT JOIN agents a ON a.id = ai.template_agent_id
     WHERE ai.status IN ('running', 'waiting_delegation', 'pending')
        OR (ai.status IN ('completed', 'failed') AND ai.task_id IN (SELECT id FROM tasks WHERE status = 'running'))
     ORDER BY ai.created_at`,
  ).all() as ActiveInstanceRow[];
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

export function fetchRunningDelegationGroupCounts(
  db: Database,
): Array<{ settled_count: number; expected_count: number; failed_count: number }> {
  return db.prepare(
    "SELECT settled_count, expected_count, failed_count FROM delegation_groups WHERE status = 'running'",
  ).all() as Array<{ settled_count: number; expected_count: number; failed_count: number }>;
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
export function fetchStandardTaskTeams(db: Database): Array<{ id: string; name: string }> {
  const rtTeam = db.prepare("SELECT id FROM teams WHERE lower(name) = 'real time' LIMIT 1").get() as { id: string } | undefined;
  return (db.prepare("SELECT id, name FROM teams ORDER BY name").all() as Array<{ id: string; name: string }>)
    .filter((t) => !rtTeam || t.id !== rtTeam.id);
}

export function fetchOpenEscalationTaskIds(db: Database): Set<string> {
  return new Set(
    (db.prepare("SELECT DISTINCT task_id FROM escalations WHERE status = 'open'").all() as Array<{ task_id: string }>)
      .map((r) => r.task_id),
  );
}

export function hasDaemonOwner(db: Database): boolean {
  return db.prepare("SELECT value FROM daemon_state WHERE key = 'owner_pid'").get() != null;
}

export interface TaskTokenTotals {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
}

/** Token usage totals per task (sum across all instances regardless of status). */
export function fetchTokenTotalsByTask(db: Database): Record<string, TaskTokenTotals> {
  const rows = db.prepare(
    `SELECT task_id,
            COALESCE(SUM(input_tokens), 0) AS input,
            COALESCE(SUM(output_tokens), 0) AS output,
            COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read
     FROM agent_instances GROUP BY task_id`,
  ).all() as Array<{ task_id: string } & TaskTokenTotals>;
  const byTask: Record<string, TaskTokenTotals> = {};
  for (const row of rows) {
    byTask[row.task_id] = {
      input: row.input, output: row.output, cache_creation: row.cache_creation, cache_read: row.cache_read,
    };
  }
  return byTask;
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
}

export function fetchScheduledTaskRows(db: Database): ScheduledTaskRow[] {
  try {
    return db.prepare(
      `SELECT st.id, st.title, st.description, st.team_id, st.schedule_unit, st.schedule_amount,
              st.schedule_matrix, st.status, st.next_run_at, st.last_run_at, st.created_at,
              tm.name AS team_name
       FROM scheduled_tasks st LEFT JOIN teams tm ON tm.id = st.team_id
       ORDER BY CASE st.status WHEN 'approved' THEN 0 ELSE 1 END, st.created_at DESC`,
    ).all() as ScheduledTaskRow[];
  } catch {
    return []; // table may not exist yet
  }
}

/** cadence_timer_active per running realtime task; tasks without a pipeline row map to false. */
export function fetchRealtimeSessionActive(db: Database, taskIds: string[]): Record<string, boolean> {
  const active: Record<string, boolean> = {};
  if (taskIds.length === 0) return active;
  try {
    const rows = db.prepare(
      "SELECT task_id, cadence_timer_active FROM realtime_pipeline_state WHERE task_id IN (" +
      taskIds.map(() => "?").join(",") + ")",
    ).all(...taskIds) as Array<{ task_id: string; cadence_timer_active: number }>;
    for (const row of rows) active[row.task_id] = row.cadence_timer_active === 1;
    for (const id of taskIds) {
      if (!(id in active)) active[id] = false;
    }
  } catch { /* table may not exist */ }
  return active;
}
