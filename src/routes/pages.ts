import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { getRealtimeTeamId, listTeamsForStandardTasks } from "../config/teams";
import { isAgentVisible, isTeamVisible, isExperimental } from "../config/feature-flags";
import { listPreferences, setPreference } from "../notifications/store";
import { NOTIFICATION_EVENTS, type NotificationEventKey } from "../notifications/types";
import { readFileSync } from "fs";
import { join } from "path";
import {
  fetchTasksWithTeams,
  fetchTaskById,
  fetchTaskDelegations,
  fetchTaskForensics,
  fetchAgents,
  fetchAgentById,
  fetchActiveInstances,
  fetchAgentTypes,
  fetchTeams,
  fetchTeamById,
  fetchTeamMembers,
  fetchAvailableTeamAgents,
  fetchDashboardActiveTeamAgents,
  fetchDashboardRealtimeTimeline,
  fetchDashboardPhaseIndicatorTask,
  fetchTokenAnalyticsByAgentTypeAndModel,
} from "../data/queries";
export {
  fetchTasksWithTeams,
  fetchTaskById,
  fetchTaskDelegations,
  fetchDashboardActiveTeamAgents,
  fetchDashboardRealtimeTimeline,
  fetchDashboardPhaseIndicatorTask,
} from "../data/queries";
// getRealtimeConfig import removed — was only used by v1 dashboard
import {
  taskListPollingFragment,
  taskDetailSummaryFragment,
  taskPhaseStepperFragment,
  taskDelegationsFragment,
  taskForensicsFragment,
  agentDetailSummaryFragment,
  teamListPollingFragment,
  teamDetailSummaryFragment,
  teamMembersFragment,
  terminalOutputFragment,
  logsTableFragment,
} from "../html/components";
import { formatTimestamp } from "../html/formatTimestamp";
import { metricsFragment } from "../html/metricsFragment";
import { agentListPollingFragment } from "../html/agentListPollingFragment";
import { escalationCardPanel, type EscalationCardData } from "../html/panels/escalation-card.panel";
import { logsPage } from "../html/pages/logs.page";
import { dashboardNotesFragment } from "../html/dashboardNotesFragment";
import { dashboardChatCardFragment } from "../html/dashboardChatCardFragment";
import { conversationListFragment } from "../html/conversationListFragment";
import { chatFullscreenView } from "../html/chatFullscreenView";
// dashboardPage import removed — v1 dashboard replaced by v2 command center
import { dashboardRealtimeTimelineFragment } from "../html/dashboardRealtimeTimelineFragment";
import { dashboardPhaseIndicatorFragment } from "../html/dashboardPhaseIndicatorFragment";
import { dashboardActiveAgentsCountFragment } from "../html/dashboardActiveAgentsCountFragment";
import { dashboardRunningInstancesFragment } from "../html/dashboardRunningInstancesFragment";
import { selectDashboardFocusTasks } from "../html/selectDashboardFocusTasks";
// v1 task page imports removed — replaced by v2 pages
import { diagnosticCard } from "../html/diagnosticCard";
import { analyticsPage } from "../html/pages/analytics.page";
import { dashboardActiveTaskFragment } from "../html/dashboardActiveTaskFragment";
// configurationPage import removed — replaced by v2 config page
import { helpPage } from "../html/pages/help.page";
import { asteroidsPage } from "../html/pages/asteroids.page";
import { scheduledTaskCreatePage } from "../html/pages/scheduled-task-create.page";
import { dashboardSteerListFragment, type SteeringOption } from "../html/dashboardLatestSteerFragment";
import { getNumberSetting, setNumberSetting, SETTING_LOG_RETENTION_HOURS } from "../config/app-settings";
import { recentActivityFragment } from "../html/recentActivityFragment";
import type {
  DashboardData,
  PollIntervalSeconds,
  AgentData,
  AgentInstanceSummary,
  EscalationData,
  TaskNoteData,
  AuditEventData,
  AuditEventFilters,
  LogEntryData,
  LogFilters,
  RecentLogEntry,
  RuntimeSteeringViewModel,
} from "../html/components";
import type { ManagerDaemon } from "../agents/manager-daemon";
import { htmlResponse as html } from "./utils";
import { fetchLatestAssistantMessage } from "../ws/ui-push";

const LOGS_PAGE_LIMIT = 1000;
const DASHBOARD_ACTIVITY_LIMIT = 250;

export function getPollIntervalSeconds(db: ReturnType<typeof getDb>): PollIntervalSeconds {
  const row = db.prepare(
    `SELECT
      EXISTS(SELECT 1 FROM tasks WHERE status IN ('running', 'approved')) AS has_active_task,
      EXISTS(SELECT 1 FROM agent_instances WHERE status IN ('running', 'waiting_delegation', 'pending')) AS has_busy_agent`,
  ).get() as { has_active_task: number; has_busy_agent: number };

  return (row.has_active_task === 1 || row.has_busy_agent === 1) ? 3 : 8;
}


function buildRuntimeSteeringViewModel(
  agent: AgentData,
  activeInstances: AgentInstanceSummary[],
  daemon: Pick<ManagerDaemon, "listRuntimeSteeringOptions">,
): RuntimeSteeringViewModel {
  const steeringOptions = daemon.listRuntimeSteeringOptions(agent.id);
  const steerableOptions = steeringOptions
    .filter((option) => option.can_steer)
    .map((option) => ({
      id: option.id,
      task_id: option.task_id,
      task_title: option.task_title,
      created_at: option.created_at,
      session_id: option.session_id,
    }));

  const steeringById = new Map(steeringOptions.map((option) => [option.id, option]));
  for (const instance of activeInstances) {
    const steering = steeringById.get(instance.id);
    instance.can_steer = steering?.can_steer ?? false;
    instance.disabled_reason = steering?.disabled_reason ?? null;
    instance.session_id = steering?.session_id ?? null;
  }

  if (steerableOptions.length > 0) {
    return { enabled: true, reason: null, options: steerableOptions };
  }

  const disabledReason = steeringOptions.map((option) => option.disabled_reason).find((reason) => !!reason);
  if (disabledReason) {
    return { enabled: false, reason: disabledReason, options: [] };
  }
  if (activeInstances.length > 0) {
    return { enabled: false, reason: "No active runtime is currently steerable.", options: [] };
  }
  return { enabled: false, reason: "No running runtime is available to steer.", options: [] };
}

function buildDashboardSteeringOptions(
  agents: DashboardData["agents"],
  daemon: Pick<ManagerDaemon, "listRuntimeSteeringOptions">,
): NonNullable<DashboardData["dashboardSteeringOptions"]> {
  return agents.flatMap((agent) =>
    daemon.listRuntimeSteeringOptions(agent.id).map((option) => ({
      template_agent_id: agent.id,
      agent_name: agent.name,
      runtime_id: option.id,
      task_id: option.task_id,
      task_title: option.task_title,
      session_id: option.session_id,
      can_steer: option.can_steer,
      disabled_reason: option.disabled_reason,
    })),
  );
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

  // Old v1 Dashboard — replaced by v2 command center (now at /)
  // addRoute("GET", "/", () => { ... });

  // Recent logs fragment (for SSE-triggered HTMX refresh fallback)
  addRoute("GET", "/api/logs/recent", () => {
    const recentLogs = db.prepare(
      `WITH ranked AS (
         SELECT to2.id,
                to2.agent_id,
                COALESCE(a.name, ta.name, ai.template_agent_id, to2.agent_id) AS agent_name,
                to2.stream,
                to2.data,
                to2.created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY to2.agent_id, to2.stream, to2.data, to2.created_at
                  ORDER BY to2.id DESC
                ) AS rn
         FROM terminal_outputs to2
         LEFT JOIN agents a ON to2.agent_id = a.id
         LEFT JOIN agent_instances ai ON to2.agent_id = ai.id
         LEFT JOIN agents ta ON ta.id = ai.template_agent_id
         WHERE NOT (json_valid(to2.data) = 1 AND json_extract(to2.data, '$.type') = 'result')
       )
       SELECT agent_id, agent_name, stream, data, created_at
       FROM ranked
       WHERE rn = 1
       ORDER BY id DESC
       LIMIT ${DASHBOARD_ACTIVITY_LIMIT}`,
    ).all() as RecentLogEntry[];
    return html(recentActivityFragment(recentLogs));
  });

  // Old v1 Tasks routes — replaced by v2 (now at /tasks, /tasks/new, /tasks/:id)
  // addRoute("GET", "/tasks", () => { ... });
  // addRoute("GET", "/tasks/new", () => { ... });
  // addRoute("GET", "/tasks/:id", () => { ... });

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

  addRoute("GET", "/fragments/tasks/:id/notes", (_req, params) => {
    const notes = db.prepare(
      `SELECT n.*, a.name AS agent_name
       FROM task_notes n
       LEFT JOIN agents a ON a.id = n.agent_id
       WHERE n.task_id = ?
       ORDER BY n.created_at DESC
       LIMIT 30`,
    ).all(params.id) as TaskNoteData[];
    return html(dashboardNotesFragment(notes, params.id));
  });

  // Artifact list fragment — shows only the latest version of each artifact name
  addRoute("GET", "/fragments/tasks/:id/artifacts", (_req, params) => {
    const taskId = params.id;
    const rows = db.prepare(
      `SELECT a.id, a.name, a.version, a.kind, a.description, a.created_at
       FROM task_artifacts a
       INNER JOIN (
         SELECT name, MAX(version) AS max_version
         FROM task_artifacts
         WHERE task_id = ?
         GROUP BY name
       ) latest ON a.name = latest.name AND a.version = latest.max_version
       WHERE a.task_id = ?
       ORDER BY a.created_at DESC
       LIMIT 50`,
    ).all(taskId, taskId) as { id: string; name: string; version: number; kind: string; description: string | null; created_at: string }[];

    if (rows.length === 0) {
      return html(`<p class="muted">No artifacts yet.</p>`);
    }

    const tableRows = rows.map((r) =>
      `<tr>
        <td><a href="#" onclick="openTaskArtifactModal(); return false;" hx-get="/fragments/tasks/${escapeHtml(taskId)}/artifacts/${encodeURIComponent(r.name)}" hx-target="#task-artifact-modal-body" hx-swap="innerHTML">${escapeHtml(r.name)}</a></td>
        <td>${escapeHtml(r.kind)}</td>
        <td>v${r.version}</td>
        <td>${formatTimestamp(r.created_at)}</td>
      </tr>`,
    ).join("");

    return html(`<table class="data-table">
      <thead><tr><th>Name</th><th>Kind</th><th>Version</th><th>Updated</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>`);
  });

  // Artifact detail fragment
  addRoute("GET", "/fragments/tasks/:id/artifacts/:name", (req, params) => {
    const taskId = params.id;
    const artifactName = params.name;
    const url = new URL(req.url);
    const versionParam = url.searchParams.get("version") ?? "latest";

    let artifact: { id: string; name: string; version: number; kind: string; description: string | null; body: string | null; created_at: string } | null;
    if (versionParam === "latest") {
      artifact = db.prepare(
        `SELECT * FROM task_artifacts WHERE task_id = ? AND name = ? ORDER BY version DESC LIMIT 1`,
      ).get(taskId, artifactName) as typeof artifact;
    } else {
      artifact = db.prepare(
        `SELECT * FROM task_artifacts WHERE task_id = ? AND name = ? AND version = ?`,
      ).get(taskId, artifactName, Number(versionParam)) as typeof artifact;
    }

    if (!artifact) {
      return html(`<p class="muted">Artifact not found.</p>`);
    }

    // Fetch all versions for navigation
    const versions = db.prepare(
      `SELECT version, created_at FROM task_artifacts WHERE task_id = ? AND name = ? ORDER BY version DESC`,
    ).all(taskId, artifactName) as { version: number; created_at: string }[];

    const versionLinks = versions.map((v) => {
      const isCurrent = v.version === artifact!.version;
      if (isCurrent) {
        return `<span class="badge badge-info">v${v.version}</span>`;
      }
      return `<a href="#" onclick="openTaskArtifactModal(); return false;" hx-get="/fragments/tasks/${escapeHtml(taskId)}/artifacts/${encodeURIComponent(artifactName)}?version=${v.version}" hx-target="#task-artifact-modal-body" hx-swap="innerHTML" class="badge">v${v.version}</a>`;
    }).join(" ");

    return html(renderArtifactDetail(artifact, taskId, versionLinks));
  });

  // Dashboard artifact list (modal launcher)
  addRoute("GET", "/fragments/dashboard/tasks/:id/artifacts", (_req, params) => {
    const taskId = params.id;
    const rows = db.prepare(
      `SELECT a.id, a.name, a.version, a.kind, a.description, a.created_at
       FROM task_artifacts a
       INNER JOIN (
         SELECT name, MAX(version) AS max_version
         FROM task_artifacts
         WHERE task_id = ?
         GROUP BY name
       ) latest ON a.name = latest.name AND a.version = latest.max_version
       WHERE a.task_id = ?
       ORDER BY a.created_at DESC
       LIMIT 50`,
    ).all(taskId, taskId) as { id: string; name: string; version: number; kind: string; description: string | null; created_at: string }[];

    if (rows.length === 0) {
      return html(`<p class="muted">No artifacts yet.</p>`);
    }

    const tableRows = rows.map((r) =>
      `<tr>
        <td><a href="#" onclick="openDashboardArtifactModal(); return false;" hx-get="/fragments/dashboard/tasks/${escapeHtml(taskId)}/artifacts/${encodeURIComponent(r.name)}" hx-target="#dashboard-artifact-modal-body" hx-swap="innerHTML">${escapeHtml(r.name)}</a></td>
        <td>${escapeHtml(r.kind)}</td>
        <td>v${r.version}</td>
        <td>${formatTimestamp(r.created_at)}</td>
      </tr>`,
    ).join("");

    return html(`<table class="data-table">
      <thead><tr><th>Name</th><th>Kind</th><th>Version</th><th>Updated</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>`);
  });

  // Dashboard artifact detail (modal body)
  addRoute("GET", "/fragments/dashboard/tasks/:id/artifacts/:name", (req, params) => {
    const taskId = params.id;
    const artifactName = params.name;
    const url = new URL(req.url);
    const versionParam = url.searchParams.get("version") ?? "latest";

    let artifact: { id: string; name: string; version: number; kind: string; description: string | null; body: string | null; created_at: string } | null;
    if (versionParam === "latest") {
      artifact = db.prepare(
        `SELECT * FROM task_artifacts WHERE task_id = ? AND name = ? ORDER BY version DESC LIMIT 1`,
      ).get(taskId, artifactName) as typeof artifact;
    } else {
      artifact = db.prepare(
        `SELECT * FROM task_artifacts WHERE task_id = ? AND name = ? AND version = ?`,
      ).get(taskId, artifactName, Number(versionParam)) as typeof artifact;
    }

    if (!artifact) {
      return html(`<p class="muted">Artifact not found.</p>`);
    }

    const versions = db.prepare(
      `SELECT version, created_at FROM task_artifacts WHERE task_id = ? AND name = ? ORDER BY version DESC`,
    ).all(taskId, artifactName) as { version: number; created_at: string }[];

    const versionLinks = versions.map((v) => {
      const isCurrent = v.version === artifact!.version;
      if (isCurrent) {
        return `<span class="badge badge-info">v${v.version}</span>`;
      }
      return `<a href="#" onclick="openDashboardArtifactModal(); return false;" hx-get="/fragments/dashboard/tasks/${escapeHtml(taskId)}/artifacts/${encodeURIComponent(artifactName)}?version=${v.version}" hx-target="#dashboard-artifact-modal-body" hx-swap="innerHTML" class="badge">v${v.version}</a>`;
    }).join(" ");

    return html(renderArtifactDetail(artifact, taskId, versionLinks));
  });

  addRoute("GET", "/fragments/tasks/:id/forensics", (_req, params) => {
    const forensics = fetchTaskForensics(db, params.id);
    return html(taskForensicsFragment(params.id, forensics, getPollIntervalSeconds(db)));
  });

  // Old v1 Configuration page — replaced by v2 (now at /config)
  // addRoute("GET", "/config", () => { ... });

  // Legacy redirects → unified config page
  addRoute("GET", "/skipper", () => {
    return new Response(null, { status: 302, headers: { Location: "/config" } });
  });

  // Agents list (legacy redirect)
  addRoute("GET", "/agents", () => {
    return new Response(null, { status: 302, headers: { Location: "/config" } });
  });

  // Agent detail (v1 redirect → config page)
  addRoute("GET", "/agents/:id", (_req, params) => {
    return new Response(null, { status: 302, headers: { Location: `/config/agents/${params.id}` } });
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
    return new Response(null, { status: 302, headers: { Location: "/config" } });
  });

  addRoute("GET", "/teams/new", () => {
    return new Response(null, { status: 302, headers: { Location: "/config" } });
  });

  // Team detail (v1 redirect → config page)
  addRoute("GET", "/teams/:id", () => {
    return new Response(null, { status: 302, headers: { Location: "/config" } });
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

  // Old v1 Escalations page — replaced by v2 (now at /escalations)
  // addRoute("GET", "/escalations", () => { ... });

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
      await daemon.resolveEscalation(params.id, body.response);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }

    daemon.getEscalationManager().reconcileOpenEscalationsForInactiveTasks();
    return new Response(null, { status: 302, headers: { Location: "/escalations" } });
  });

  addRoute("POST", "/api/escalations/:id/dismiss", (_req, params) => {
    try {
      daemon.getEscalationManager().dismissEscalation(params.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }

    daemon.getEscalationManager().reconcileOpenEscalationsForInactiveTasks();
    return new Response(null, { status: 302, headers: { Location: "/escalations" } });
  });

  // Fragment routes: resolve/dismiss returning a single rendered card.
  // Used by escalation-card.panel.ts on the task page and escalations queue page so
  // htmx can swap just the card (#escalation-<id>) instead of the full page.
  // The navbar badge + dashboard panels are refreshed over WS by ui-push.ts so we do
  // not need to return any additional fragments here.
  const fetchEscalationCard = (id: string): EscalationCardData | null => {
    return db.prepare(
      `SELECT e.id, e.agent_id, e.task_id, t.title AS task_title,
              e.type, e.question, e.status, e.response, e.created_at, e.resolved_at
       FROM escalations e
       LEFT JOIN tasks t ON t.id = e.task_id
       WHERE e.id = ?`,
    ).get(id) as EscalationCardData | null;
  };

  addRoute("POST", "/fragments/escalations/:id/resolve", async (req, params) => {
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
      return new Response("response is required", { status: 400 });
    }
    try {
      await daemon.resolveEscalation(params.id, body.response);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      return new Response(message, { status: 400 });
    }
    const card = fetchEscalationCard(params.id);
    if (!card) return new Response("", { status: 200 });
    return html(escalationCardPanel(card));
  });

  addRoute("POST", "/fragments/escalations/:id/dismiss", (_req, params) => {
    try {
      daemon.getEscalationManager().dismissEscalation(params.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      return new Response(message, { status: 400 });
    }
    const card = fetchEscalationCard(params.id);
    if (!card) return new Response("", { status: 200 });
    return html(escalationCardPanel(card));
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
       ORDER BY t.id DESC LIMIT ${LOGS_PAGE_LIMIT}`,
    ).all(...values) as LogEntryData[];

    const agents = db.prepare("SELECT id, name FROM agents ORDER BY name").all() as { id: string; name: string }[];
    const status = daemon.getStatus();
    const escalationCount = (db.prepare("SELECT COUNT(*) as c FROM escalations WHERE status = 'open'").get() as { c: number }).c;

    return html(logsPage({
      entries,
      filters,
      agents,
      daemonState: status.state,
      daemonUptime: status.uptime,
      escalationCount,
    }));
  });

  // Skipper config page
  // Help page
  addRoute("GET", "/help", () => {
    const status = daemon.getStatus();
    const escalationCount = (db.prepare("SELECT COUNT(*) as c FROM escalations WHERE status = 'open'").get() as { c: number }).c;
    return html(helpPage({ daemonState: status.state, daemonUptime: status.uptime, escalationCount }));
  });

  addRoute("GET", "/games/asteroids", () => {
    const status = daemon.getStatus();
    const escalationCount = (db.prepare("SELECT COUNT(*) as c FROM escalations WHERE status = 'open'").get() as { c: number }).c;
    return html(asteroidsPage({ daemonState: status.state, daemonUptime: status.uptime, escalationCount }));
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

    // TODO: rebuild auditEventsPage — lost in accidental git checkout revert
    return html(`<html><body><h1>Audit Events</h1><p>Page stub — needs rebuild</p><pre>${JSON.stringify(events.slice(0, 20), null, 2)}</pre></body></html>`);
  });

  // Dashboard fragment routes (initial load — live updates via WebSocket push)
  addRoute("GET", "/fragments/dashboard/active-tasks", () => {
    const tasks = db.prepare(
      `SELECT id, title, status, task_type, created_at
       FROM tasks
       WHERE status IN ('running', 'approved', 'completed')
       ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC`,
    ).all() as { id: string; title: string; status: string; task_type?: string; created_at?: string }[];
    return html(dashboardActiveTaskFragment(selectDashboardFocusTasks(tasks)));
  });

  addRoute("GET", "/fragments/dashboard/running-instances", () => {
    const runningInstances = db.prepare(
      `SELECT ai.id, ai.template_agent_id, COALESCE(a.name, ai.template_agent_id) AS template_agent_name, ai.task_id, t.title AS task_title,
              ai.status, ai.parent_instance_id, ai.root_instance_id, ai.created_at, ai.updated_at
       FROM agent_instances ai
       LEFT JOIN agents a ON a.id = ai.template_agent_id
       LEFT JOIN tasks t ON t.id = ai.task_id
       WHERE ai.status IN ('running', 'waiting_delegation')
       ORDER BY ai.updated_at DESC`,
    ).all() as NonNullable<DashboardData["runningInstances"]>;
    return html(dashboardRunningInstancesFragment(runningInstances));
  });

  addRoute("GET", "/fragments/dashboard/running-instances-count", () => {
    const runningInstances = db.prepare(
      `SELECT ai.id, ai.template_agent_id, COALESCE(a.name, ai.template_agent_id) AS template_agent_name, ai.task_id, t.title AS task_title,
              ai.status, ai.parent_instance_id, ai.root_instance_id, ai.created_at, ai.updated_at
       FROM agent_instances ai
       LEFT JOIN agents a ON a.id = ai.template_agent_id
       LEFT JOIN tasks t ON t.id = ai.task_id
       WHERE ai.status IN ('running', 'waiting_delegation')
       ORDER BY ai.updated_at DESC`,
    ).all() as NonNullable<DashboardData["runningInstances"]>;
    return html(dashboardActiveAgentsCountFragment(runningInstances, getPollIntervalSeconds(db)));
  });

  addRoute("GET", "/fragments/dashboard/realtime-timeline", (req) => {
    const url = new URL(req.url);
    const taskId = url.searchParams.get("task_id");
    if (taskId) {
      const entries = db.prepare(
        `SELECT id, entry_type, content, priority, created_at
         FROM realtime_timeline WHERE task_id = ?
         ORDER BY created_at DESC LIMIT 250`,
      ).all(taskId) as { id: string; entry_type: string; content: string; priority: string; created_at: string }[];
      const task = db.prepare("SELECT id, title FROM tasks WHERE id = ?").get(taskId) as { id: string; title: string } | null;
      return html(dashboardRealtimeTimelineFragment(task ? { taskId, taskTitle: task.title, entries } : null));
    }
    return html(dashboardRealtimeTimelineFragment(fetchDashboardRealtimeTimeline(db)));
  });

  addRoute("GET", "/fragments/dashboard/phase-indicator", () => {
    return html(dashboardPhaseIndicatorFragment(fetchDashboardPhaseIndicatorTask(db)));
  });

  addRoute("GET", "/fragments/logs/table", (req) => {
    const url = new URL(req.url);
    const conditions: string[] = [];
    const values: unknown[] = [];

    const agentId = url.searchParams.get("agent_id");
    if (agentId) { conditions.push("t.agent_id = ?"); values.push(agentId); }

    const stream = url.searchParams.get("stream");
    if (stream) { conditions.push("t.stream = ?"); values.push(stream); }

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
       ORDER BY t.id DESC LIMIT ${LOGS_PAGE_LIMIT}`,
    ).all(...values) as LogEntryData[];

    return html(logsTableFragment(entries));
  });

  addRoute("GET", "/fragments/dashboard/recent-activity", () => {
    const hasRunningTask = (db.prepare(
      "SELECT EXISTS(SELECT 1 FROM tasks WHERE status = 'running') AS has_running_task",
    ).get() as { has_running_task: number }).has_running_task === 1;
    if (!hasRunningTask) {
      return html(recentActivityFragment([]));
    }
    const recentLogs = db.prepare(
      `WITH ranked AS (
         SELECT to2.id,
                to2.agent_id,
                COALESCE(a.name, ta.name, ai.template_agent_id, to2.agent_id) AS agent_name,
                to2.stream,
                to2.data,
                to2.created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY to2.agent_id, to2.stream, to2.data, to2.created_at
                  ORDER BY to2.id DESC
                ) AS rn
         FROM terminal_outputs to2
         LEFT JOIN agents a ON to2.agent_id = a.id
         LEFT JOIN agent_instances ai ON to2.agent_id = ai.id
         LEFT JOIN agents ta ON ta.id = ai.template_agent_id
         WHERE NOT (json_valid(to2.data) = 1 AND json_extract(to2.data, '$.type') = 'result')
       )
       SELECT agent_id, agent_name, stream, data, created_at
       FROM ranked
       WHERE rn = 1
       ORDER BY id DESC
       LIMIT ${DASHBOARD_ACTIVITY_LIMIT}`,
    ).all() as RecentLogEntry[];
    return html(recentActivityFragment(recentLogs));
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

  // Latest steer fragment — polled every 3s by command-center task view
  addRoute("GET", "/fragments/dashboard/latest-steer", (req) => {
    const url = new URL(req.url);
    const taskId = url.searchParams.get("task");

    const instances = db.prepare(
      `SELECT ai.id AS runtime_id, ai.template_agent_id,
              COALESCE(a.name, ai.template_agent_id) AS agent_name,
              ai.task_id, t.title AS task_title, ai.status, ai.process_pid,
              ai.session_id
       FROM agent_instances ai
       LEFT JOIN agents a ON a.id = ai.template_agent_id
       LEFT JOIN tasks t ON t.id = ai.task_id
       WHERE ai.status IN ('running', 'waiting_delegation')
       ${taskId ? "AND ai.task_id = ?" : ""}
       ORDER BY ai.updated_at DESC`,
    ).all(...(taskId ? [taskId] : [])) as Array<{
      runtime_id: string; template_agent_id: string; agent_name: string;
      task_id: string; task_title: string | null; status: string;
      process_pid: number | null; session_id: string | null;
    }>;

    const options: SteeringOption[] = instances.map((inst) => ({
      template_agent_id: inst.template_agent_id,
      agent_name: inst.agent_name,
      runtime_id: inst.runtime_id,
      task_id: inst.task_id,
      task_title: inst.task_title,
      session_id: inst.session_id,
      process_pid: inst.process_pid,
      can_steer: inst.status === "running",
      disabled_reason: inst.status !== "running" ? "Agent is not in a steerable state" : null,
      latest_message: fetchLatestAssistantMessage(db, inst.runtime_id),
    }));

    return html(dashboardSteerListFragment(options));
  });

  // Task escalation cards — polled every 5s by command-center task view
  addRoute("GET", "/fragments/tasks/:id/escalations", (_req, params) => {
    const escalations = db.prepare(
      `SELECT e.id, e.agent_id, e.task_id, t.title AS task_title,
              e.type, e.question, e.status, e.response, e.created_at, e.resolved_at,
              COALESCE(a.name, e.agent_id) AS agent_name
       FROM escalations e
       LEFT JOIN tasks t ON t.id = e.task_id
       LEFT JOIN agents a ON a.id = e.agent_id
       WHERE e.task_id = ?
       ORDER BY CASE WHEN e.status = 'open' THEN 0 ELSE 1 END, e.created_at DESC`,
    ).all(params.id) as EscalationCardData[];

    const open = escalations.filter((e) => e.status === "open");
    if (open.length === 0) return html("");

    return html(open.map((e) => escalationCardPanel(e)).join(""));
  });

  addRoute("GET", "/analytics/tokens", () => {
    const analytics = fetchTokenAnalyticsByAgentTypeAndModel(db);
    const status = daemon.getStatus();
    const escalationCount = (db.prepare("SELECT COUNT(*) as c FROM escalations WHERE status = 'open'").get() as { c: number }).c;
    return html(analyticsPage({
      analytics,
      daemonState: status.state,
      daemonUptime: status.uptime,
      escalationCount,
    }));
  });

  addRoute("GET", "/api/analytics/tokens/by-agent-type", () => {
    const analytics = fetchTokenAnalyticsByAgentTypeAndModel(db);
    return Response.json(analytics);
  });

  // ── Chat / Conversation fragment routes ──────────────────────────────────

  function loadConversationalSkipperPrompt(): string {
    try {
      return readFileSync(join(import.meta.dir, "../../prompts/conversational-skipper.md"), "utf-8").trim();
    } catch {
      return "You are a conversational Skipper assistant for the Skipper multi-agent orchestration system. Help the user manage tasks and agents.";
    }
  }

  // GET /fragments/dashboard/chat — dashboard chat card (most recently updated active conv)
  const getChatAgentModel = (conv: { template_agent_id: string | null } | null): string | undefined => {
    if (!conv?.template_agent_id) return undefined;
    const agent = db.prepare("SELECT model FROM agents WHERE id = ?").get(conv.template_agent_id) as { model: string } | null;
    return agent?.model;
  };

  addRoute("GET", "/fragments/dashboard/chat", () => {
    const cm = daemon.getConversationManager();
    const conversations = cm.getConversations("active");
    const active = conversations[0] ?? null;
    const messages = active ? cm.getMessages(active.id) : [];
    return html(dashboardChatCardFragment(active, messages, conversations, getChatAgentModel(active)));
  });

  // POST /fragments/conversations — create new conversation, return updated chat card
  addRoute("POST", "/fragments/conversations", async () => {
    const cm = daemon.getConversationManager();
    const systemPrompt = loadConversationalSkipperPrompt();
    let conversation;
    try {
      conversation = await cm.createConversation(systemPrompt);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create conversation";
      return html(`<div class="chat-main"><div class="cmd-panel-header"><span class="cmd-panel-title">Chat</span></div><div class="chat-empty-state"><p class="muted" style="color:var(--error);">${escapeHtml(message)}</p><button class="btn-sm" hx-get="/fragments/dashboard/chat" hx-target="#dashboard-chat-panel" hx-swap="innerHTML">Retry</button></div></div>`);
    }
    const conversations = cm.getConversations("active");
    const messages = cm.getMessages(conversation.id);
    return html(dashboardChatCardFragment(conversation, messages, conversations, getChatAgentModel(conversation)));
  });

  // GET /fragments/chat/:id — chat card for a specific conversation
  addRoute("GET", "/fragments/chat/:id", (_req, params) => {
    const cm = daemon.getConversationManager();
    const conversations = cm.getConversations("active");
    const conversation = cm.getConversation(params.id) ?? null;
    const messages = conversation ? cm.getMessages(params.id) : [];
    return html(dashboardChatCardFragment(conversation, messages, conversations, getChatAgentModel(conversation)));
  });

  // GET /fragments/chat/:id/messages — messages list only (for polling or manual refresh)
  addRoute("GET", "/fragments/chat/:id/messages", (_req, params) => {
    const cm = daemon.getConversationManager();
    const messages = cm.getMessages(params.id);
    const messagesHtml = messages
      .map((msg) => {
        const roleClass =
          msg.role === "user"
            ? "chat-message-user"
            : msg.role === "assistant"
              ? "chat-message-assistant"
              : "chat-message-system";
        const content = escapeHtml(msg.content).replace(/\n/g, "<br>");
        return `<div class="chat-message ${roleClass}" data-message-id="${escapeHtml(msg.id)}"><div class="chat-message-role">${escapeHtml(msg.role)}</div><div class="chat-message-content">${content}</div></div>`;
      })
      .join("");
    return html(`<div id="chat-messages-${escapeHtml(params.id)}">${messagesHtml}</div>`);
  });

  // GET /fragments/conversations-list — sidebar conversation list
  addRoute("GET", "/fragments/conversations-list", (req) => {
    const url = new URL(req.url);
    const activeId = url.searchParams.get("active") ?? undefined;
    const cm = daemon.getConversationManager();
    const conversations = cm.getConversations();
    return html(conversationListFragment(conversations, activeId));
  });

  // GET /fragments/chat/fullscreen/:id — fullscreen chat view (loads content + adds CSS class)
  addRoute("GET", "/fragments/chat/fullscreen/:id", (_req, params) => {
    const cm = daemon.getConversationManager();
    const conversations = cm.getConversations();
    const messages = cm.getMessages(params.id);
    return html(chatFullscreenView(conversations, params.id, messages));
  });

  // Diagnostic route
  addRoute("GET", "/api/tasks/:id/diagnostic", (_req, params) => {
    const diagnostic = daemon.getHealthMonitor().generateWhyStuckDiagnostic(params.id);
    if (!diagnostic) {
      return html(`<div class="card"><p>Task not found</p></div>`);
    }
    return html(diagnosticCard(diagnostic));
  });

  // ── Page routes (v2 frontend, now the default) ──────────────────────────
  registerV2PageRoutes();
}

function registerV2PageRoutes(): void {
  const db = getDb();

  const { commandCenterPage, renderScheduledTaskDetail, renderScheduledRuns } = require("../html/pages/command-center.page");
  const { buildCommandCenterViewModel } = require("../html/view-models/command-center.vm");
  const { taskListPage } = require("../html/pages/task-list.page");
  // task-execution.page and task-execution.vm removed — /tasks/:id redirects to dashboard
  const { agentTerminalPage } = require("../html/pages/agent-terminal.page");
  const { escalationQueuePage } = require("../html/pages/escalation-queue.page");
  const { configPage } = require("../html/pages/config.page");
  // agent-detail.page and team-detail.page removed — config uses inline edit fragments
  const { taskCreatePage } = require("../html/pages/task-create.page");

  const fetchScheduledOverride = (scheduledId: string) => {
    const st = db.prepare(
      `SELECT st.*, tm.name AS team_name FROM scheduled_tasks st LEFT JOIN teams tm ON tm.id = st.team_id WHERE st.id = ?`
    ).get(scheduledId) as any;
    if (!st) return null;
    const teams = (db.prepare("SELECT id, name FROM teams ORDER BY name").all() as Array<{ id: string; name: string }>)
      .filter(t => isTeamVisible(t.id));
    const runs = db.prepare(
      `SELECT id, title, status, started_at, completed_at, result, created_at FROM tasks WHERE source_scheduled_task_id = ? ORDER BY created_at DESC LIMIT 20`
    ).all(scheduledId) as Array<{ id: string; title: string; status: string; started_at: string | null; completed_at: string | null; result: string | null; created_at: string }>;
    return { scheduledTask: st, teams, runs };
  };

  // Command Center (dashboard)
  addRoute("GET", "/", (req) => {
    const url = new URL(req.url);
    const selectedTask = url.searchParams.get("task") ?? undefined;
    const scheduledId = url.searchParams.get("scheduled");
    const vm = buildCommandCenterViewModel(db);

    if (scheduledId && isExperimental()) {
      const override = fetchScheduledOverride(scheduledId);
      if (override) return html(commandCenterPage(vm, undefined, override));
    }

    return html(commandCenterPage(vm, selectedTask));
  });

  // Team options fragment for create form dropdown (standard tasks only — Real Time
  // is the dedicated team for real-time tasks and is selected automatically there).
  addRoute("GET", "/fragments/teams/options", (req) => {
    const url = new URL(req.url, "http://localhost");
    const selected = url.searchParams.get("selected") ?? "";
    const teams = listTeamsForStandardTasks();
    const options = teams.map(t => `<option value="${t.id}"${t.id === selected ? " selected" : ""}>${escapeHtml(t.name)}</option>`).join("");
    return html(`<option value="">Select team...</option>${options}`);
  });

  // Workspace fragment — sidebar clicks load this into #mc-main
  addRoute("GET", "/workspace/task/:id", (_req, params) => {
    const vm = buildCommandCenterViewModel(db);
    const task = vm.allTasks.find((t: any) => t.id === params.id);
    if (!task) return Response.json({ error: "Not found" }, { status: 404 });
    const { taskMainContent, renderDraftEdit, realtimeTaskContent } = require("../html/pages/command-center.page");
    if (task.status === "draft") return html(renderDraftEdit(task, vm.teams));
    if ((task as any).task_type === "real_time") {
      const isSessionActive = vm.realtimeSessionActive?.get(task.id);
      return html(realtimeTaskContent(task, isSessionActive));
    }
    return html(taskMainContent(vm, task));
  });

  // Phase strip fragment — polled by dashboard so phase status updates without a page reload
  addRoute("GET", "/workspace/task/:id/phase-strip", (_req, params) => {
    const vm = buildCommandCenterViewModel(db);
    const task = vm.allTasks.find((t: any) => t.id === params.id);
    if (!task) return html("");
    const mission = vm.missionsByTask?.get(params.id);
    const phases = mission?.phases ?? [];
    const isRunning = task.status === "running";
    const { renderPhaseStripFragment } = require("../html/pages/command-center.page");
    return html(renderPhaseStripFragment(phases, params.id, isRunning));
  });

  // Agent list fragment — polled by dashboard for running tasks
  addRoute("GET", "/workspace/task/:id/agents", (_req, params) => {
    const instances = db.prepare(
      `SELECT ai.id, ai.template_agent_id,
              CASE WHEN json_valid(ai.state_metadata) AND json_extract(ai.state_metadata, '$.role') = 'consensus_reviewer'
                   THEN COALESCE(a.name, ai.template_agent_id) || ' (Reviewer)'
                   ELSE COALESCE(a.name, ai.template_agent_id)
              END AS agent_name,
              ai.parent_instance_id, ai.status, ai.process_pid, ai.task_id
       FROM agent_instances ai
       LEFT JOIN agents a ON a.id = ai.template_agent_id
       WHERE ai.task_id = ? AND ai.status NOT IN ('stopped')
       ORDER BY ai.created_at`
    ).all(params.id) as Array<{
      id: string; agent_name: string; parent_instance_id: string | null;
      status: string; process_pid: number | null; task_id: string;
    }>;

    const { buildAgentTree } = require("../html/view-models/command-center.vm");
    const tree = buildAgentTree(instances);
    const { renderAgentList } = require("../html/pages/command-center.page");
    return html(renderAgentList(tree));
  });

  // Activity feed — parsed terminal output for the activity tab
  addRoute("GET", "/workspace/task/:id/activity", (req, params) => {
    const url = new URL(req.url, "http://localhost");
    const instanceId = url.searchParams.get("instance");

    // Find agent instances for this task
    let agentId: string | null = instanceId;
    if (!agentId) {
      const instances = db.prepare(
        `SELECT ai.id FROM agent_instances ai
         WHERE ai.task_id = ?
         ORDER BY ai.parent_instance_id IS NULL DESC, ai.created_at ASC
         LIMIT 1`
      ).all(params.id) as Array<{ id: string }>;
      agentId = instances[0]?.id ?? null;
    }

    if (!agentId) {
      return html(`<div class="mc-activity__empty">No activity recorded</div>`);
    }

    // Get all sessions for this agent in this task context.
    // Order by t.id (INTEGER PRIMARY KEY AUTOINCREMENT) — globally monotonic
    // insertion order. Do NOT order by t.sequence: sequence is per-agent-instance
    // and collides across agents.
    const rows = db.prepare(
      `SELECT t.stream, t.data, COALESCE(a.name, ai.template_agent_id) AS agent_name, t.created_at
       FROM terminal_outputs t
       JOIN agent_instances ai ON ai.id = t.agent_id
       LEFT JOIN agents a ON a.id = ai.template_agent_id
       WHERE ai.task_id = ?
       ORDER BY t.id DESC LIMIT 200`
    ).all(params.id) as Array<{ stream: string; data: string; agent_name: string; created_at: string }>;

    if (rows.length === 0) {
      return html(`<div class="mc-activity__empty">No activity yet</div>`);
    }

    // Keep newest-first order — feed reads top-down with most recent at the top.
    const { parseTerminalActivity } = require("../html/pages/command-center.page");
    return html(parseTerminalActivity(rows));
  });

  // Terminal output by task ID (finds the root agent instance)
  addRoute("GET", "/workspace/task/:id/terminal", (_req, params) => {
    // Find agent instances for this task, prefer root/entrypoint
    const instances = db.prepare(
      `SELECT ai.id FROM agent_instances ai
       WHERE ai.task_id = ?
       ORDER BY ai.parent_instance_id IS NULL DESC, ai.created_at ASC
       LIMIT 1`
    ).all(params.id) as Array<{ id: string }>;

    if (instances.length === 0) {
      // Try the template agent (entrypoint uses its own ID as instance ID)
      const task = db.prepare("SELECT team_id FROM tasks WHERE id = ?").get(params.id) as { team_id: string | null } | null;
      if (task?.team_id) {
        const team = db.prepare("SELECT entrypoint_agent_id FROM teams WHERE id = ?").get(task.team_id) as { entrypoint_agent_id: string } | null;
        if (team?.entrypoint_agent_id) {
          instances.push({ id: team.entrypoint_agent_id });
        }
      }
    }

    if (instances.length === 0) {
      return html(`<div style="padding: var(--sk-space-4); color: var(--sk-text-subtle); text-align: center;">No terminal output recorded for this task.</div>`);
    }

    // Get output from the root instance
    const agentId = instances[0].id;
    const session = db.prepare(
      "SELECT id FROM agent_sessions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(agentId) as { id: string } | null;

    if (!session) {
      return html(`<div style="padding: var(--sk-space-4); color: var(--sk-text-subtle); text-align: center;">No terminal session found.</div>`);
    }

    const rows = db.prepare(
      "SELECT stream, data, sequence FROM terminal_outputs WHERE agent_id = ? AND session_id = ? ORDER BY sequence LIMIT 500"
    ).all(agentId, session.id) as Array<{ stream: string; data: string; sequence: number }>;

    if (rows.length === 0) {
      return html(`<div style="padding: var(--sk-space-4); color: var(--sk-text-subtle); text-align: center;">No output recorded.</div>`);
    }

    const { terminalOutputFragment } = require("../html/components");
    return html(terminalOutputFragment(rows));
  });

  // Task details fragment (loaded by Details tab)
  addRoute("GET", "/workspace/task/:id/details", (_req, params) => {
    const task = db.prepare(
      `SELECT t.*, tm.name AS team_name FROM tasks t LEFT JOIN teams tm ON tm.id = t.team_id WHERE t.id = ?`
    ).get(params.id) as any;
    if (!task) return html(`<div style="padding:1rem; color:var(--sk-text-subtle);">Task not found</div>`);

    const instances = db.prepare(
      `SELECT ai.id, COALESCE(a.name, ai.template_agent_id) AS agent_name, ai.status, ai.created_at, ai.updated_at
       FROM agent_instances ai LEFT JOIN agents a ON a.id = ai.template_agent_id
       WHERE ai.task_id = ? ORDER BY ai.created_at`
    ).all(params.id) as Array<{ id: string; agent_name: string; status: string; created_at: string; updated_at: string }>;

    const delegations = db.prepare(
      `SELECT d.id, COALESCE(pa.name, d.parent_agent_id) AS parent_name, COALESCE(ca.name, d.child_agent_id) AS child_name, d.status, d.prompt, d.result
       FROM delegations d
       LEFT JOIN agents pa ON pa.id = d.parent_agent_id
       LEFT JOIN agents ca ON ca.id = d.child_agent_id
       WHERE d.task_id = ? ORDER BY d.created_at`
    ).all(params.id) as Array<{ id: string; parent_name: string; child_name: string; status: string; prompt: string; result: string | null }>;

    const esc = escapeHtml;
    const instanceRows = instances.map(i => `<tr><td class="sk-mono sk-text-xs">${esc(i.id.slice(0,8))}</td><td>${esc(i.agent_name)}</td><td><span class="sk-badge sk-badge--${i.status}">${i.status}</span></td><td class="sk-muted sk-text-xs">${formatTimestamp(i.created_at)}</td></tr>`).join("");
    const delegationRows = delegations.map(d => `<tr><td>${esc(d.parent_name)} → ${esc(d.child_name)}</td><td><span class="sk-badge sk-badge--${d.status}">${d.status}</span></td><td class="sk-text-xs sk-muted" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc((d.prompt ?? "").slice(0,100))}</td></tr>`).join("");

    return html(`<div style="padding: var(--sk-space-4); overflow-y:auto;">
      <h3 style="color:var(--sk-text); margin-bottom:var(--sk-space-3); font-size:var(--sk-text-sm);">Task Info</h3>
      <table class="sk-table" style="margin-bottom:var(--sk-space-6);">
        <tr><td class="sk-muted">ID</td><td class="sk-mono sk-text-xs">${esc(task.id)}</td></tr>
        <tr><td class="sk-muted">Status</td><td><span class="sk-badge sk-badge--${task.status}">${task.status}</span></td></tr>
        <tr><td class="sk-muted">Team</td><td>${esc(task.team_name ?? "Unassigned")}</td></tr>
        <tr><td class="sk-muted">Type</td><td>${esc(task.task_type ?? "standard")}</td></tr>
        <tr><td class="sk-muted">Phase</td><td>${task.current_phase + 1}</td></tr>
        <tr><td class="sk-muted">Created</td><td>${formatTimestamp(task.created_at)}</td></tr>
        ${task.completed_at ? `<tr><td class="sk-muted">Completed</td><td>${formatTimestamp(task.completed_at)}</td></tr>` : ""}
        ${task.description ? `<tr><td class="sk-muted">Description</td><td style="white-space:pre-wrap;max-width:500px;">${esc(task.description)}</td></tr>` : ""}
      </table>

      ${instances.length > 0 ? `
        <h3 style="color:var(--sk-text); margin-bottom:var(--sk-space-3); font-size:var(--sk-text-sm);">Agent Instances (${instances.length})</h3>
        <table class="sk-table" style="margin-bottom:var(--sk-space-6);"><thead><tr><th>ID</th><th>Agent</th><th>Status</th><th>Created</th></tr></thead><tbody>${instanceRows}</tbody></table>
      ` : ""}

      ${delegations.length > 0 ? `
        <h3 style="color:var(--sk-text); margin-bottom:var(--sk-space-3); font-size:var(--sk-text-sm);">Delegations (${delegations.length})</h3>
        <table class="sk-table"><thead><tr><th>Flow</th><th>Status</th><th>Prompt</th></tr></thead><tbody>${delegationRows}</tbody></table>
      ` : ""}
    </div>`);
  });

  // Scheduled task workspace fragment (sidebar click loads into #mc-main)
  addRoute("GET", "/workspace/scheduled/:id", (_req, params) => {
    if (!isExperimental()) return html(`<div style="padding:1rem; color:var(--sk-text-subtle);">Scheduled tasks require --experimental</div>`);
    const override = fetchScheduledOverride(params.id);
    if (!override) return html(`<div style="padding:1rem; color:var(--sk-text-subtle);">Scheduled task not found</div>`);
    return html(renderScheduledTaskDetail(override.scheduledTask, override.teams, override.runs));
  });

  // Scheduled task runs fragment (lazy-loaded inside the detail panel)
  addRoute("GET", "/workspace/scheduled/:id/runs", (_req, params) => {
    if (!isExperimental()) return html("");
    const runs = db.prepare(
      `SELECT id, title, status, started_at, completed_at, result, created_at FROM tasks WHERE source_scheduled_task_id = ? ORDER BY created_at DESC LIMIT 20`
    ).all(params.id) as Array<{ id: string; title: string; status: string; started_at: string | null; completed_at: string | null; result: string | null; created_at: string }>;
    return html(renderScheduledRuns(runs));
  });

  // Task Creation — must be before /tasks/:id to avoid matching "new" as an ID
  addRoute("GET", "/tasks/scheduled/new", () => {
    if (!isExperimental()) return new Response("Not Found", { status: 404 });
    const teams = (db.prepare("SELECT id, name FROM teams ORDER BY name").all() as Array<{ id: string; name: string }>)
      .filter(t => isTeamVisible(t.id));
    const escalationCount = (db.prepare("SELECT COUNT(*) as c FROM escalations WHERE status = 'open'").get() as { c: number }).c;
    const pausedRow = db.prepare("SELECT value FROM daemon_state WHERE key = 'paused'").get() as { value: string } | null;
    return html(scheduledTaskCreatePage({
      teams,
      daemonState: pausedRow?.value === "true" ? "paused" : "running",
      daemonUptime: process.uptime(),
      escalationCount,
    }));
  });

  addRoute("GET", "/tasks/new", () => {
    const teams = (db.prepare("SELECT id, name FROM teams ORDER BY name").all() as Array<{ id: string; name: string }>)
      .filter(t => isTeamVisible(t.id));
    const escalationCount = (db.prepare("SELECT COUNT(*) as c FROM escalations WHERE status = 'open'").get() as { c: number }).c;
    const pausedRow = db.prepare("SELECT value FROM daemon_state WHERE key = 'paused'").get() as { value: string } | null;
    return html(taskCreatePage({
      teams,
      daemonState: pausedRow?.value === "true" ? "paused" : "running",
      daemonUptime: process.uptime(),
      escalationCount,
    }));
  });

  // Task List
  addRoute("GET", "/tasks", () => {
    const tasks = db.prepare(
      `SELECT t.id, t.title, t.status, t.current_phase, t.task_type, t.created_at,
              tm.name AS team_name
       FROM tasks t LEFT JOIN teams tm ON tm.id = t.team_id
       ORDER BY t.created_at DESC`
    ).all() as Array<{ id: string; title: string; status: string; current_phase: number; task_type: string; created_at: string; team_name: string | null }>;
    const escalationCount = (db.prepare("SELECT COUNT(*) as c FROM escalations WHERE status = 'open'").get() as { c: number }).c;
    const pausedRow = db.prepare("SELECT value FROM daemon_state WHERE key = 'paused'").get() as { value: string } | null;
    return html(taskListPage({ tasks, escalationCount, daemonState: pausedRow?.value === "true" ? "paused" : "running", daemonUptime: process.uptime() }));
  });

  // Task Execution
  addRoute("GET", "/tasks/:id", (_req, params) => {
    return new Response(null, { status: 302, headers: { Location: `/?task=${params.id}` } });
  });

  // Agent Terminal
  addRoute("GET", "/tasks/:taskId/terminal/:instanceId", (_req, params) => {
    const inst = db.prepare(
      `SELECT ai.id, ai.template_agent_id, COALESCE(a.name, ai.template_agent_id) AS agent_name,
              ai.status, ai.process_pid, ai.task_id
       FROM agent_instances ai LEFT JOIN agents a ON a.id = ai.template_agent_id
       WHERE ai.id = ?`
    ).get(params.instanceId) as { id: string; template_agent_id: string; agent_name: string; status: string; process_pid: number | null; task_id: string } | null;

    if (!inst) return Response.json({ error: "Instance not found" }, { status: 404 });

    const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(inst.task_id) as { title: string } | null;
    const lineCount = (db.prepare("SELECT COUNT(*) as c FROM terminal_outputs WHERE agent_id = ?").get(inst.id) as { c: number }).c;
    const escalationCount = (db.prepare("SELECT COUNT(*) as c FROM escalations WHERE status = 'open'").get() as { c: number }).c;
    const pausedRow = db.prepare("SELECT value FROM daemon_state WHERE key = 'paused'").get() as { value: string } | null;

    return html(agentTerminalPage({
      instanceId: inst.id,
      agentName: inst.agent_name,
      status: inst.status,
      pid: inst.process_pid,
      taskId: inst.task_id,
      taskTitle: task?.title ?? "Unknown Task",
      lineCount,
      escalationCount,
      daemonState: pausedRow?.value === "true" ? "paused" : "running",
      daemonUptime: process.uptime(),
    }));
  });

  // Configuration Overview
  addRoute("GET", "/config", () => {
    const agents = db.prepare(
      `SELECT id, name, type, model, status FROM agents ORDER BY created_at`
    ).all() as Array<{ id: string; name: string; type: string; model: string; status: string }>;
    const teams = db.prepare(
      `SELECT t.id, t.name, t.phases, a.name AS entrypoint_agent_name
       FROM teams t LEFT JOIN agents a ON a.id = t.entrypoint_agent_id
       ORDER BY t.created_at`
    ).all() as Array<{ id: string; name: string; phases: string; entrypoint_agent_name?: string }>;
    const parsedTeams = teams.map(t => ({
      ...t,
      phases: (() => { try { return JSON.parse(t.phases); } catch { return []; } })(),
    }));
    const escalationCount = (db.prepare("SELECT COUNT(*) as c FROM escalations WHERE status = 'open'").get() as { c: number }).c;
    const pausedRow = db.prepare("SELECT value FROM daemon_state WHERE key = 'paused'").get() as { value: string } | null;
    return html(configPage({
      agents: agents.filter(a => isAgentVisible(a.id)),
      teams: parsedTeams.filter(t => isTeamVisible(t.id)),
      notificationPreferences: listPreferences(db),
      logRetentionHours: getNumberSetting(db, SETTING_LOG_RETENTION_HOURS, 24),
      daemonState: pausedRow?.value === "true" ? "paused" : "running",
      daemonUptime: process.uptime(),
      escalationCount,
    }));
  });

  // Log retention setting + purge
  addRoute("POST", "/api/config/log-retention", async (req) => {
    const contentType = req.headers.get("content-type") ?? "";
    let hours: number;
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await req.formData();
      hours = Number(formData.get("hours"));
    } else {
      const body = await req.json() as { hours?: number };
      hours = Number(body.hours);
    }
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
      return new Response("hours must be 1-720", { status: 400 });
    }
    setNumberSetting(db, SETTING_LOG_RETENTION_HOURS, hours);
    return new Response(null, { status: 204 });
  });

  addRoute("POST", "/api/config/log-purge", () => {
    const retentionHours = getNumberSetting(db, SETTING_LOG_RETENTION_HOURS, 24);
    db.prepare("DELETE FROM terminal_outputs WHERE created_at < datetime('now', ? || ' hours')").run(-retentionHours);
    db.prepare("DELETE FROM agent_sessions WHERE created_at < datetime('now', ? || ' hours')").run(-retentionHours);
    db.prepare("DELETE FROM events WHERE created_at < datetime('now', ? || ' hours')").run(-retentionHours);
    return new Response(null, { status: 204 });
  });

  // Notification preference toggle
  addRoute("PUT", "/api/notifications/preferences/:key", async (req, params) => {
    const validKeys = NOTIFICATION_EVENTS.map((e) => e.key);
    if (!validKeys.includes(params.key as NotificationEventKey)) {
      return new Response("Unknown event key", { status: 400 });
    }
    const body = await req.json() as { enabled?: boolean };
    setPreference(db, params.key as NotificationEventKey, !!body.enabled);
    return new Response(null, { status: 204 });
  });

  // Agent Detail
  addRoute("GET", "/config/agents/:id", () => {
    return new Response(null, { status: 302, headers: { Location: "/config" } });
  });

  addRoute("GET", "/config/teams/:id", () => {
    return new Response(null, { status: 302, headers: { Location: "/config" } });
  });

  // ── Inline config edit fragments ─────────────────────────────────────────
  const { configAgentEditFragment } = require("../html/fragments/config-agent-edit.fragment");
  const { configTeamEditFragment } = require("../html/fragments/config-team-edit.fragment");
  const { configAgentRowFragment, configTeamRowFragment } = require("../html/pages/config.page");
  const configStore = require("../config/store");

  addRoute("GET", "/fragments/config/agents/:id/edit", (_req, params) => {
    const agent = configStore.getAgent(params.id);
    if (!agent) return new Response("Agent not found", { status: 404 });
    const agentTypes = configStore.listAgentTypes();
    return html(configAgentEditFragment(agent, agentTypes));
  });

  addRoute("GET", "/fragments/config/teams/:id/edit", (_req, params) => {
    const team = configStore.getTeam(params.id);
    if (!team) return new Response("Team not found", { status: 404 });
    const allAgents = configStore.listAgents();
    return html(configTeamEditFragment(team, allAgents));
  });

  addRoute("POST", "/api/config/agents/:id", async (req, params) => {
    const agent = configStore.getAgent(params.id);
    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });

    const formData = await req.formData();
    const updated = {
      ...agent,
      name: formData.get("name")?.toString() ?? agent.name,
      type: formData.get("type")?.toString() ?? agent.type,
      model: formData.get("model")?.toString() ?? agent.model,
      instruction: formData.get("instruction")?.toString() || undefined,
      capabilities: (formData.get("capabilities")?.toString() ?? "")
        .split(",").map((s: string) => s.trim()).filter(Boolean),
    };
    configStore.setAgent(updated);

    const config = JSON.stringify({
      instruction: updated.instruction ?? null,
      model: updated.model,
      environment: agent.environment ?? {},
      constraints: agent.constraints ?? {},
    });
    db.prepare(
      `UPDATE agents SET name = ?, type = ?, model = ?, config = ?, capabilities = ? WHERE id = ?`
    ).run(updated.name, updated.type, updated.model, config,
      JSON.stringify(updated.capabilities), params.id);

    const row = db.prepare("SELECT id, name, type, model, status FROM agents WHERE id = ?")
      .get(params.id) as { id: string; name: string; type: string; model: string; status: string };
    return html(configAgentRowFragment(row));
  });

  addRoute("POST", "/api/config/teams/:id", async (req, params) => {
    const team = configStore.getTeam(params.id);
    if (!team) return Response.json({ error: "Team not found" }, { status: 404 });

    const formData = await req.formData();
    const name = formData.get("name")?.toString() ?? team.name;
    const goal = formData.get("goal")?.toString() || null;
    const entrypointAgentId = formData.get("entrypoint_agent_id")?.toString() || null;

    const phasesJson = formData.get("phases")?.toString();
    let phases = team.phases;
    if (phasesJson) {
      try { phases = JSON.parse(phasesJson); } catch { /* keep existing */ }
    }

    const membersJson = formData.get("members")?.toString();
    let members = team.members;
    if (membersJson) {
      try { members = JSON.parse(membersJson); } catch { /* keep existing */ }
    }

    const updated = { ...team, name, goal, entrypoint_agent_id: entrypointAgentId, phases, members };
    configStore.setTeam(updated);

    db.prepare(
      `UPDATE teams SET name = ?, goal = ?, entrypoint_agent_id = ?, phases = ? WHERE id = ?`
    ).run(name, goal, entrypointAgentId, JSON.stringify(phases), params.id);

    db.prepare("DELETE FROM team_agents WHERE team_id = ?").run(params.id);
    const insertMember = db.prepare(
      "INSERT INTO team_agents (id, team_id, agent_id, role, level, parent_agent_id) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const m of members) {
      const memberId = crypto.randomUUID();
      insertMember.run(memberId, params.id, m.agent_id, m.role ?? null, m.level ?? 0, m.parent_agent_id ?? null);
    }

    const teamRow = db.prepare(
      `SELECT t.id, t.name, t.phases, a.name AS entrypoint_agent_name
       FROM teams t LEFT JOIN agents a ON a.id = t.entrypoint_agent_id
       WHERE t.id = ?`
    ).get(params.id) as { id: string; name: string; phases: string; entrypoint_agent_name?: string };
    const parsedPhases = (() => { try { return JSON.parse(teamRow.phases); } catch { return []; } })();
    return html(configTeamRowFragment({ ...teamRow, phases: parsedPhases }));
  });

  addRoute("POST", "/api/config/export/agents", () => {
    configStore.persistAgents();
    return new Response("OK", { status: 200 });
  });

  addRoute("POST", "/api/config/export/teams", () => {
    configStore.persistTeams();
    return new Response("OK", { status: 200 });
  });

  // ── Template routes ──────────────────────────────────────────────────────
  const { templateListPage } = require("../html/pages/template-list.page");
  const { templateFormPage, phaseInputsFragment } = require("../html/pages/template-form.page");

  // Map a raw task_template_phases DB row into the shape phaseInputsFragment expects.
  // DB stores override_prompt as INTEGER (0/1) and review_override/consensus_override as JSON TEXT.
  const parseTemplatePhaseRow = (r: { phase_name: string; prompt: string; override_prompt: number; review_override: string | null; consensus_override: string | null }) => {
    let review_override: boolean | null = null;
    if (r.review_override != null) { try { review_override = JSON.parse(r.review_override); } catch { /* ignore */ } }
    let consensus_override: unknown = null;
    if (r.consensus_override != null) { try { consensus_override = JSON.parse(r.consensus_override); } catch { /* ignore */ } }
    return {
      phase_name: r.phase_name,
      prompt: r.prompt,
      override_prompt: r.override_prompt === 1,
      review_override,
      consensus_override,
    };
  };

  addRoute("GET", "/templates", () => {
    const templates = db.prepare(
      `SELECT tt.id, tt.template_name, tt.team_id, tt.created_at, tm.name AS team_name
       FROM task_templates tt
       LEFT JOIN teams tm ON tm.id = tt.team_id
       WHERE tt.deleted_at IS NULL
       ORDER BY tt.template_name`
    ).all() as Array<{ id: string; template_name: string; team_id: string; created_at: string; team_name: string | null }>;
    const escalationCount = (db.prepare("SELECT COUNT(*) as c FROM escalations WHERE status = 'open'").get() as { c: number }).c;
    const pausedRow = db.prepare("SELECT value FROM daemon_state WHERE key = 'paused'").get() as { value: string } | null;
    return html(templateListPage({
      templates,
      escalationCount,
      daemonState: pausedRow?.value === "true" ? "paused" : "running",
      daemonUptime: process.uptime(),
    }));
  });

  addRoute("GET", "/templates/new", () => {
    const teams = (db.prepare("SELECT id, name FROM teams ORDER BY name").all() as Array<{ id: string; name: string }>)
      .filter(t => isTeamVisible(t.id));
    const escalationCount = (db.prepare("SELECT COUNT(*) as c FROM escalations WHERE status = 'open'").get() as { c: number }).c;
    const pausedRow = db.prepare("SELECT value FROM daemon_state WHERE key = 'paused'").get() as { value: string } | null;
    return html(templateFormPage({
      teams,
      template: null,
      teamPhases: [],
      existingPhases: [],
      recentHookFires: [],
      escalationCount,
      daemonState: pausedRow?.value === "true" ? "paused" : "running",
      daemonUptime: process.uptime(),
    }));
  });

  addRoute("GET", "/templates/:id/edit", (_req, params) => {
    const rawTemplate = db.prepare(
      "SELECT * FROM task_templates WHERE id = ? AND deleted_at IS NULL"
    ).get(params.id) as { id: string; template_name: string; team_id: string; skipper_prompt: string; hooks?: string } | null;
    if (!rawTemplate) return new Response("Template not found", { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });

    let hooks: any[] = [];
    try { hooks = JSON.parse((rawTemplate as any).hooks ?? "[]"); } catch { /* ignore */ }
    const template = { ...rawTemplate, hooks };

    const existingPhases = (db.prepare(
      "SELECT phase_name, prompt, override_prompt, review_override, consensus_override FROM task_template_phases WHERE task_template_id = ? ORDER BY phase_name"
    ).all(params.id) as Array<{ phase_name: string; prompt: string; override_prompt: number; review_override: string | null; consensus_override: string | null }>)
      .map(parseTemplatePhaseRow);

    const teamRow = db.prepare("SELECT phases FROM teams WHERE id = ?").get(template.team_id) as { phases: string } | null;
    let teamPhases: Array<{ name: string }> = [];
    try { teamPhases = JSON.parse(teamRow?.phases ?? "[]"); } catch { /* ignore */ }

    const teams = (db.prepare("SELECT id, name FROM teams ORDER BY name").all() as Array<{ id: string; name: string }>)
      .filter(t => isTeamVisible(t.id));
    const escalationCount = (db.prepare("SELECT COUNT(*) as c FROM escalations WHERE status = 'open'").get() as { c: number }).c;
    const pausedRow = db.prepare("SELECT value FROM daemon_state WHERE key = 'paused'").get() as { value: string } | null;

    return html(templateFormPage({
      teams,
      template,
      teamPhases,
      existingPhases,
      recentHookFires: [],
      escalationCount,
      daemonState: pausedRow?.value === "true" ? "paused" : "running",
      daemonUptime: process.uptime(),
    }));
  });

  // Fragment: phase inputs for a given team (used by template form HTMX)
  addRoute("GET", "/fragments/templates/phases-form", (req) => {
    const url = new URL(req.url, "http://localhost");
    const teamId = url.searchParams.get("teamId") ?? url.searchParams.get("team_id") ?? "";
    const templateId = url.searchParams.get("templateId") ?? "";

    if (!teamId) return html(`<div id="template-phases"></div>`);
    const teamRow = db.prepare("SELECT phases FROM teams WHERE id = ?").get(teamId) as { phases: string } | null;
    if (!teamRow) return html(`<div id="template-phases"></div>`);

    let teamPhases: Array<{ name: string }> = [];
    try { teamPhases = JSON.parse(teamRow.phases ?? "[]"); } catch { /* ignore */ }

    let existingPhases: ReturnType<typeof parseTemplatePhaseRow>[] = [];
    if (templateId) {
      existingPhases = (db.prepare(
        "SELECT phase_name, prompt, override_prompt, review_override, consensus_override FROM task_template_phases WHERE task_template_id = ?"
      ).all(templateId) as Array<{ phase_name: string; prompt: string; override_prompt: number; review_override: string | null; consensus_override: string | null }>)
        .map(parseTemplatePhaseRow);
    }

    return html(phaseInputsFragment(teamPhases, existingPhases));
  });

  // Fragment: template dropdown for task creation (used by task form HTMX)
  addRoute("GET", "/fragments/templates/by-team", (req) => {
    const url = new URL(req.url, "http://localhost");
    const teamId = url.searchParams.get("teamId") ?? "";
    if (!teamId) return html(`<div id="template-field-wrapper"></div>`);

    const templates = db.prepare(
      "SELECT id, template_name FROM task_templates WHERE team_id = ? AND deleted_at IS NULL ORDER BY template_name"
    ).all(teamId) as Array<{ id: string; template_name: string }>;

    if (templates.length === 0) return html(`<div id="template-field-wrapper"></div>`);

    const options = templates.map(t =>
      `<option value="${escapeHtml(t.id)}">${escapeHtml(t.template_name)}</option>`
    ).join("");

    return html(`<div id="template-field-wrapper" class="sk-form-group" style="flex:1;">
      <label class="sk-label">Template</label>
      <select name="templateId" class="sk-select">
        <option value="">None</option>
        ${options}
      </select>
    </div>`);
  });

  // Fragment: template dropdown sized to fit inside the dashboard inline task form.
  // Returns just the select wrapped in the same <span id="dashboard-inline-template-wrapper">
  // grid cell so the surrounding layout doesn't shift when swapped.
  addRoute("GET", "/fragments/templates/by-team-inline", (req) => {
    const url = new URL(req.url, "http://localhost");
    const teamId = url.searchParams.get("teamId") ?? "";
    const renderEmpty = (disabled: boolean) =>
      `<span id="dashboard-inline-template-wrapper"><select name="templateId" id="dashboard-inline-template"${disabled ? " disabled" : ""}><option value="">None</option></select></span>`;

    if (!teamId) return html(renderEmpty(true));

    const templates = db.prepare(
      "SELECT id, template_name FROM task_templates WHERE team_id = ? AND deleted_at IS NULL ORDER BY template_name"
    ).all(teamId) as Array<{ id: string; template_name: string }>;

    if (templates.length === 0) return html(renderEmpty(false));

    const options = templates.map(t =>
      `<option value="${escapeHtml(t.id)}">${escapeHtml(t.template_name)}</option>`
    ).join("");
    return html(
      `<span id="dashboard-inline-template-wrapper"><select name="templateId" id="dashboard-inline-template"><option value="">None</option>${options}</select></span>`
    );
  });

  // Fragment: task-type-aware team + template section. Owned by all task creation
  // forms via <div id="task-form-team-template-slot" hx-get="...">. Renders one of
  // two branches:
  //   - taskType=real_time  -> hidden teamId locked to the Real Time team + template
  //                             dropdown auto-populated for that team
  //   - taskType=standard   -> normal team dropdown (excluding Real Time) + the
  //                             existing template-by-team loader
  //
  // `context` controls markup style so the slot fits the host form:
  //   - "full"    -> sk-* form-group classes (task-create.page, command-center)
  //   - "inline"  -> compact ids/classes matching dashboard inline form
  //   - "compact" -> bare <label> blocks for task-form-grid (taskFormFields)
  addRoute("GET", "/fragments/task-form/team-template", (req) => {
    const url = new URL(req.url, "http://localhost");
    const taskType = url.searchParams.get("taskType") === "real_time" ? "real_time" : "standard";
    const context = (url.searchParams.get("context") ?? "full") as "full" | "inline" | "compact";
    const selectedTeamId = url.searchParams.get("selectedTeamId") ?? "";
    const selectedTemplateId = url.searchParams.get("selectedTemplateId") ?? "";

    const templatesForTeam = (teamId: string) =>
      db.prepare(
        "SELECT id, template_name FROM task_templates WHERE team_id = ? AND deleted_at IS NULL ORDER BY template_name"
      ).all(teamId) as Array<{ id: string; template_name: string }>;

    const templateOptions = (templates: Array<{ id: string; template_name: string }>, selected: string) =>
      templates.map(t =>
        `<option value="${escapeHtml(t.id)}"${t.id === selected ? " selected" : ""}>${escapeHtml(t.template_name)}</option>`
      ).join("");

    if (taskType === "real_time") {
      const rtId = getRealtimeTeamId();
      const templates = rtId ? templatesForTeam(rtId) : [];
      const opts = templateOptions(templates, selectedTemplateId);
      const rtHidden = `<input type="hidden" name="teamId" value="${escapeHtml(rtId ?? "")}">`;

      const rtSlotAttrs = (ctx: string) =>
        `id="task-form-team-template-slot" style="display:contents;" hx-get="/fragments/task-form/team-template?context=${ctx}" hx-trigger="change from:[name=taskType]" hx-include="[name=taskType]" hx-target="this" hx-swap="outerHTML"`;

      if (context === "inline") {
        return html(`<div ${rtSlotAttrs("inline")}>
          <span class="dashboard-inline-team-locked">${rtHidden}<span class="muted">Real Time (auto)</span></span>
          <span id="dashboard-inline-template-wrapper">
            <select name="templateId" id="dashboard-inline-template"${templates.length === 0 ? " disabled" : ""}>
              <option value="">None</option>${opts}
            </select>
          </span>
        </div>`);
      }
      if (context === "compact") {
        return html(`<div ${rtSlotAttrs("compact")}>
          <label><span>Team</span>${rtHidden}<small class="muted">Real Time (auto)</small></label>
          <label><span>Template</span>
            <select name="templateId"${templates.length === 0 ? " disabled" : ""}>
              <option value="">None</option>${opts}
            </select>
          </label>
        </div>`);
      }
      // full
      return html(`<div ${rtSlotAttrs("full")}>
        <div class="sk-form-group" style="flex:1;">
          <label class="sk-label">Team</label>
          ${rtHidden}
          <div class="sk-text-sm sk-muted" style="padding-top:var(--sk-space-2);">Real Time (auto-assigned)</div>
        </div>
        <div class="sk-form-group" style="flex:1;">
          <label class="sk-label">Template</label>
          <select name="templateId" class="sk-select"${templates.length === 0 ? " disabled" : ""}>
            <option value="">None</option>${opts}
          </select>
        </div>
      </div>`);
    }

    // standard branch
    const teams = listTeamsForStandardTasks();
    const teamOptions = teams.map(t =>
      `<option value="${escapeHtml(t.id)}"${t.id === selectedTeamId ? " selected" : ""}>${escapeHtml(t.name)}</option>`
    ).join("");

    const stdSlotAttrs = (ctx: string) =>
      `id="task-form-team-template-slot" style="display:contents;" hx-get="/fragments/task-form/team-template?context=${ctx}" hx-trigger="change from:[name=taskType]" hx-include="[name=taskType]" hx-target="this" hx-swap="outerHTML"`;

    if (context === "inline") {
      return html(`<div ${stdSlotAttrs("inline")}>
        <select name="teamId" id="dashboard-inline-team"
          hx-get="/fragments/templates/by-team-inline"
          hx-trigger="change"
          hx-target="#dashboard-inline-template-wrapper"
          hx-swap="outerHTML"
          hx-include="this">
          <option value=""${selectedTeamId === "" ? " selected" : ""}>Unassigned</option>${teamOptions}
        </select>
        <span id="dashboard-inline-template-wrapper">
          <select name="templateId" id="dashboard-inline-template" disabled>
            <option value="">None</option>
          </select>
        </span>
      </div>`);
    }
    if (context === "compact") {
      return html(`<div ${stdSlotAttrs("compact")}>
        <label id="team-field-wrapper"><span>Team</span>
          <select name="teamId" id="team-field"
            hx-get="/fragments/templates/by-team-compact"
            hx-trigger="change"
            hx-target="#compact-template-wrapper"
            hx-swap="outerHTML"
            hx-include="this">
            <option value=""${selectedTeamId === "" ? " selected" : ""}>Unassigned</option>${teamOptions}
          </select>
          <small class="muted" id="team-field-note"></small>
        </label>
        <label id="compact-template-wrapper"><span>Template</span>
          <select name="templateId" disabled>
            <option value="">None</option>
          </select>
        </label>
      </div>`);
    }
    // full
    return html(`<div ${stdSlotAttrs("full")}>
      <div class="sk-form-group" style="flex:1;">
        <label class="sk-label">Team</label>
        <select name="teamId" class="sk-select"
          hx-get="/fragments/templates/by-team"
          hx-trigger="change"
          hx-target="#template-field-wrapper"
          hx-swap="outerHTML"
          hx-include="this">
          <option value=""${selectedTeamId === "" ? " selected" : ""}>Unassigned</option>${teamOptions}
        </select>
      </div>
      <div id="template-field-wrapper"></div>
    </div>`);
  });

  // Fragment: template dropdown for the `compact` context (taskFormFields).
  // Mirrors /fragments/templates/by-team but emits a <label>-wrapped select
  // matching the task-form-grid layout.
  addRoute("GET", "/fragments/templates/by-team-compact", (req) => {
    const url = new URL(req.url, "http://localhost");
    const teamId = url.searchParams.get("teamId") ?? "";
    const renderEmpty = (disabled: boolean) =>
      `<label id="compact-template-wrapper"><span>Template</span><select name="templateId"${disabled ? " disabled" : ""}><option value="">None</option></select></label>`;

    if (!teamId) return html(renderEmpty(true));
    const templates = db.prepare(
      "SELECT id, template_name FROM task_templates WHERE team_id = ? AND deleted_at IS NULL ORDER BY template_name"
    ).all(teamId) as Array<{ id: string; template_name: string }>;
    if (templates.length === 0) return html(renderEmpty(false));
    const opts = templates.map(t =>
      `<option value="${escapeHtml(t.id)}">${escapeHtml(t.template_name)}</option>`
    ).join("");
    return html(`<label id="compact-template-wrapper"><span>Template</span><select name="templateId"><option value="">None</option>${opts}</select></label>`);
  });

  // Escalation Queue
  addRoute("GET", "/escalations", () => {
    const allEsc = db.prepare(
      `SELECT e.id, e.agent_id, e.task_id, t.title AS task_title, e.type, e.question, e.status, e.response, e.created_at, e.resolved_at
       FROM escalations e LEFT JOIN tasks t ON t.id = e.task_id
       ORDER BY e.created_at DESC LIMIT 50`
    ).all() as Array<{ id: string; agent_id: string; task_id: string; task_title: string | null; type: string; question: string; status: string; response: string | null; created_at: string; resolved_at: string | null }>;

    const open = allEsc.filter((e) => e.status === "open");
    const resolved = allEsc.filter((e) => e.status !== "open");
    const pausedRow = db.prepare("SELECT value FROM daemon_state WHERE key = 'paused'").get() as { value: string } | null;

    return html(escalationQueuePage({
      open,
      resolved,
      escalationCount: open.length,
      daemonState: pausedRow?.value === "true" ? "paused" : "running",
      daemonUptime: process.uptime(),
    }));
  });
}

function renderArtifactDetail(
  artifact: { id: string; name: string; version: number; kind: string; description: string | null; body: string | null; created_at: string },
  taskId: string,
  versionLinks: string,
): string {
  const bodyContent = artifact.body ? escapeHtml(artifact.body) : "(empty)";
  const rawBody = artifact.body ?? "";
  const isHtml = /^\s*<[a-zA-Z]/.test(rawBody) || /<(h[1-6]|p|div|table|ul|ol|blockquote|pre|section|article|header|footer|nav|figure|details)\b/i.test(rawBody);
  const renderedBody = isHtml
    ? rawBody.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    : `<div class="artifact-body-markdown" data-artifact-md>${escapeHtml(rawBody)}</div>`;

  return `<div class="artifact-detail">
    <div class="artifact-detail-header">
      <h3>${escapeHtml(artifact.name)} <span class="badge badge-info">v${artifact.version}</span></h3>
      <div style="display:flex;gap:0.5rem;align-items:center;">
        <button type="button" class="btn-sm" data-sk-artifact-toggle data-mode="rendered">Raw</button>
        <button type="button" class="btn-sm" data-sk-artifact-edit>Edit</button>
      </div>
    </div>
    <p class="muted">${escapeHtml(artifact.kind)} &middot; ${formatTimestamp(artifact.created_at)}${artifact.description ? ` &middot; ${escapeHtml(artifact.description)}` : ""}</p>
    <div class="artifact-versions">Versions: ${versionLinks}</div>
    <div class="artifact-body artifact-rendered">${renderedBody}</div>
    <pre class="artifact-body artifact-raw" style="display:none;"><code>${bodyContent}</code></pre>
    <div class="artifact-edit" style="display:none;">
      <textarea class="sk-textarea" rows="20" style="width:100%;font-family:monospace;font-size:0.8rem;">${escapeHtml(rawBody)}</textarea>
      <div style="margin-top:var(--sk-space-2);display:flex;gap:var(--sk-space-2);">
        <button type="button" class="sk-btn sk-btn--primary sk-btn--sm" data-sk-artifact-save
          data-task-id="${escapeHtml(taskId)}" data-artifact-name="${escapeHtml(artifact.name)}"
          data-artifact-kind="${escapeHtml(artifact.kind)}">Save as v${artifact.version + 1}</button>
        <button type="button" class="sk-btn sk-btn--sm" data-sk-artifact-edit-cancel>Cancel</button>
      </div>
    </div>
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
