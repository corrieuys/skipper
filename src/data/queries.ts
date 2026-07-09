import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { logError } from "../logging";
import type { AgentTile } from "../html/dashboardLatestSteerFragment";
import type {
  TaskData,
  AgentData,
  AgentInstanceSummary,
  TeamData,
  TeamAgentData,
  DelegationData,
  TaskNoteData,
  EscalationData,
  DashboardData,
  ForensicsData,
  ForensicsTimelineEntry,
  ForensicsAgentInstance,
  ForensicsDelegationGroup,
  ForensicsDelegation,
  ForensicsEscalation,
  ForensicsTokenUsage,
  ForensicsTerminalTail,
} from "../html/components";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Full team roster for a task's agents — the same source zen mode uses. Returns
 * every team member (active + idle) with a live instance count, so the dashboard
 * can render the whole team as orbs rather than only running instances.
 */
export function buildTeamAgentTiles(db: Database, taskId: string): AgentTile[] {
  const task = db.prepare("SELECT team_id FROM tasks WHERE id = ?").get(taskId) as { team_id: string | null } | null;
  if (!task?.team_id) return [];
  const rows = db.prepare(
    `SELECT a.id AS template_agent_id,
            COALESCE(a.name, a.id) AS agent_name,
            (SELECT COUNT(*) FROM agent_instances ai
              WHERE ai.template_agent_id = ta.agent_id AND ai.task_id = ?
                AND ai.status IN ('running', 'waiting_delegation')) AS instance_count
     FROM team_agents ta
     JOIN agents a ON a.id = ta.agent_id
     WHERE ta.team_id = ?
     ORDER BY ta.level, ta.created_at`,
  ).all(taskId, task.team_id) as Array<{ template_agent_id: string; agent_name: string; instance_count: number }>;
  return rows.map((r) => ({
    template_agent_id: r.template_agent_id,
    agent_name: r.agent_name,
    instance_count: r.instance_count,
    is_active: r.instance_count > 0,
  }));
}

export function parseRow(
  row: Record<string, unknown>,
  jsonFields: string[],
): Record<string, unknown> {
  const result = { ...row };
  for (const field of jsonFields) {
    if (typeof result[field] === "string") {
      try {
        result[field] = JSON.parse(result[field] as string);
      } catch (err) {
        logError(getDb(), "data.queries.parse_row", { field }, err);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function fetchTasksWithTeams(db: ReturnType<typeof getDb>): TaskData[] {
  const rows = db.prepare(
    `SELECT t.*, tm.name AS team_name
     FROM tasks t
     LEFT JOIN teams tm ON tm.id = t.team_id
     ORDER BY
       CASE t.status WHEN 'approved' THEN 0 WHEN 'draft' THEN 1 WHEN 'running' THEN 2 ELSE 3 END,
       COALESCE(t.updated_at, t.created_at) DESC,
       t.rowid DESC`,
  ).all() as Record<string, unknown>[];
  return rows.map((r) => parseRow(r, ["result", "orchestration_state"])) as unknown as TaskData[];
}

export function fetchTaskById(db: ReturnType<typeof getDb>, taskId: string): TaskData | null {
  const row = db.prepare(
    `SELECT t.*, tm.name AS team_name
     FROM tasks t
     LEFT JOIN teams tm ON tm.id = t.team_id
     WHERE t.id = ?`,
  ).get(taskId) as Record<string, unknown> | null;
  if (!row) return null;
  const task = parseRow(row, ["result", "orchestration_state"]) as unknown as TaskData;

  if (task.team_id) {
    const teamRow = db.prepare("SELECT phases FROM teams WHERE id = ?").get(task.team_id) as { phases: string } | null;
    if (teamRow) {
      try {
        task.phases = JSON.parse(teamRow.phases);
      } catch {
        // ignore invalid phases payload
      }
    }
  }

  return task;
}

export function fetchTaskDelegations(db: ReturnType<typeof getDb>, taskId: string): DelegationData[] {
  return db.prepare(
    `SELECT d.*,
            pa.name AS parent_agent_name,
            ca.name AS child_agent_name
     FROM delegations d
     LEFT JOIN agents pa ON pa.id = d.parent_agent_id
     LEFT JOIN agents ca ON ca.id = d.child_agent_id
     WHERE d.task_id = ?
     ORDER BY d.created_at`,
  ).all(taskId) as DelegationData[];
}

export function fetchTaskNotes(db: ReturnType<typeof getDb>, taskId: string): TaskNoteData[] {
  return db.prepare(
    `SELECT n.*, a.name AS agent_name
     FROM task_notes n
     LEFT JOIN agents a ON a.id = n.agent_id
     WHERE n.task_id = ?
     ORDER BY n.created_at, n.id`,
  ).all(taskId) as TaskNoteData[];
}

export function fetchTaskArtifacts(
  db: ReturnType<typeof getDb>,
  taskId: string,
): { id: string; name: string; version: number; kind: string; description: string | null; created_by_agent_id: string | null; created_at: string }[] {
  return db.prepare(
    `SELECT a.id, a.name, a.version, a.kind, a.description, a.created_by_agent_id, a.created_at
     FROM task_artifacts a
     INNER JOIN (
       SELECT name, MAX(version) AS max_version
       FROM task_artifacts
       WHERE task_id = ?
       GROUP BY name
     ) latest ON a.name = latest.name AND a.version = latest.max_version
     WHERE a.task_id = ?
     ORDER BY a.created_at DESC`,
  ).all(taskId, taskId) as { id: string; name: string; version: number; kind: string; description: string | null; created_by_agent_id: string | null; created_at: string }[];
}

export function fetchTaskArtifactByName(
  db: ReturnType<typeof getDb>,
  taskId: string,
  name: string,
  version: "latest" | number = "latest",
): { id: string; task_id: string; name: string; version: number; kind: string; description: string | null; body: string | null; created_by_agent_id: string | null; created_at: string } | null {
  if (version === "latest") {
    return db.prepare(
      `SELECT * FROM task_artifacts WHERE task_id = ? AND name = ? ORDER BY version DESC LIMIT 1`,
    ).get(taskId, name) as ReturnType<typeof fetchTaskArtifactByName>;
  }
  return db.prepare(
    `SELECT * FROM task_artifacts WHERE task_id = ? AND name = ? AND version = ?`,
  ).get(taskId, name, version) as ReturnType<typeof fetchTaskArtifactByName>;
}

export function fetchTaskForensics(db: ReturnType<typeof getDb>, taskId: string): ForensicsData {
  // 1. Timeline
  const timeline = db.prepare(
    `SELECT 'checkpoint' AS source, created_at, checkpoint_type, context_snapshot, sequence,
            NULL AS escalation_type, NULL AS severity, NULL AS escalation_status, NULL AS question,
            NULL AS from_phase, NULL AS to_phase, NULL AS reason, NULL AS agent_name,
            NULL AS event_type, NULL AS event_payload
     FROM task_checkpoints WHERE task_id = ?
     UNION ALL
     SELECT 'escalation' AS source, e.created_at, NULL, NULL, NULL,
            e.type AS escalation_type, e.severity, e.status AS escalation_status, e.question,
            NULL, NULL, NULL, NULL,
            NULL, NULL
     FROM escalations e WHERE e.task_id = ?
     UNION ALL
     SELECT 'remediation' AS source, ev.created_at, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL,
            ev.type AS event_type, ev.payload AS event_payload
     FROM events ev
     WHERE ev.task_id = ? AND ev.type LIKE 'remediation:%'
     UNION ALL
     SELECT 'delegation' AS source, ev.created_at, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL,
            ev.type AS event_type, ev.payload AS event_payload
     FROM events ev
     WHERE ev.task_id = ? AND ev.type LIKE 'delegation:%'
     ORDER BY created_at`,
  ).all(taskId, taskId, taskId, taskId) as ForensicsTimelineEntry[];

  // 2. Agent instances
  const instances = db.prepare(
    `SELECT ai.id, ai.task_id, ai.template_agent_id, a.name AS agent_name,
            ai.parent_instance_id, ai.root_instance_id, ai.status, ai.process_pid,
            ai.session_id, ai.attempt, ai.created_at, ai.updated_at,
            json_extract(ai.state_metadata, '$.exit_code') AS exit_code
     FROM agent_instances ai
     LEFT JOIN agents a ON a.id = ai.template_agent_id
     WHERE ai.task_id = ?
     ORDER BY ai.created_at`,
  ).all(taskId) as ForensicsAgentInstance[];

  // 3. Delegation groups with nested delegations
  const groups = db.prepare(
    `SELECT id, task_id, parent_instance_id, policy, expected_count,
            settled_count, failed_count, status, created_at, completed_at
     FROM delegation_groups WHERE task_id = ?
     ORDER BY created_at`,
  ).all(taskId) as (Omit<ForensicsDelegationGroup, "delegations">)[];

  const groupIds = groups.map((g) => g.id);
  const delegationsByGroup = new Map<string, ForensicsDelegation[]>();
  if (groupIds.length > 0) {
    const placeholders = groupIds.map(() => "?").join(",");
    const delegationRows = db.prepare(
      `SELECT d.id, d.delegation_group_id,
              pa.name AS parent_agent_name, ca.name AS child_agent_name,
              d.prompt, d.result, d.status, d.created_at, d.completed_at
       FROM delegations d
       LEFT JOIN agents pa ON pa.id = d.parent_agent_id
       LEFT JOIN agents ca ON ca.id = d.child_agent_id
       WHERE d.delegation_group_id IN (${placeholders})
       ORDER BY d.created_at`,
    ).all(...groupIds) as (ForensicsDelegation & { delegation_group_id: string })[];
    for (const row of delegationRows) {
      const existing = delegationsByGroup.get(row.delegation_group_id) ?? [];
      existing.push(row);
      delegationsByGroup.set(row.delegation_group_id, existing);
    }
  }

  const delegationGroups: ForensicsDelegationGroup[] = groups.map((g) => ({
    ...g,
    delegations: delegationsByGroup.get(g.id) ?? [],
  }));

  // 4. Escalations
  const escalations = db.prepare(
    `SELECT e.id, e.agent_id, a.name AS agent_name, e.type, e.severity,
            e.question, e.response, e.status, e.created_at, e.resolved_at
     FROM escalations e
     LEFT JOIN agents a ON a.id = e.agent_id
     WHERE e.task_id = ?
     ORDER BY e.created_at`,
  ).all(taskId) as ForensicsEscalation[];

  // 5. Token usage
  const agentStateStmt = db.prepare(
    `SELECT CASE WHEN json_extract(state_metadata, '$.context_compact_needed') = 1 THEN 1 ELSE 0 END AS context_compact_needed,
            COALESCE(nudge_count, 0) AS nudge_count
     FROM agent_states WHERE agent_id = ?`,
  );
  const tokenStmt = db.prepare(
    `SELECT
       SUM(COALESCE(
         CAST(json_extract(data, '$.usage.input_tokens') AS INTEGER),
         CAST(json_extract(data, '$.usage.prompt_tokens') AS INTEGER),
         CAST(json_extract(data, '$.part.tokens.input') AS INTEGER),
         0
       )) AS input_tokens,
       SUM(COALESCE(
         CAST(json_extract(data, '$.usage.cache_read_input_tokens') AS INTEGER),
         CAST(json_extract(data, '$.usage.cached_input_tokens') AS INTEGER),
         CAST(json_extract(data, '$.usage.input_tokens_details.cached_tokens') AS INTEGER),
         0
       )) AS cache_read_input_tokens,
       SUM(COALESCE(
         CAST(json_extract(data, '$.usage.cache_creation_input_tokens') AS INTEGER),
         0
       )) AS cache_creation_input_tokens,
       SUM(COALESCE(
         CAST(json_extract(data, '$.usage.output_tokens') AS INTEGER),
         CAST(json_extract(data, '$.usage.completion_tokens') AS INTEGER),
         CAST(json_extract(data, '$.part.tokens.output') AS INTEGER),
         0
       )) AS output_tokens,
       MAX(CASE WHEN json_valid(data) THEN json_extract(data, '$.num_turns') END) AS num_turns,
       MAX(CASE WHEN json_valid(data) THEN json_extract(data, '$.duration_ms') END) AS duration_ms
     FROM terminal_outputs
     WHERE agent_id = ?
       AND json_valid(data)
       AND json_extract(data, '$.type') IN ('result', 'turn.completed', 'step_finish')
       AND created_at >= ?
       AND created_at <= datetime(?, '+60 seconds')`,
  );
  const tokenUsage: ForensicsTokenUsage[] = instances.map((inst) => {
    const tokens = tokenStmt.get(
      inst.id, inst.created_at, inst.updated_at,
    ) as { input_tokens: number | null; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; output_tokens: number | null; num_turns: number | null; duration_ms: number | null } | null;
    const state = agentStateStmt.get(inst.template_agent_id) as { context_compact_needed: number; nudge_count: number } | null;
    return {
      instance_id: inst.id,
      agent_name: inst.agent_name,
      status: inst.status,
      input_tokens: tokens?.input_tokens ?? null,
      cache_read_input_tokens: tokens?.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: tokens?.cache_creation_input_tokens ?? null,
      output_tokens: tokens?.output_tokens ?? null,
      num_turns: tokens?.num_turns ?? null,
      duration_ms: tokens?.duration_ms ?? null,
      context_compact_needed: (state?.context_compact_needed ?? 0) === 1,
      nudge_count: state?.nudge_count ?? 0,
    };
  });

  // 6. Terminal tails
  const terminalTails: ForensicsTerminalTail[] = [];
  for (const inst of instances) {
    const lines = db.prepare(
      `SELECT stream, data FROM terminal_outputs
       WHERE agent_id = ?
         AND created_at >= ?
         AND created_at <= datetime(?, '+60 seconds')
       ORDER BY sequence DESC LIMIT 20`,
    ).all(inst.id, inst.created_at, inst.updated_at) as { stream: string; data: string }[];
    if (lines.length > 0) {
      terminalTails.push({ instance_id: inst.id, lines: lines.reverse() });
    }
  }

  return { timeline, instances, delegationGroups, escalations, tokenUsage, terminalTails };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function fetchAgents(db: ReturnType<typeof getDb>): AgentData[] {
  const rows = db.prepare(
    `SELECT a.*,
       (SELECT COUNT(*) FROM agent_instances ai WHERE ai.template_agent_id = a.id AND ai.status IN ('running', 'waiting_delegation')) AS running_instance_count
     FROM agents a ORDER BY a.created_at`,
  ).all() as Record<string, unknown>[];
  return rows.map((r) => parseRow(r, ["config", "capabilities"])) as unknown as AgentData[];
}

export function fetchAgentById(db: ReturnType<typeof getDb>, agentId: string): AgentData | null {
  const row = db.prepare(
    `SELECT a.*,
       (SELECT COUNT(*) FROM agent_instances ai WHERE ai.template_agent_id = a.id AND ai.status IN ('running', 'waiting_delegation')) AS running_instance_count
     FROM agents a WHERE a.id = ?`,
  ).get(agentId) as Record<string, unknown> | null;
  if (!row) return null;
  return parseRow(row, ["config", "capabilities"]) as unknown as AgentData;
}

export function fetchActiveInstances(db: ReturnType<typeof getDb>, templateAgentId: string): AgentInstanceSummary[] {
  return db.prepare(
    `SELECT ai.id, ai.status, ai.task_id, t.title AS task_title, ai.created_at
     FROM agent_instances ai
     LEFT JOIN tasks t ON t.id = ai.task_id
     WHERE ai.template_agent_id = ? AND ai.status IN ('running', 'waiting_delegation')
     ORDER BY ai.created_at DESC`,
  ).all(templateAgentId) as AgentInstanceSummary[];
}

export function fetchAgentTypes(db: ReturnType<typeof getDb>): { name: string; available_models: string }[] {
  return db
    .prepare("SELECT name, available_models FROM agent_types ORDER BY name")
    .all() as { name: string; available_models: string }[];
}

export function fetchAgentOutput(
  db: ReturnType<typeof getDb>,
  agentId: string,
  limit: number = 200,
): { stream: string; data: string; created_at: string }[] {
  // Get runtime instance IDs for this template agent
  const runtimeRows = db.prepare(
    `SELECT id FROM agent_instances WHERE template_agent_id = ? ORDER BY created_at DESC`,
  ).all(agentId) as { id: string }[];
  const runtimeIds = [agentId, ...runtimeRows.map((r) => r.id)];

  if (runtimeIds.length === 0) return [];

  const placeholders = runtimeIds.map(() => "?").join(",");
  return db.prepare(
    `SELECT stream, data, created_at
     FROM terminal_outputs
     WHERE agent_id IN (${placeholders})
       AND NOT (json_valid(data) = 1 AND json_extract(data, '$.type') = 'result')
     ORDER BY id DESC
     LIMIT ?`,
  ).all(...runtimeIds, limit) as { stream: string; data: string; created_at: string }[];
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export function fetchTeams(db: ReturnType<typeof getDb>): TeamData[] {
  const rows = db.prepare(
    `SELECT t.*, a.name AS entrypoint_agent_name
     FROM teams t
     LEFT JOIN agents a ON a.id = t.entrypoint_agent_id
     ORDER BY t.created_at`,
  ).all() as Record<string, unknown>[];
  return rows.map((r) => parseRow(r, ["phases"])) as unknown as TeamData[];
}

export function fetchTeamById(db: ReturnType<typeof getDb>, teamId: string): TeamData | null {
  const row = db.prepare(
    `SELECT t.*, a.name AS entrypoint_agent_name
     FROM teams t
     LEFT JOIN agents a ON a.id = t.entrypoint_agent_id
     WHERE t.id = ?`,
  ).get(teamId) as Record<string, unknown> | null;
  if (!row) return null;
  return parseRow(row, ["phases"]) as unknown as TeamData;
}

export function fetchTeamMembers(db: ReturnType<typeof getDb>, teamId: string): TeamAgentData[] {
  const agentRows = db.prepare(
    `SELECT ta.agent_id, a.name as agent_name, ta.role, ta.level, a.capabilities
     FROM team_agents ta JOIN agents a ON ta.agent_id = a.id
     WHERE ta.team_id = ?
     ORDER BY ta.level, a.name`,
  ).all(teamId) as Record<string, unknown>[];
  return agentRows.map((r) => parseRow(r, ["capabilities"])) as unknown as TeamAgentData[];
}

export function fetchAvailableTeamAgents(
  db: ReturnType<typeof getDb>,
  teamId: string,
): { id: string; name: string }[] {
  return db.prepare(
    `SELECT a.id, a.name
     FROM agents a
     WHERE a.id NOT IN (SELECT ta.agent_id FROM team_agents ta WHERE ta.team_id = ?)
     ORDER BY a.name`,
  ).all(teamId) as { id: string; name: string }[];
}

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------

export function fetchEscalations(
  db: ReturnType<typeof getDb>,
  status?: string,
): EscalationData[] {
  const where = status ? `WHERE e.status = '${status.replace(/'/g, "''")}'` : "";
  return db.prepare(
    `SELECT e.*, a.name AS agent_name
     FROM escalations e
     LEFT JOIN agents a ON a.id = e.agent_id
     ${where}
     ORDER BY e.created_at DESC`,
  ).all() as EscalationData[];
}

export function getOpenEscalationCount(db: ReturnType<typeof getDb>): number {
  return (db.prepare("SELECT COUNT(*) as c FROM escalations WHERE status = 'open'").get() as { c: number }).c;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function fetchDashboardRealtimeTimeline(
  db: ReturnType<typeof getDb>,
): DashboardData["realtimeTimeline"] {
  const DASHBOARD_TIMELINE_LIMIT = 250;
  const activeRealtimeTask = db.prepare(
    `SELECT id, title
     FROM tasks
     WHERE task_type = 'real_time'
       AND status IN ('running', 'approved')
     ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at DESC
     LIMIT 1`,
  ).get() as { id: string; title: string } | null;

  if (!activeRealtimeTask) return null;

  const entries = db.prepare(
    `SELECT id, entry_type, content, priority, created_at
     FROM realtime_timeline
     WHERE task_id = ?
     ORDER BY created_at DESC
     LIMIT ${DASHBOARD_TIMELINE_LIMIT}`,
  ).all(activeRealtimeTask.id) as { id: string; entry_type: string; content: string; priority: string; created_at: string }[];

  return {
    taskId: activeRealtimeTask.id,
    taskTitle: activeRealtimeTask.title,
    entries,
  };
}

export function fetchDashboardPhaseIndicatorTask(
  db: ReturnType<typeof getDb>,
): DashboardData["phaseIndicatorTask"] {
  const row = db.prepare(
    `SELECT t.id, t.title, t.status, t.current_phase, t.needs_review, t.task_type, tm.phases
     FROM tasks t
     LEFT JOIN teams tm ON tm.id = t.team_id
     WHERE t.task_type != 'real_time'
       AND t.status IN ('running', 'approved')
     ORDER BY CASE t.status WHEN 'running' THEN 0 ELSE 1 END, t.created_at DESC
     LIMIT 1`,
  ).get() as { id: string; title: string; status: string; current_phase: number; needs_review?: number; task_type?: string; phases?: string | null } | null;

  if (!row) return null;

  let phases: { name: string; prompt: string }[] = [];
  if (row.phases) {
    try {
      const parsed = JSON.parse(row.phases);
      if (Array.isArray(parsed)) phases = parsed as { name: string; prompt: string }[];
    } catch {
      phases = [];
    }
  }

  return {
    id: row.id,
    title: row.title,
    status: row.status,
    current_phase: row.current_phase,
    needs_review: !!(row.needs_review ?? 0),
    task_type: row.task_type,
    phases,
  };
}
