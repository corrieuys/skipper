import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { escapeHtml } from "../html/atoms/escape-html";
import { looksLikeHtml } from "../html/atoms/sniff-html";
import { ArtifactManager } from "../orchestrator/artifact-manager";
import { getConnectPublicBase, getPublicArtifactUrl } from "../connect/public-links";
import { getRealtimeTeamId, listTeamsForStandardTasks } from "../config/teams";
import { isTeamVisible, isExperimental } from "../config/feature-flags";
import { listPreferences, setPreference } from "../notifications/store";
import { NOTIFICATION_EVENTS, type NotificationEventKey } from "../notifications/types";
import { readFileSync } from "fs";
import { join } from "path";
import {
  fetchTasksWithTeams,
  fetchTaskById,
  fetchTaskDelegations,
  fetchTaskForensics,
  fetchDashboardRealtimeTimeline,
  fetchDashboardPhaseIndicatorTask,
  buildTeamAgentTiles,
  getOpenEscalationCount,
} from "../data/queries";
export {
  fetchTasksWithTeams,
  fetchTaskById,
  fetchTaskDelegations,
  fetchDashboardActiveTeamAgents,
  fetchDashboardRealtimeTimeline,
  fetchDashboardPhaseIndicatorTask,
} from "../data/queries";
import {
  taskListPollingFragment,
  taskDetailSummaryFragment,
  taskPhaseStepperFragment,
  taskDelegationsFragment,
  taskForensicsFragment,
  terminalOutputFragment,
  logsTableFragment,
} from "../html/components";
import { formatTimestamp } from "../html/formatTimestamp";
import { metricsFragment } from "../html/metricsFragment";
import { escalationCardPanel, type EscalationCardData } from "../html/panels/escalation-card.panel";
import { logsPage } from "../html/pages/logs.page";
import { dashboardNotesFragment } from "../html/dashboardNotesFragment";
import { dashboardChatCardFragment } from "../html/dashboardChatCardFragment";
import { conversationListFragment } from "../html/conversationListFragment";
import { chatFullscreenView } from "../html/chatFullscreenView";
import { dashboardRealtimeTimelineFragment } from "../html/dashboardRealtimeTimelineFragment";
import { dashboardPhaseIndicatorFragment } from "../html/dashboardPhaseIndicatorFragment";
import { dashboardActiveAgentsCountFragment } from "../html/dashboardActiveAgentsCountFragment";
import { dashboardRunningInstancesFragment } from "../html/dashboardRunningInstancesFragment";
import { selectDashboardFocusTasks } from "../html/selectDashboardFocusTasks";
import { diagnosticCard } from "../html/diagnosticCard";
import { dashboardActiveTaskFragment } from "../html/dashboardActiveTaskFragment";
import { helpPage } from "../html/pages/help.page";
import { asteroidsPage } from "../html/pages/asteroids.page";
import { dashboardSteerListFragment, agentInstancesModalFragment, type SteeringOption } from "../html/dashboardLatestSteerFragment";
import {
  getNumberSetting, setNumberSetting, SETTING_LOG_RETENTION_HOURS,
  getStringSetting, setStringSetting, getSetting,
  SETTING_SKIPPER_CONNECT_KEY, SETTING_SKIPPER_CONNECT_URL,
} from "../config/app-settings";
import { recentActivityFragment } from "../html/recentActivityFragment";
import type {
  DashboardData,
  PollIntervalSeconds,
  TaskNoteData,
  AuditEventData,
  AuditEventFilters,
  LogEntryData,
  LogFilters,
  RecentLogEntry,
} from "../html/components";
import type { ManagerDaemon } from "../agents/manager-daemon";
import { htmlResponse as html, parseRequestBody } from "./utils";
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
  const artifactManager = new ArtifactManager(db);
  for (const variant of ARTIFACT_MODAL_VARIANTS) {
    addRoute("GET", `${variant.routePrefix}/:id/artifacts`, (_req, params) =>
      html(renderArtifactListFragment(db, params.id, variant)));

    addRoute("GET", `${variant.routePrefix}/:id/artifacts/:name`, (req, params) =>
      html(renderArtifactDetailFragment(db, params.id, params.name, new URL(req.url).searchParams.get("version") ?? "latest", variant)));

    for (const publishAction of ["publish", "unpublish"] as const) {
      addRoute("POST", `${variant.routePrefix}/:id/artifacts/:name/${publishAction}`, (req, params) => {
        const taskId = params.id ?? "";
        const artifactName = params.name ?? "";
        const versionParam = new URL(req.url).searchParams.get("version") ?? "latest";
        const version = versionParam === "latest" ? "latest" : Number(versionParam);
        const artifact = artifactManager.getArtifact(taskId, artifactName, version as "latest" | number);
        // Publishing is experimental-only; ignore the action when the flag is off
        // (the UI is hidden, this guards direct POSTs).
        if (artifact && isExperimental()) {
          if (publishAction === "publish") artifactManager.publishArtifact(artifact.id);
          else artifactManager.unpublishArtifact(artifact.id);
        }
        // Swap the modal detail (primary target) AND re-render the artifacts list
        // out-of-band, so its "published" badge stays in sync without a reload.
        const detail = renderArtifactDetailFragment(db, taskId, artifactName, versionParam, variant);
        const listOob = `<div id="${escapeHtml(variant.listId(taskId))}" hx-swap-oob="innerHTML">${renderArtifactListFragment(db, taskId, variant)}</div>`;
        return html(detail + listOob);
      });
    }
  }

  addRoute("GET", "/fragments/tasks/:id/forensics", (_req, params) => {
    const forensics = fetchTaskForensics(db, params.id);
    return html(taskForensicsFragment(params.id, forensics, getPollIntervalSeconds(db)));
  });


  // Legacy redirects → unified config page
  addRoute("GET", "/skipper", () => {
    return new Response(null, { status: 302, headers: { Location: "/config" } });
  });

  addRoute("GET", "/agents", () => {
    return new Response(null, { status: 302, headers: { Location: "/config" } });
  });

  // Agent detail → runtime terminal output (agent definition management removed)
  addRoute("GET", "/agents/:id", (_req, params) => {
    return new Response(null, { status: 302, headers: { Location: `/agents/${params.id}/output` } });
  });

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

  // Teams list / detail → DB-backed teams page (legacy team management removed)
  addRoute("GET", "/teams", () => {
    return new Response(null, { status: 302, headers: { Location: "/config" } });
  });

  addRoute("GET", "/teams/new", () => {
    return new Response(null, { status: 302, headers: { Location: "/config/teams/new" } });
  });

  addRoute("GET", "/teams/:id", () => {
    return new Response(null, { status: 302, headers: { Location: "/config" } });
  });


  // Escalation resolve/dismiss. Each action is registered twice: /api routes
  // redirect home (full-page forms), /fragments routes return the single
  // re-rendered card so htmx can swap #escalation-<id> in place. The navbar
  // badge + dashboard panels are refreshed over WS by ui-push.ts.
  const resolveEscalationAction = async (req: Request, id: string): Promise<string | null> => {
    const body = await parseRequestBody<Record<string, string>>(req);
    if (!body.response) return "response is required";
    try {
      await daemon.resolveEscalation(id, body.response);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Internal error";
    }
  };

  const dismissEscalationAction = (id: string): string | null => {
    try {
      daemon.getEscalationManager().dismissEscalation(id);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Internal error";
    }
  };

  const escalationRedirectResponse = (error: string | null): Response => {
    if (error) return Response.json({ error }, { status: 400 });
    daemon.getEscalationManager().reconcileOpenEscalationsForInactiveTasks();
    return new Response(null, { status: 302, headers: { Location: "/" } });
  };

  const escalationCardResponse = (error: string | null, id: string): Response => {
    if (error) return new Response(error, { status: 400 });
    const card = db.prepare(
      `SELECT e.id, e.agent_id, e.task_id, t.title AS task_title,
              e.type, e.question, e.status, e.response, e.created_at, e.resolved_at
       FROM escalations e
       LEFT JOIN tasks t ON t.id = e.task_id
       WHERE e.id = ?`,
    ).get(id) as EscalationCardData | null;
    if (!card) return new Response("", { status: 200 });
    return html(escalationCardPanel(card));
  };

  addRoute("POST", "/api/escalations/:id/resolve", async (req, params) =>
    escalationRedirectResponse(await resolveEscalationAction(req, params.id)));

  addRoute("POST", "/api/escalations/:id/dismiss", (_req, params) =>
    escalationRedirectResponse(dismissEscalationAction(params.id)));

  addRoute("POST", "/fragments/escalations/:id/resolve", async (req, params) =>
    escalationCardResponse(await resolveEscalationAction(req, params.id), params.id));

  addRoute("POST", "/fragments/escalations/:id/dismiss", (_req, params) =>
    escalationCardResponse(dismissEscalationAction(params.id), params.id));

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
    const escalationCount = getOpenEscalationCount(db);

    return html(logsPage({
      entries,
      filters,
      agents,
      daemonState: status.state,
      daemonUptime: status.uptime,
      escalationCount,
    }));
  });

  addRoute("GET", "/help", () => {
    const status = daemon.getStatus();
    const escalationCount = getOpenEscalationCount(db);
    return html(helpPage({ daemonState: status.state, daemonUptime: status.uptime, escalationCount }));
  });

  addRoute("GET", "/games/asteroids", () => {
    const status = daemon.getStatus();
    const escalationCount = getOpenEscalationCount(db);
    return html(asteroidsPage({ daemonState: status.state, daemonUptime: status.uptime, escalationCount }));
  });

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

  // Team roster fragment — the dashboard "Active Agent" panel. Task context
  // shows the whole team (like zen mode); the aggregate dashboard shows the
  // running agent types across all tasks.
  addRoute("GET", "/fragments/dashboard/latest-steer", (req) => {
    const url = new URL(req.url);
    const taskId = url.searchParams.get("task");

    if (taskId) {
      return html(dashboardSteerListFragment(buildTeamAgentTiles(db, taskId), taskId));
    }

    const rows = db.prepare(
      `SELECT ai.template_agent_id,
              COALESCE(a.name, ai.template_agent_id) AS agent_name,
              COUNT(*) AS instance_count
       FROM agent_instances ai
       LEFT JOIN agents a ON a.id = ai.template_agent_id
       WHERE ai.status IN ('running', 'waiting_delegation')
       GROUP BY ai.template_agent_id
       ORDER BY MAX(ai.updated_at) DESC`,
    ).all() as Array<{ template_agent_id: string; agent_name: string; instance_count: number }>;

    const tiles = rows.map((r) => ({
      template_agent_id: r.template_agent_id,
      agent_name: r.agent_name,
      instance_count: r.instance_count,
      is_active: true,
    }));

    return html(dashboardSteerListFragment(tiles));
  });

  // Agent instance list for the agent modal — all running instances of one
  // agent type (optionally scoped to a task), each with output + steer input.
  addRoute("GET", "/fragments/dashboard/agent-instances", (req) => {
    const url = new URL(req.url);
    const templateAgentId = url.searchParams.get("template_agent_id");
    const taskId = url.searchParams.get("task");
    if (!templateAgentId) return html(agentInstancesModalFragment([]));

    const conds = ["ai.status IN ('running', 'waiting_delegation')", "ai.template_agent_id = ?"];
    const queryArgs: string[] = [templateAgentId];
    if (taskId) {
      conds.push("ai.task_id = ?");
      queryArgs.push(taskId);
    }

    const instances = db.prepare(
      `SELECT ai.id AS runtime_id, ai.template_agent_id,
              COALESCE(a.name, ai.template_agent_id) AS agent_name,
              ai.task_id, t.title AS task_title, ai.status, ai.process_pid,
              ai.session_id
       FROM agent_instances ai
       LEFT JOIN agents a ON a.id = ai.template_agent_id
       LEFT JOIN tasks t ON t.id = ai.task_id
       WHERE ${conds.join(" AND ")}
       ORDER BY ai.updated_at DESC`,
    ).all(...queryArgs) as Array<{
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

    return html(agentInstancesModalFragment(options));
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
  const { agentTerminalPage } = require("../html/pages/agent-terminal.page");
  const { configPage } = require("../html/pages/config.page");
  const { taskCreatePage } = require("../html/pages/task-create.page");

  const fetchScheduledOverride = (scheduledId: string) => {
    const st = db.prepare(
      `SELECT st.*, tm.name AS team_name FROM scheduled_tasks st LEFT JOIN teams tm ON tm.id = st.team_id WHERE st.id = ?`
    ).get(scheduledId) as any;
    if (!st) return null;
    // Recurring tasks are always standard — exclude the Real Time team.
    const teams = listTeamsForStandardTasks();
    const runs = db.prepare(
      `SELECT id, title, status, started_at, completed_at, result, created_at FROM tasks WHERE source_scheduled_task_id = ? ORDER BY created_at DESC LIMIT 20`
    ).all(scheduledId) as Array<{ id: string; title: string; status: string; started_at: string | null; completed_at: string | null; result: string | null; created_at: string }>;
    return { scheduledTask: st, teams, runs };
  };

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
    const vm = buildCommandCenterViewModel(db, { includeTaskId: params.id });
    const task = vm.allTasks.find((t: any) => t.id === params.id);
    if (!task) return Response.json({ error: "Not found" }, { status: 404 });
    const { taskMainContent, renderDraftEdit, realtimeTaskContent } = require("../html/pages/command-center.page");
    if (task.status === "draft") return html(renderDraftEdit(task, vm.teams));
    if ((task as any).task_type === "real_time") {
      const isSessionActive = vm.realtimeSessionActive?.get(task.id);
      return html(realtimeTaskContent(vm, task, isSessionActive));
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
       ORDER BY t.id DESC LIMIT 800`
    ).all(params.id) as Array<{ stream: string; data: string; agent_name: string; created_at: string }>;
    // Wide pull (800 raw rows): parseTerminalActivity keeps a per-kind budget,
    // so the window must be deep enough to hold ~40 messages even when tool
    // rows dominate the stream. A narrow window would starve the Messages filter.

    if (rows.length === 0) {
      return html(`<div class="mc-activity__empty">No activity yet</div>`);
    }

    // Keep newest-first order — feed reads top-down with most recent at the top.
    const { parseTerminalActivity } = require("../html/pages/command-center.page");
    return html(parseTerminalActivity(rows));
  });

  // Unified realtime activity feed: timeline entries + agent terminal outputs merged
  addRoute("GET", "/workspace/task/:id/realtime-activity", (_req, params) => {
    const { parseRealtimeActivity } = require("../html/pages/command-center.page");
    type Row = import("../html/pages/command-center.page").RealtimeActivityRow;

    const timelineRows = db.prepare(
      `SELECT entry_type, content, priority, created_at
       FROM realtime_timeline WHERE task_id = ?
       ORDER BY created_at DESC LIMIT 250`
    ).all(params.id) as Array<{ entry_type: string; content: string; priority: string; created_at: string }>;

    const terminalRows = db.prepare(
      `SELECT t.stream, t.data, COALESCE(a.name, ai.template_agent_id) AS agent_name, t.created_at
       FROM terminal_outputs t
       JOIN agent_instances ai ON ai.id = t.agent_id
       LEFT JOIN agents a ON a.id = ai.template_agent_id
       WHERE ai.task_id = ?
       ORDER BY t.id DESC LIMIT 200`
    ).all(params.id) as Array<{ stream: string; data: string; agent_name: string; created_at: string }>;

    const merged: Row[] = [
      ...timelineRows.map(r => ({ source: "timeline" as const, entry_type: r.entry_type, content: r.content, priority: r.priority, created_at: r.created_at })),
      ...terminalRows.map(r => ({ source: "terminal" as const, stream: r.stream, data: r.data, agent_name: r.agent_name, created_at: r.created_at })),
    ];
    merged.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    const limited = merged.slice(0, 300);

    return html(parseRealtimeActivity(limited));
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
    const instanceRows = instances.map(i => `<tr><td class="sk-mono sk-text-xs">${esc(i.id.slice(0, 8))}</td><td>${esc(i.agent_name)}</td><td><span class="sk-badge sk-badge--${i.status}">${i.status}</span></td><td class="sk-muted sk-text-xs">${formatTimestamp(i.created_at)}</td></tr>`).join("");
    const delegationRows = delegations.map(d => `<tr><td>${esc(d.parent_name)} → ${esc(d.child_name)}</td><td><span class="sk-badge sk-badge--${d.status}">${d.status}</span></td><td class="sk-text-xs sk-muted" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc((d.prompt ?? "").slice(0, 100))}</td></tr>`).join("");

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

  // Task Creation — must be before /tasks/:id to avoid matching "new" as an ID.
  // Recurring task creation is now merged into /tasks/new (Task Type = Recurring);
  // keep the old path as a redirect for any lingering links/bookmarks.
  addRoute("GET", "/tasks/scheduled/new", () => {
    return new Response(null, { status: 302, headers: { Location: "/tasks/new" } });
  });

  addRoute("GET", "/tasks/new", () => {
    const teams = (db.prepare("SELECT id, name FROM teams ORDER BY name").all() as Array<{ id: string; name: string }>)
      .filter(t => isTeamVisible(t.id));
    const escalationCount = getOpenEscalationCount(db);
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
    const escalationCount = getOpenEscalationCount(db);
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
    const escalationCount = getOpenEscalationCount(db);
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
    const { listLocalTeams } = require("../teams/local-teams");
    const escalationCount = getOpenEscalationCount(db);
    const pausedRow = db.prepare("SELECT value FROM daemon_state WHERE key = 'paused'").get() as { value: string } | null;
    const { getModelSettingsView } = require("../config/model-settings");
    return html(configPage({
      teams: listLocalTeams(db),
      notificationPreferences: listPreferences(db),
      logRetentionHours: getNumberSetting(db, SETTING_LOG_RETENTION_HOURS, 24),
      daemonState: pausedRow?.value === "true" ? "paused" : "running",
      daemonUptime: process.uptime(),
      escalationCount,
      skipperConnectHasKey: !!getSetting(db, SETTING_SKIPPER_CONNECT_KEY),
      skipperConnectUrl: getStringSetting(db, SETTING_SKIPPER_CONNECT_URL, ""),
      modelSettings: getModelSettingsView(db),
    }));
  });

  // Persist a subsystem's provider + model (machine-scoped app_settings).
  addRoute("POST", "/api/config/model-settings", async (req) => {
    const { saveModelSetting } = require("../config/model-settings");
    const contentType = req.headers.get("content-type") ?? "";
    let target = "", agentType = "", model = "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const fd = await req.formData();
      target = String(fd.get("target") ?? "");
      agentType = String(fd.get("agent_type") ?? "");
      model = String(fd.get("model") ?? "");
    } else {
      const body = await req.json() as { target?: string; agent_type?: string; model?: string };
      target = body.target ?? ""; agentType = body.agent_type ?? ""; model = body.model ?? "";
    }
    if (target !== "skipper" && target !== "chat" && target !== "greg") {
      return new Response("target must be skipper|chat|greg", { status: 400 });
    }
    const err = saveModelSetting(db, target, agentType, model);
    if (err) return new Response(err, { status: 400 });
    return new Response(null, { status: 204 });
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

  addRoute("POST", "/api/config/skipper-connect", async (req) => {
    const formData = await req.formData();
    const url = (formData.get("url") ?? "").toString().trim();
    const key = (formData.get("key") ?? "").toString().trim();

    if (url) setStringSetting(db, SETTING_SKIPPER_CONNECT_URL, url);
    if (key) setStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, key);

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

  // Old agent detail path → Config page.
  addRoute("GET", "/config/agents/:id", () => {
    return new Response(null, { status: 302, headers: { Location: "/config" } });
  });

  // ── Global store routes (experimental) ───────────────────────────────────
  if (isExperimental()) {
    const { globalStorePage } = require("../html/pages/global-store.page");
    const { globalStoreEditFragment, globalStoreRowFragment } = require("../html/fragments/global-store-edit.fragment");
    const { GlobalStoreManager } = require("../global-store/manager");
    const globalStore = new GlobalStoreManager(db);

    addRoute("GET", "/global-store", () => {
      const escalationCount = getOpenEscalationCount(db);
      const pausedRow = db.prepare("SELECT value FROM daemon_state WHERE key = 'paused'").get() as { value: string } | null;
      return html(globalStorePage({
        rows: globalStore.query({}),
        daemonState: pausedRow?.value === "true" ? "paused" : "running",
        daemonUptime: process.uptime(),
        escalationCount,
      }));
    });

    addRoute("GET", "/fragments/global-store/new", () => {
      return html(globalStoreEditFragment());
    });

    addRoute("GET", "/fragments/global-store/edit", (req) => {
      const name = new URL(req.url).searchParams.get("name");
      if (!name) return new Response("Missing name", { status: 400 });
      const row = globalStore.get(name);
      if (!row) return new Response("Value not found", { status: 404 });
      return html(globalStoreEditFragment(row));
    });

    addRoute("POST", "/api/global-store", async (req) => {
      const formData = await req.formData();
      const name = formData.get("name")?.toString().trim();
      if (!name) return new Response("Missing name", { status: 400 });
      const row = globalStore.set({
        name,
        type: formData.get("type")?.toString() || null,
        data: formData.get("data")?.toString() ?? null,
        status: formData.get("status")?.toString() || null,
      });
      return html(globalStoreRowFragment(row));
    });

    addRoute("DELETE", "/api/global-store", (req) => {
      const name = new URL(req.url).searchParams.get("name");
      if (!name) return new Response("Missing name", { status: 400 });
      globalStore.delete(name);
      return new Response("", { status: 200 });
    });
  }

  // ── Team config forms (managed on the Config page) ──────────────────────
  {
    const { localTeamFormPage } = require("../html/pages/local-team-form.page");
    const { getLocalTeam } = require("../teams/local-teams");
    const { listAgentTypes } = require("../config/store");

    const daemonMeta = () => {
      const escalationCount = getOpenEscalationCount(db);
      const pausedRow = db.prepare("SELECT value FROM daemon_state WHERE key = 'paused'").get() as { value: string } | null;
      return {
        escalationCount,
        daemonState: pausedRow?.value === "true" ? "paused" : "running",
        daemonUptime: process.uptime(),
      };
    };

    const { isAllowedProvider } = require("../config/model-settings");
    const agentTypeChoices = () =>
      (listAgentTypes() as Array<{ name: string; available_models: string[] }>)
        .filter((t) => isAllowedProvider(t.name))
        .map((t) => ({
          name: t.name,
          models: Array.isArray(t.available_models) ? t.available_models : [],
        }));

    // Redirect the old list path to the Config page where teams now live.
    addRoute("GET", "/local-teams", () => {
      return new Response(null, { status: 302, headers: { Location: "/config" } });
    });

    addRoute("GET", "/config/teams/new", () => {
      return html(localTeamFormPage({ team: null, agentTypes: agentTypeChoices(), ...daemonMeta() }));
    });

    addRoute("GET", "/config/teams/:id/edit", (_req, params) => {
      const team = getLocalTeam(db, params.id!);
      if (!team) return new Response("Team not found", { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
      return html(localTeamFormPage({ team, agentTypes: agentTypeChoices(), ...daemonMeta() }));
    });
  }

  // ── Task-form fragments ──────────────────────────────────────────────────

  // Fragment: per-task phase overrides for a selected team (used by the task form
  // #phase-config-slot). Renders review-gate + (experimental) consensus override
  // controls per phase; submitted fields are parsed in src/routes/tasks.ts into
  // task_config.phase_overrides.
  const { taskPhaseConfigFragment } = require("../html/pages/task-create.page");
  addRoute("GET", "/fragments/task-form/phase-config", (req) => {
    const url = new URL(req.url, "http://localhost");
    // The command-center slot bakes teamId into the URL (for taskId) AND sends the
    // live select value via hx-include on change — prefer the last non-empty value.
    const teamIds = url.searchParams.getAll("teamId");
    const teamId = [...teamIds].reverse().find((v) => v !== "") ?? "";
    const taskId = url.searchParams.get("taskId") ?? "";

    if (!teamId) return html(`<div></div>`);
    const teamRow = db.prepare("SELECT phases FROM teams WHERE id = ?").get(teamId) as { phases: string } | null;
    if (!teamRow) return html(`<div></div>`);

    let teamPhases: Array<{ name: string; prompt?: string; review?: boolean; consensus?: unknown }> = [];
    try { teamPhases = JSON.parse(teamRow.phases ?? "[]"); } catch { /* ignore */ }

    let existingOverrides: Record<string, { prompt?: string; review?: boolean; consensus?: unknown }> = {};
    if (taskId) {
      const taskRow = db.prepare("SELECT task_config FROM tasks WHERE id = ?").get(taskId) as { task_config: string } | null;
      if (taskRow?.task_config) {
        try {
          const cfg = JSON.parse(taskRow.task_config) as Record<string, unknown>;
          const po = cfg.phase_overrides;
          if (po && typeof po === "object") existingOverrides = po as Record<string, { prompt?: string; review?: boolean; consensus?: unknown }>;
        } catch { /* ignore */ }
      }
    }

    return html(taskPhaseConfigFragment(teamPhases, existingOverrides));
  });

  // Fragment: task-type-aware team selector. Owned by all task creation forms via
  // <div id="task-form-team-slot" hx-get="...">. Realtime locks to the Real Time
  // team; standard shows a team dropdown. `context` controls markup style so the
  // slot fits the host form:
  //   - "full"    -> sk-* form-group classes (task-create.page, command-center)
  //   - "inline"  -> compact ids/classes matching dashboard inline form
  //   - "compact" -> bare <label> blocks for task-form-grid (taskFormFields)
  addRoute("GET", "/fragments/task-form/team", (req) => {
    const url = new URL(req.url, "http://localhost");
    const taskType = url.searchParams.get("taskType") === "real_time" ? "real_time" : "standard";
    const context = (url.searchParams.get("context") ?? "full") as "full" | "inline" | "compact";
    const selectedTeamId = url.searchParams.get("selectedTeamId") ?? "";

    const slotAttrs = (ctx: string) =>
      `id="task-form-team-slot" style="display:contents;" hx-get="/fragments/task-form/team?context=${ctx}" hx-trigger="change from:[name=taskType]" hx-include="[name=taskType]" hx-target="this" hx-swap="outerHTML"`;

    if (taskType === "real_time") {
      const rtId = getRealtimeTeamId();
      const rtHidden = `<input type="hidden" name="teamId" value="${escapeHtml(rtId ?? "")}">`;

      if (context === "inline") {
        return html(`<div ${slotAttrs("inline")}>
          <span class="dashboard-inline-team-locked">${rtHidden}<span class="muted">Real Time (auto)</span></span>
        </div>`);
      }
      if (context === "compact") {
        return html(`<div ${slotAttrs("compact")}>
          <label><span>Team</span>${rtHidden}<small class="muted">Real Time (auto)</small></label>
        </div>`);
      }
      return html(`<div ${slotAttrs("full")}>
        <div class="sk-form-group" style="flex:1;">
          <label class="sk-label">Team</label>
          ${rtHidden}
          <div class="sk-text-sm sk-muted" style="padding-top:var(--sk-space-2);">Real Time (auto-assigned)</div>
        </div>
      </div>`);
    }

    // standard branch
    const teams = listTeamsForStandardTasks();
    const teamOptions = teams.map(t =>
      `<option value="${escapeHtml(t.id)}"${t.id === selectedTeamId ? " selected" : ""}>${escapeHtml(t.name)}</option>`
    ).join("");

    if (context === "inline") {
      return html(`<div ${slotAttrs("inline")}>
        <select name="teamId" id="dashboard-inline-team">
          <option value=""${selectedTeamId === "" ? " selected" : ""}>Unassigned</option>${teamOptions}
        </select>
      </div>`);
    }
    if (context === "compact") {
      return html(`<div ${slotAttrs("compact")}>
        <label id="team-field-wrapper"><span>Team</span>
          <select name="teamId" id="team-field">
            <option value=""${selectedTeamId === "" ? " selected" : ""}>Unassigned</option>${teamOptions}
          </select>
        </label>
      </div>`);
    }
    // full
    return html(`<div ${slotAttrs("full")}>
      <div class="sk-form-group" style="flex:1;">
        <label class="sk-label">Team</label>
        <select name="teamId" class="sk-select">
          <option value=""${selectedTeamId === "" ? " selected" : ""}>Unassigned</option>${teamOptions}
        </select>
      </div>
    </div>`);
  });

}

// The task page and dashboard render the same artifact modal; only the route
// prefix, the JS opener, and the swap target differ.
interface ArtifactModalVariant {
  routePrefix: string;
  openFn: string;
  target: string;
  /** DOM id of the artifacts list container for this surface, so publish /
   *  unpublish can re-render it out-of-band (the badge lives in the list). */
  listId: (taskId: string) => string;
}

const ARTIFACT_MODAL_VARIANTS: ArtifactModalVariant[] = [
  { routePrefix: "/fragments/tasks", openFn: "openTaskArtifactModal", target: "#task-artifact-modal-body", listId: (id) => `mc-artifacts-${id}` },
  { routePrefix: "/fragments/dashboard/tasks", openFn: "openDashboardArtifactModal", target: "#dashboard-artifact-modal-body", listId: () => "dashboard-artifact-list" },
];

interface ArtifactRow {
  id: string;
  name: string;
  version: number;
  kind: string;
  description: string | null;
  created_at: string;
}

interface ArtifactListRow extends ArtifactRow {
  has_published: number;
}

function artifactModalLink(variant: ArtifactModalVariant, taskId: string, name: string, version?: number): string {
  const versionQuery = version === undefined ? "" : `?version=${version}`;
  return `onclick="${variant.openFn}(); return false;" hx-get="${variant.routePrefix}/${escapeHtml(taskId)}/artifacts/${encodeURIComponent(name)}${versionQuery}" hx-target="${variant.target}" hx-swap="innerHTML"`;
}

function renderArtifactListFragment(db: ReturnType<typeof getDb>, taskId: string, variant: ArtifactModalVariant): string {
  const rows = db.prepare(
    `SELECT a.id, a.name, a.version, a.kind, a.description, a.created_at,
       EXISTS(
         SELECT 1 FROM task_artifacts p
         WHERE p.task_id = a.task_id AND p.name = a.name AND p.published_at IS NOT NULL
       ) AS has_published
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
  ).all(taskId, taskId) as ArtifactListRow[];

  if (rows.length === 0) {
    return `<p class="muted">No artifacts yet.</p>`;
  }

  const showPublished = isExperimental();
  const tableRows = rows.map((r) =>
    `<tr>
      <td><a href="#" ${artifactModalLink(variant, taskId, r.name)}>${escapeHtml(r.name)}</a>${showPublished && r.has_published ? ` <span class="badge badge-published" title="Has a published version">published</span>` : ""}</td>
      <td>${escapeHtml(r.kind)}</td>
      <td>v${r.version}</td>
      <td>${formatTimestamp(r.created_at)}</td>
    </tr>`,
  ).join("");

  return `<table class="data-table">
    <thead><tr><th>Name</th><th>Kind</th><th>Version</th><th>Updated</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;
}

function renderArtifactDetailFragment(
  db: ReturnType<typeof getDb>,
  taskId: string,
  artifactName: string,
  versionParam: string,
  variant: ArtifactModalVariant,
): string {
  let artifact: (ArtifactRow & { body: string | null; publish_key: string | null; published_at: string | null }) | null;
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
    return `<p class="muted">Artifact not found.</p>`;
  }

  const versions = db.prepare(
    `SELECT version, created_at, published_at FROM task_artifacts WHERE task_id = ? AND name = ? ORDER BY version DESC`,
  ).all(taskId, artifactName) as { version: number; created_at: string; published_at: string | null }[];

  const versionsShowPublished = isExperimental();
  const versionLinks = versions.map((v) => {
    const publishedMark = versionsShowPublished && v.published_at ? `<span title="Published">&#128279;</span>` : "";
    if (v.version === artifact!.version) {
      return `<span class="badge badge-info">v${v.version}${publishedMark}</span>`;
    }
    return `<a href="#" ${artifactModalLink(variant, taskId, artifactName, v.version)} class="badge">v${v.version}${publishedMark}</a>`;
  }).join(" ");

  const publish = {
    isPublished: artifact.published_at != null,
    publicUrl: artifact.published_at != null ? getPublicArtifactUrl(db, artifact) : null,
    connectConfigured: getConnectPublicBase(db) != null,
  };

  return renderArtifactDetail(artifact, taskId, versionLinks, variant, publish);
}

function renderArtifactDetail(
  artifact: { id: string; name: string; version: number; kind: string; description: string | null; body: string | null; created_at: string },
  taskId: string,
  versionLinks: string,
  variant: ArtifactModalVariant,
  publish: { isPublished: boolean; publicUrl: string | null; connectConfigured: boolean },
): string {
  const bodyContent = artifact.body ? escapeHtml(artifact.body) : "(empty)";
  const rawBody = artifact.body ?? "";
  const renderedBody = looksLikeHtml(rawBody)
    ? rawBody.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    : `<div class="artifact-body-markdown" data-artifact-md>${escapeHtml(rawBody)}</div>`;

  // Artifact publishing (public Skipper Connect links) is experimental-only; the
  // whole surface (button, badge, public URL) is hidden unless the flag is on.
  const publishEnabled = isExperimental();
  const publishRoute = (action: "publish" | "unpublish") =>
    `hx-post="${variant.routePrefix}/${escapeHtml(taskId)}/artifacts/${encodeURIComponent(artifact.name)}/${action}?version=${artifact.version}" hx-target="${variant.target}" hx-swap="innerHTML"`;
  const publishButton = !publishEnabled
    ? ""
    : publish.isPublished
      ? `<button type="button" class="btn-sm" ${publishRoute("unpublish")}>Unpublish</button>`
      : publish.connectConfigured
        ? `<button type="button" class="btn-sm" ${publishRoute("publish")}>Publish</button>`
        : `<button type="button" class="btn-sm" disabled title="Configure Skipper Connect first">Publish</button>`;
  const publishedBadge = publishEnabled && publish.isPublished ? ` <span class="badge badge-published">Published</span>` : "";
  const publicUrlRow = publishEnabled && publish.isPublished && publish.publicUrl
    ? `<div class="artifact-public-url" style="display:flex;gap:var(--sk-space-2);align-items:center;margin:var(--sk-space-2) 0;">
        <input type="text" readonly class="sk-input" style="flex:1;font-size:0.75rem;" value="${escapeHtml(publish.publicUrl)}" onclick="this.select();">
        <button type="button" class="btn-sm" onclick="navigator.clipboard.writeText(this.previousElementSibling.value); this.textContent='Copied';">Copy link</button>
      </div>`
    : "";

  return `<div class="artifact-detail">
    <div class="artifact-detail-header">
      <h3>${escapeHtml(artifact.name)} <span class="badge badge-info">v${artifact.version}</span>${publishedBadge}</h3>
      <div style="display:flex;gap:0.5rem;align-items:center;">
        ${publishButton}
        <button type="button" class="btn-sm" data-sk-artifact-toggle data-mode="rendered">Raw</button>
        <button type="button" class="btn-sm" data-sk-artifact-edit>Edit</button>
      </div>
    </div>
    <p class="muted">${escapeHtml(artifact.kind)} &middot; ${formatTimestamp(artifact.created_at)}${artifact.description ? ` &middot; ${escapeHtml(artifact.description)}` : ""}</p>
    <div class="artifact-versions">Versions: ${versionLinks}</div>
    ${publicUrlRow}
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
