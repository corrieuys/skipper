import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { logError } from "../logging";
import { getSkipperConfig, isSkipperAgent } from "../agents/skipper";
import { eventBus } from "../events/bus";
import type {
  AgentOutputEvent,
  AgentExitEvent,
  TaskStateChangedEvent,
  AgentStateChangedEvent,
  EscalationCreatedEvent,
  InstanceStateChangedEvent,
  DelegationGroupProgressEvent,
} from "../events/bus";
import {
  dashboardPage,
  dashboardActiveTaskFragment,
  dashboardAgentStatusFragment,
  dashboardRunningInstancesFragment,
  dashboardDelegationGroupsFragment,
  tasksPage,
  taskListPollingFragment,
  taskDetailPage,
  taskDetailSummaryFragment,
  taskPhaseStepperFragment,
  taskDelegationsFragment,
  taskForensicsFragment,
  agentsPage,
  agentListPollingFragment,
  agentDetailPage,
  agentDetailSummaryFragment,
  teamsPage,
  teamListPollingFragment,
  teamDetailPage,
  teamDetailSummaryFragment,
  teamMembersFragment,
  escalationsPage,
  renderTerminalOutputChunk,
  terminalOutputFragment,
  auditEventsPage,
  logsPage,
  helpPage,
  recentActivityFragment,
  skipperConfigPage,
  metricsFragment,
  diagnosticCard,
  formatTimestamp,
} from "../html/components";
import type {
  DashboardData,
  PollIntervalSeconds,
  TaskData,
  AgentData,
  AgentInstanceSummary,
  TeamData,
  TeamAgentData,
  EscalationData,
  TaskNoteData,
  DelegationData,
  ArtifactData,
  AuditEventData,
  AuditEventFilters,
  LogEntryData,
  LogFilters,
  RecentLogEntry,
  ForensicsData,
  ForensicsTimelineEntry,
  ForensicsAgentInstance,
  ForensicsDelegationGroup,
  ForensicsDelegation,
  ForensicsEscalation,
  ForensicsTokenUsage,
  ForensicsTerminalTail,
} from "../html/components";
import type { ManagerDaemon } from "../agents/manager-daemon";

function html(content: string): Response {
  return new Response(content, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function parseRow(row: Record<string, unknown>, jsonFields: string[]): Record<string, unknown> {
  const result = { ...row };
  for (const field of jsonFields) {
    if (typeof result[field] === "string") {
      try {
        result[field] = JSON.parse(result[field] as string);
      } catch (err) {
        logError(getDb(), "routes.pages.parse_row", { field }, err);
      }
    }
  }
  return result;
}

export function getPollIntervalSeconds(db: ReturnType<typeof getDb>): PollIntervalSeconds {
  const row = db.prepare(
    `SELECT
      EXISTS(SELECT 1 FROM tasks WHERE status IN ('running', 'approved')) AS has_active_task,
      EXISTS(SELECT 1 FROM agent_instances WHERE status IN ('running', 'waiting_delegation')) AS has_busy_agent`,
  ).get() as { has_active_task: number; has_busy_agent: number };

  return (row.has_active_task === 1 || row.has_busy_agent === 1) ? 3 : 8;
}

function fetchTasksWithTeams(db: ReturnType<typeof getDb>): TaskData[] {
  const rows = db.prepare(
    `SELECT t.*, tm.name AS team_name
     FROM tasks t
     LEFT JOIN teams tm ON tm.id = t.team_id
     ORDER BY t.priority, t.created_at DESC, t.rowid DESC`,
  ).all() as Record<string, unknown>[];
  return rows.map((r) => parseRow(r, ["result", "orchestration_state"])) as unknown as TaskData[];
}

function fetchTaskById(db: ReturnType<typeof getDb>, taskId: string): TaskData | null {
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

function fetchTaskDelegations(db: ReturnType<typeof getDb>, taskId: string): DelegationData[] {
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

function fetchAgents(db: ReturnType<typeof getDb>): AgentData[] {
  const rows = db.prepare(
    `SELECT a.*,
       (SELECT COUNT(*) FROM agent_instances ai WHERE ai.template_agent_id = a.id AND ai.status IN ('running', 'waiting_delegation')) AS running_instance_count
     FROM agents a ORDER BY a.created_at`,
  ).all() as Record<string, unknown>[];
  return rows.map((r) => parseRow(r, ["config", "capabilities"])) as unknown as AgentData[];
}

function fetchAgentById(db: ReturnType<typeof getDb>, agentId: string): AgentData | null {
  const row = db.prepare(
    `SELECT a.*,
       (SELECT COUNT(*) FROM agent_instances ai WHERE ai.template_agent_id = a.id AND ai.status IN ('running', 'waiting_delegation')) AS running_instance_count
     FROM agents a WHERE a.id = ?`,
  ).get(agentId) as Record<string, unknown> | null;
  if (!row) return null;
  return parseRow(row, ["config", "capabilities"]) as unknown as AgentData;
}

function fetchActiveInstances(db: ReturnType<typeof getDb>, templateAgentId: string): AgentInstanceSummary[] {
  return db.prepare(
    `SELECT ai.id, ai.status, ai.task_id, t.title AS task_title, ai.created_at
     FROM agent_instances ai
     LEFT JOIN tasks t ON t.id = ai.task_id
     WHERE ai.template_agent_id = ? AND ai.status IN ('running', 'waiting_delegation')
     ORDER BY ai.created_at DESC`,
  ).all(templateAgentId) as AgentInstanceSummary[];
}

function fetchTeams(db: ReturnType<typeof getDb>): TeamData[] {
  const rows = db.prepare(
    `SELECT t.*, a.name AS entrypoint_agent_name
     FROM teams t
     LEFT JOIN agents a ON a.id = t.entrypoint_agent_id
     ORDER BY t.created_at`,
  ).all() as Record<string, unknown>[];
  return rows.map((r) => parseRow(r, ["phases"])) as unknown as TeamData[];
}

function fetchTeamById(db: ReturnType<typeof getDb>, teamId: string): TeamData | null {
  const row = db.prepare(
    `SELECT t.*, a.name AS entrypoint_agent_name
     FROM teams t
     LEFT JOIN agents a ON a.id = t.entrypoint_agent_id
     WHERE t.id = ?`,
  ).get(teamId) as Record<string, unknown> | null;
  if (!row) return null;
  return parseRow(row, ["phases"]) as unknown as TeamData;
}

function fetchTeamMembers(db: ReturnType<typeof getDb>, teamId: string): TeamAgentData[] {
  const agentRows = db.prepare(
    `SELECT ta.agent_id, a.name as agent_name, ta.role, ta.level, ta.max_complexity, a.capabilities
     FROM team_agents ta JOIN agents a ON ta.agent_id = a.id
     WHERE ta.team_id = ? ORDER BY ta.level`,
  ).all(teamId) as Record<string, unknown>[];
  return agentRows.map((r) => parseRow(r, ["capabilities"])) as unknown as TeamAgentData[];
}

function fetchAvailableTeamAgents(db: ReturnType<typeof getDb>, teamId: string): { id: string; name: string }[] {
  return db.prepare(
    `SELECT a.id, a.name
     FROM agents a
     WHERE a.id NOT IN (SELECT ta.agent_id FROM team_agents ta WHERE ta.team_id = ?)
     ORDER BY a.name`,
  ).all(teamId) as { id: string; name: string }[];
}

function fetchTaskForensics(db: ReturnType<typeof getDb>, taskId: string): ForensicsData {
  // 1. Timeline — UNION of checkpoints, escalations, regressions, remediation events, delegation events
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
     SELECT 'regression' AS source, pr.created_at, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL,
            pr.from_phase, pr.to_phase, pr.reason, a.name AS agent_name,
            NULL, NULL
     FROM phase_regressions pr
     LEFT JOIN agents a ON a.id = pr.agent_id
     WHERE pr.task_id = ?
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
  ).all(taskId, taskId, taskId, taskId, taskId) as ForensicsTimelineEntry[];

  // 2. Agent instances (with exit_code from state_metadata)
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
  let delegationsByGroup = new Map<string, ForensicsDelegation[]>();
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

  // 5. Token usage — aggregate per instance from terminal_outputs.
  // Claude Code: one `result` event at the end with total usage + num_turns + duration_ms.
  // Codex: one `turn.completed` event per turn with per-turn usage; SUM across all turns.
  // Both CLIs: usage.input_tokens + usage.output_tokens present.
  // Claude Code only: usage.cache_read_input_tokens, usage.cache_creation_input_tokens, num_turns, duration_ms.
  // Codex only: usage.cached_input_tokens (maps to cache read).
  const agentStateStmt = db.prepare(
    `SELECT CASE WHEN json_extract(state_metadata, '$.context_compact_needed') = 1 THEN 1 ELSE 0 END AS context_compact_needed,
            COALESCE(nudge_count, 0) AS nudge_count
     FROM agent_states WHERE agent_id = ?`,
  );
  const tokenStmt = db.prepare(
    `SELECT
       SUM(json_extract(data, '$.usage.input_tokens')) AS input_tokens,
       SUM(COALESCE(
         json_extract(data, '$.usage.cache_read_input_tokens'),
         json_extract(data, '$.usage.cached_input_tokens')
       )) AS cache_read_input_tokens,
       SUM(json_extract(data, '$.usage.cache_creation_input_tokens')) AS cache_creation_input_tokens,
       SUM(json_extract(data, '$.usage.output_tokens')) AS output_tokens,
       MAX(json_extract(data, '$.num_turns')) AS num_turns,
       MAX(json_extract(data, '$.duration_ms')) AS duration_ms
     FROM terminal_outputs
     WHERE agent_id = ?
       AND json_extract(data, '$.type') IN ('result', 'turn.completed')
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

  // 6. Terminal tails — last 20 lines per instance, queried by agent_id.
  // terminal_outputs.session_id tracks the agent_sessions row (one per spawn),
  // but agent_instances.session_id may be updated to a later resume session,
  // so joining on session_id misses rows. Querying by agent_id (runtime instance id)
  // and bounding by the instance's created_at..updated_at gives the right window.
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

  return {
    timeline,
    instances,
    delegationGroups,
    escalations,
    tokenUsage,
    terminalTails,
  };
}

function getAgentRuntimeIds(db: ReturnType<typeof getDb>, templateAgentId: string): string[] {
  const runtimeRows = db.prepare(
    `SELECT id FROM agent_instances
     WHERE template_agent_id = ?
     ORDER BY created_at DESC`,
  ).all(templateAgentId) as { id: string }[];
  const runtimeIds = runtimeRows.map((r) => r.id);
  return [templateAgentId, ...runtimeIds];
}

export function registerPageRoutes(daemon: ManagerDaemon): void {
  const db = getDb();

  // Dashboard
  addRoute("GET", "/", () => {
    const tasks = db.prepare("SELECT id, title, status, priority FROM tasks ORDER BY priority, created_at DESC").all() as DashboardData["tasks"];
    const agents = db.prepare("SELECT id, name, status, type, current_task_id FROM agents ORDER BY created_at").all() as DashboardData["agents"];
    const runningInstances = db.prepare(
      `SELECT ai.id, ai.template_agent_id, COALESCE(a.name, ai.template_agent_id) AS template_agent_name, ai.task_id, t.title AS task_title,
              ai.status, ai.parent_instance_id, ai.root_instance_id, ai.created_at, ai.updated_at
       FROM agent_instances ai
       LEFT JOIN agents a ON a.id = ai.template_agent_id
       LEFT JOIN tasks t ON t.id = ai.task_id
       WHERE ai.status IN ('running', 'waiting_delegation')
       ORDER BY ai.updated_at DESC`,
    ).all() as DashboardData["runningInstances"];
    const activeDelegationGroups = db.prepare(
      `SELECT id, task_id, parent_instance_id, settled_count, expected_count, failed_count, status, created_at
       FROM delegation_groups
       WHERE status = 'running'
       ORDER BY created_at DESC
       LIMIT 10`,
    ).all() as DashboardData["activeDelegationGroups"];
    const daemonStatus = daemon ? daemon.getStatus() : { state: "stopped" as const, uptime: 0 };
    const recentLogs = db.prepare(
      `SELECT to2.agent_id,
              COALESCE(a.name, ta.name, ai.template_agent_id, to2.agent_id) as agent_name,
              to2.stream, to2.data, to2.created_at
       FROM terminal_outputs to2
       LEFT JOIN agents a ON to2.agent_id = a.id
       LEFT JOIN agent_instances ai ON to2.agent_id = ai.id
       LEFT JOIN agents ta ON ta.id = ai.template_agent_id
       ORDER BY to2.id DESC LIMIT 10`,
    ).all() as RecentLogEntry[];
    return html(dashboardPage({ tasks, agents, runningInstances, activeDelegationGroups, daemon: daemonStatus, recentLogs }));
  });

  // Recent logs fragment (for SSE-triggered HTMX refresh fallback)
  addRoute("GET", "/api/logs/recent", () => {
    const recentLogs = db.prepare(
      `SELECT to2.agent_id,
              COALESCE(a.name, ta.name, ai.template_agent_id, to2.agent_id) as agent_name,
              to2.stream, to2.data, to2.created_at
       FROM terminal_outputs to2
       LEFT JOIN agents a ON to2.agent_id = a.id
       LEFT JOIN agent_instances ai ON to2.agent_id = ai.id
       LEFT JOIN agents ta ON ta.id = ai.template_agent_id
       ORDER BY to2.id DESC LIMIT 10`,
    ).all() as RecentLogEntry[];
    return html(recentActivityFragment(recentLogs));
  });

  // Tasks list
  addRoute("GET", "/tasks", () => {
    const tasks = fetchTasksWithTeams(db);
    const teams = db.prepare("SELECT id, name FROM teams ORDER BY name").all() as { id: string; name: string }[];
    return html(tasksPage(tasks, teams, getPollIntervalSeconds(db)));
  });

  // Task detail
  addRoute("GET", "/tasks/:id", (_req, params) => {
    const task = fetchTaskById(db, params.id);
    if (!task) return new Response("<p>Task not found</p>", { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });

    const notes = db.prepare(
      `SELECT n.*, a.name AS agent_name
       FROM task_notes n
       LEFT JOIN agents a ON a.id = n.agent_id
       WHERE n.task_id = ?
       ORDER BY n.created_at`,
    ).all(params.id) as TaskNoteData[];
    const delegations = fetchTaskDelegations(db, params.id);
    const artifacts = db.prepare(
      `SELECT ar.*, a.name AS agent_name
       FROM artifacts ar
       LEFT JOIN agents a ON a.id = ar.agent_id
       WHERE ar.task_id = ?
       ORDER BY ar.created_at`,
    ).all(params.id) as ArtifactData[];
    const teams = db.prepare("SELECT id, name FROM teams ORDER BY name").all() as { id: string; name: string }[];
    const forensics = fetchTaskForensics(db, params.id);

    return html(taskDetailPage(task, notes, delegations, artifacts, teams, getPollIntervalSeconds(db), forensics));
  });

  addRoute("GET", "/fragments/tasks/list", () => {
    const tasks = fetchTasksWithTeams(db);
    return html(taskListPollingFragment(tasks, getPollIntervalSeconds(db)));
  });

  addRoute("GET", "/fragments/tasks/:id/summary", (_req, params) => {
    const task = fetchTaskById(db, params.id);
    return html(taskDetailSummaryFragment(task, getPollIntervalSeconds(db)));
  });

  addRoute("GET", "/fragments/tasks/:id/phases", (_req, params) => {
    const task = fetchTaskById(db, params.id);
    return html(taskPhaseStepperFragment(task, getPollIntervalSeconds(db)));
  });

  addRoute("GET", "/fragments/tasks/:id/delegations", (_req, params) => {
    const task = fetchTaskById(db, params.id);
    const delegations = task ? fetchTaskDelegations(db, params.id) : [];
    if (!task) {
      return html(taskDelegationsFragment(params.id, delegations, 8, false));
    }
    return html(taskDelegationsFragment(params.id, delegations, getPollIntervalSeconds(db)));
  });

  addRoute("GET", "/fragments/tasks/:id/forensics", (_req, params) => {
    const forensics = fetchTaskForensics(db, params.id);
    return html(taskForensicsFragment(params.id, forensics, getPollIntervalSeconds(db)));
  });

  // Agents list
  addRoute("GET", "/agents", () => {
    const agents = fetchAgents(db);
    return html(agentsPage(agents, getPollIntervalSeconds(db)));
  });

  // Agent detail
  addRoute("GET", "/agents/:id", (req, params) => {
    // Redirect Skipper to its dedicated config page
    if (isSkipperAgent(params.id)) {
      return new Response(null, { status: 302, headers: { Location: "/skipper" } });
    }

    const agent = fetchAgentById(db, params.id);
    if (!agent) return new Response("<p>Agent not found</p>", { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
    const runtimeIds = getAgentRuntimeIds(db, params.id);
    const placeholders = runtimeIds.map(() => "?").join(",");
    const sessions = db.prepare(
      `SELECT id, created_at
       FROM agent_sessions
       WHERE agent_id IN (${placeholders})
       ORDER BY created_at DESC`,
    ).all(...runtimeIds) as { id: string; created_at: string }[];

    // Determine selected session from query param
    const url = new URL(req.url);
    const selectedSessionId = url.searchParams.get("session") ?? undefined;

    const activeInstances = fetchActiveInstances(db, params.id);
    return html(agentDetailPage(agent, sessions, selectedSessionId, getPollIntervalSeconds(db), activeInstances));
  });

  addRoute("GET", "/fragments/agents/list", () => {
    const agents = fetchAgents(db);
    return html(agentListPollingFragment(agents, getPollIntervalSeconds(db)));
  });

  addRoute("GET", "/fragments/agents/:id/summary", (_req, params) => {
    const agent = fetchAgentById(db, params.id);
    return html(agentDetailSummaryFragment(agent, getPollIntervalSeconds(db)));
  });

  // Agent terminal output
  addRoute("GET", "/agents/:id/output", (req, params) => {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("session");
    const runtimeIds = getAgentRuntimeIds(db, params.id);
    const runtimePlaceholders = runtimeIds.map(() => "?").join(",");

    let rows: { stream: string; data: string; sequence: number }[];
    if (sessionId) {
      const sessionOwner = db.prepare(
        "SELECT agent_id FROM agent_sessions WHERE id = ?",
      ).get(sessionId) as { agent_id: string } | null;
      if (!sessionOwner || !runtimeIds.includes(sessionOwner.agent_id)) {
        return html(terminalOutputFragment([]));
      }
      rows = db.prepare(
        "SELECT stream, data, sequence FROM terminal_outputs WHERE agent_id = ? AND session_id = ? ORDER BY sequence",
      ).all(sessionOwner.agent_id, sessionId) as { stream: string; data: string; sequence: number }[];
    } else {
      // Default: show latest session's output
      const latestSession = db.prepare(
        `SELECT id, agent_id
         FROM agent_sessions
         WHERE agent_id IN (${runtimePlaceholders})
         ORDER BY created_at DESC
         LIMIT 1`,
      ).get(...runtimeIds) as { id: string; agent_id: string } | null;

      if (latestSession) {
        rows = db.prepare(
          "SELECT stream, data, sequence FROM terminal_outputs WHERE agent_id = ? AND session_id = ? ORDER BY sequence",
        ).all(latestSession.agent_id, latestSession.id) as { stream: string; data: string; sequence: number }[];
      } else {
        // Fallback for outputs without session_id (pre-migration data)
        rows = db.prepare(
          `SELECT stream, data, sequence
           FROM terminal_outputs
           WHERE agent_id IN (${runtimePlaceholders})
           ORDER BY id DESC
           LIMIT 400`,
        ).all(...runtimeIds) as { stream: string; data: string; sequence: number }[];
        rows = rows.reverse();
      }
    }
    return html(terminalOutputFragment(rows));
  });

  // Teams list
  addRoute("GET", "/teams", () => {
    const teams = fetchTeams(db);
    return html(teamsPage(teams, getPollIntervalSeconds(db)));
  });

  // Team detail
  addRoute("GET", "/teams/:id", (_req, params) => {
    const team = fetchTeamById(db, params.id);
    if (!team) return new Response("<p>Team not found</p>", { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
    const agents = fetchTeamMembers(db, params.id);
    const availableAgents = fetchAvailableTeamAgents(db, params.id);
    return html(teamDetailPage(team, agents, availableAgents, getPollIntervalSeconds(db)));
  });

  addRoute("GET", "/fragments/teams/list", () => {
    const teams = fetchTeams(db);
    return html(teamListPollingFragment(teams, getPollIntervalSeconds(db)));
  });

  addRoute("GET", "/fragments/teams/:id/summary", (_req, params) => {
    const team = fetchTeamById(db, params.id);
    const agents = team ? fetchTeamMembers(db, params.id) : [];
    return html(teamDetailSummaryFragment(team, agents, getPollIntervalSeconds(db)));
  });

  addRoute("GET", "/fragments/teams/:id/members", (_req, params) => {
    const team = fetchTeamById(db, params.id);
    const agents = team ? fetchTeamMembers(db, params.id) : [];
    const availableAgents = team ? fetchAvailableTeamAgents(db, params.id) : [];
    return html(teamMembersFragment(team, agents, availableAgents, getPollIntervalSeconds(db)));
  });

  // Escalations
  addRoute("GET", "/escalations", () => {
    daemon.getEscalationManager().reconcileOpenEscalationsForInactiveTasks();
    const rows = db.prepare(
      `SELECT e.*, t.status as task_status
       FROM escalations e
       LEFT JOIN tasks t ON t.id = e.task_id
       ORDER BY e.created_at DESC`,
    ).all() as EscalationData[];
    return html(escalationsPage(rows));
  });

  // Escalation resolve
  addRoute("POST", "/api/escalations/:id/resolve", async (req, params) => {
    let body: Record<string, string>;
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await req.formData();
      body = {};
      formData.forEach((value, key) => { body[key] = value.toString(); });
    } else {
      body = await req.json();
    }
    if (!body.response) {
      return Response.json({ error: "response is required" }, { status: 400 });
    }

    try {
      await daemon.getEscalationManager().resolveEscalation(params.id, body.response);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }

    // Redirect back to escalations page
    daemon.getEscalationManager().reconcileOpenEscalationsForInactiveTasks();
    const rows = db.prepare(
      `SELECT e.*, t.status as task_status
       FROM escalations e
       LEFT JOIN tasks t ON t.id = e.task_id
       ORDER BY e.created_at DESC`,
    ).all() as EscalationData[];
    return html(escalationsPage(rows));
  });

  // Agent Logs page
  addRoute("GET", "/logs", (req) => {
    const url = new URL(req.url);
    const filters: LogFilters = {};
    const conditions: string[] = [];
    const values: unknown[] = [];

    const agentId = url.searchParams.get("agent_id");
    if (agentId) { filters.agent_id = agentId; conditions.push("t.agent_id = ?"); values.push(agentId); }

    const stream = url.searchParams.get("stream");
    if (stream) { filters.stream = stream; conditions.push("t.stream = ?"); values.push(stream); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const entries = db.prepare(
      `SELECT t.id, t.agent_id,
              COALESCE(a.name, ta.name, ai.template_agent_id, t.agent_id) as agent_name,
              t.session_id, t.stream, t.data, t.sequence, t.created_at
       FROM terminal_outputs t
       LEFT JOIN agents a ON t.agent_id = a.id
       LEFT JOIN agent_instances ai ON t.agent_id = ai.id
       LEFT JOIN agents ta ON ta.id = ai.template_agent_id
       ${where}
       ORDER BY t.id DESC LIMIT 200`,
    ).all(...values) as LogEntryData[];

    const agents = db.prepare("SELECT id, name FROM agents ORDER BY name").all() as { id: string; name: string }[];

    return html(logsPage(entries, filters, agents));
  });

  // Skipper config page
  addRoute("GET", "/skipper", () => {
    const config = getSkipperConfig(db);
    const agentTypes = db
      .prepare("SELECT name, available_models FROM agent_types")
      .all() as { name: string; available_models: string }[];
    return html(skipperConfigPage(config, agentTypes));
  });

  // Help page
  addRoute("GET", "/help", () => {
    return html(helpPage());
  });

  // Events audit log
  addRoute("GET", "/audit-events", (req) => {
    const url = new URL(req.url);
    const filters: AuditEventFilters = {};
    const conditions: string[] = [];
    const values: string[] = [];

    const type = url.searchParams.get("type");
    if (type) { filters.type = type; conditions.push("type = ?"); values.push(type); }

    const taskId = url.searchParams.get("task_id");
    if (taskId) { filters.task_id = taskId; conditions.push("task_id = ?"); values.push(taskId); }

    const agentId = url.searchParams.get("agent_id");
    if (agentId) { filters.agent_id = agentId; conditions.push("source_agent_id = ?"); values.push(agentId); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const events = db.prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT 100`).all(...values) as AuditEventData[];

    return html(auditEventsPage(events, filters));
  });

  // --- SSE Endpoints ---

  addRoute("GET", "/events/tasks", () => {
    return createSSEStream((send) => {
      const handler = (_event: TaskStateChangedEvent) => {
        const tasks = db.prepare("SELECT id, title, status, priority FROM tasks WHERE status IN ('running', 'approved') ORDER BY priority").all();
        send("task:state_changed", dashboardActiveTaskFragment(tasks as { id: string; title: string; status: string; priority: number }[]));
      };
      eventBus.on("task:state_changed", handler);
      return () => eventBus.off("task:state_changed", handler);
    });
  });

  addRoute("GET", "/events/agents", () => {
    return createSSEStream((send) => {
      const handler = (_event: AgentStateChangedEvent) => {
        const agents = db.prepare("SELECT id, name, status, type, current_task_id FROM agents ORDER BY created_at").all();
        send("agent:state_changed", dashboardAgentStatusFragment(agents as {
          id: string;
          name: string;
          status: string;
          type: string;
          current_task_id: string | null;
        }[]));
      };
      eventBus.on("agent:state_changed", handler);
      return () => eventBus.off("agent:state_changed", handler);
    });
  });

  addRoute("GET", "/events/instances", () => {
    return createSSEStream((send) => {
      const sendSnapshot = () => {
        const runningInstances = db.prepare(
          `SELECT ai.id, ai.template_agent_id, COALESCE(a.name, ai.template_agent_id) AS template_agent_name, ai.task_id, t.title AS task_title,
                  ai.status, ai.parent_instance_id, ai.root_instance_id, ai.created_at, ai.updated_at
           FROM agent_instances ai
           LEFT JOIN agents a ON a.id = ai.template_agent_id
           LEFT JOIN tasks t ON t.id = ai.task_id
           WHERE ai.status IN ('running', 'waiting_delegation')
           ORDER BY ai.updated_at DESC`,
        ).all() as DashboardData["runningInstances"];
        const groups = db.prepare(
          `SELECT id, task_id, parent_instance_id, settled_count, expected_count, failed_count, status, created_at
           FROM delegation_groups
           WHERE status = 'running'
           ORDER BY created_at DESC
           LIMIT 10`,
        ).all() as DashboardData["activeDelegationGroups"];
        send("instance:state_changed", dashboardRunningInstancesFragment(runningInstances ?? []));
        send("delegation_group:progress", dashboardDelegationGroupsFragment(groups ?? []));
      };

      const instanceHandler = (_event: InstanceStateChangedEvent) => sendSnapshot();
      const groupHandler = (_event: DelegationGroupProgressEvent) => sendSnapshot();
      eventBus.on("instance:state_changed", instanceHandler);
      eventBus.on("delegation_group:progress", groupHandler);
      return () => {
        eventBus.off("instance:state_changed", instanceHandler);
        eventBus.off("delegation_group:progress", groupHandler);
      };
    });
  });

  addRoute("GET", "/events/agent/:id/output", (_req, params) => {
    return createSSEStream((send) => {
      const handler = (event: AgentOutputEvent) => {
        if (event.agentId === params.id) {
          send("agent:output", renderTerminalOutputChunk(event.stream, event.data));
        }
      };
      eventBus.on("agent:output", handler);
      return () => eventBus.off("agent:output", handler);
    });
  });

  addRoute("GET", "/events/escalations", () => {
    return createSSEStream((send) => {
      const handler = (event: EscalationCreatedEvent) => {
        const row = db.prepare(
          `SELECT e.*, t.status as task_status
           FROM escalations e
           LEFT JOIN tasks t ON t.id = e.task_id
           WHERE e.id = ?`,
        ).get(event.escalationId) as EscalationData | null;
        if (row) {
          send("escalation:created", escalationCardHtml(row));
        }
      };
      eventBus.on("escalation:created", handler);
      return () => eventBus.off("escalation:created", handler);
    });
  });

  // All-agents log feed for dashboard activity section
  addRoute("GET", "/events/logs", () => {
    return createSSEStream((send) => {
      const handler = (_event: AgentOutputEvent) => {
        const recentLogs = db.prepare(
          `SELECT to2.agent_id,
                  COALESCE(a.name, ta.name, ai.template_agent_id, to2.agent_id) as agent_name,
                  to2.stream, to2.data, to2.created_at
           FROM terminal_outputs to2
           LEFT JOIN agents a ON to2.agent_id = a.id
           LEFT JOIN agent_instances ai ON to2.agent_id = ai.id
           LEFT JOIN agents ta ON ta.id = ai.template_agent_id
           ORDER BY to2.id DESC LIMIT 10`,
        ).all() as RecentLogEntry[];
        send("logs:activity", recentActivityFragment(recentLogs));
      };
      eventBus.on("agent:output", handler);
      return () => eventBus.off("agent:output", handler);
    });
  });

  // Metrics fragment
  addRoute("GET", "/fragments/metrics", () => {
    const mttrRow = db.prepare(
      `SELECT AVG((julianday(completed_at) - julianday(started_at)) * 24 * 60) as mttr
       FROM tasks
       WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
         AND completed_at > datetime('now', '-7 days')`,
    ).get() as { mttr: number | null } | null;

    const stuckRow = db.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN unixepoch('now') - unixepoch(updated_at) > 600 THEN 1 ELSE 0 END) as stuck
       FROM tasks WHERE status = 'running'`,
    ).get() as { total: number; stuck: number };

    const delegationRow = db.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as succeeded
       FROM delegations
       WHERE created_at > datetime('now', '-7 days')`,
    ).get() as { total: number; succeeded: number };

    const remediationCount = (db.prepare(
      "SELECT COUNT(*) as count FROM events WHERE type LIKE 'remediation:%' AND created_at > datetime('now', '-24 hours')",
    ).get() as { count: number }).count;

    return html(metricsFragment({
      mttrMinutes: mttrRow?.mttr ?? null,
      stuckTaskCount: stuckRow.stuck ?? 0,
      totalRunningTasks: stuckRow.total ?? 0,
      delegationSuccessRate: delegationRow.total > 0 ? delegationRow.succeeded / delegationRow.total : null,
      remediationEventCount: remediationCount,
    }));
  });

  // Diagnostic route
  addRoute("GET", "/api/tasks/:id/diagnostic", (_req, params) => {
    const diagnostic = daemon.getHealthMonitor().generateWhyStuckDiagnostic(params.id);
    if (!diagnostic) {
      return html(`<div class="card"><p>Task not found</p></div>`);
    }
    return html(diagnosticCard(diagnostic));
  });
}

function escalationCardHtml(esc: EscalationData): string {
  const taskStatus = esc.task_status ? ` (${escapeHtml(esc.task_status)})` : "";
  return `<div class="card escalation-card">
    <div class="escalation-header">
      <span class="badge badge-${escapeHtml(esc.status)}">${escapeHtml(esc.status)}</span>
      <span class="badge">${escapeHtml(esc.type)}</span>
      <span class="muted">${formatTimestamp(esc.created_at)}</span>
    </div>
    <div class="escalation-question"><strong>Question:</strong> ${escapeHtml(esc.question)}</div>
    <div class="muted">Agent: ${escapeHtml(esc.agent_id.slice(0, 8))} | Task: ${escapeHtml(esc.task_id.slice(0, 8))}${taskStatus}</div>
    <form hx-post="/api/escalations/${escapeHtml(esc.id)}/resolve" hx-target="body" hx-swap="innerHTML" class="escalation-form">
      <textarea name="response" placeholder="Type your response..." rows="3" required></textarea>
      <button type="submit">Respond</button>
    </form>
  </div>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function createSSEStream(setup: (send: (event: string, data: string) => void) => () => void): Response {
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: string) => {
        const lines = data.replace(/\n/g, "\ndata: ");
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${lines}\n\n`));
        } catch (err) {
          logError(getDb(), "routes.pages.sse_stream_write", { event }, err);
          cleanup?.();
        }
      };
      cleanup = setup(send);
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
