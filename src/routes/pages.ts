import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { logError } from "../logging";
import { eventBus } from "../events/bus";
import type { AgentOutputEvent, AgentExitEvent, TaskStateChangedEvent, AgentStateChangedEvent, EscalationCreatedEvent } from "../events/bus";
import {
  dashboardPage,
  dashboardActiveTaskFragment,
  dashboardAgentStatusFragment,
  tasksPage,
  taskListPollingFragment,
  taskDetailPage,
  taskDetailSummaryFragment,
  taskPhaseStepperFragment,
  taskDelegationsFragment,
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
  formatTimestamp,
} from "../html/components";
import type {
  DashboardData,
  PollIntervalSeconds,
  TaskData,
  AgentData,
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
      EXISTS(SELECT 1 FROM agents WHERE status = 'busy') AS has_busy_agent`,
  ).get() as { has_active_task: number; has_busy_agent: number };

  return (row.has_active_task === 1 || row.has_busy_agent === 1) ? 3 : 8;
}

function fetchTasksWithTeams(db: ReturnType<typeof getDb>): TaskData[] {
  const rows = db.prepare(
    `SELECT t.*, tm.name AS team_name
     FROM tasks t
     LEFT JOIN teams tm ON tm.id = t.team_id
     ORDER BY t.priority, t.created_at DESC`,
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
  const rows = db.prepare("SELECT * FROM agents ORDER BY created_at").all() as Record<string, unknown>[];
  return rows.map((r) => parseRow(r, ["config", "capabilities"])) as unknown as AgentData[];
}

function fetchAgentById(db: ReturnType<typeof getDb>, agentId: string): AgentData | null {
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Record<string, unknown> | null;
  if (!row) return null;
  return parseRow(row, ["config", "capabilities"]) as unknown as AgentData;
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

export function registerPageRoutes(daemon: ManagerDaemon): void {
  const db = getDb();

  // Dashboard
  addRoute("GET", "/", () => {
    const tasks = db.prepare("SELECT id, title, status, priority FROM tasks ORDER BY priority, created_at DESC").all() as DashboardData["tasks"];
    const agents = db.prepare("SELECT id, name, status, type, current_task_id FROM agents ORDER BY created_at").all() as DashboardData["agents"];
    const daemonStatus = daemon ? daemon.getStatus() : { state: "stopped" as const, uptime: 0 };
    const recentLogs = db.prepare(
      `SELECT to2.agent_id, a.name as agent_name, to2.stream, to2.data, to2.created_at
       FROM terminal_outputs to2
       JOIN agents a ON to2.agent_id = a.id
       ORDER BY to2.id DESC LIMIT 10`,
    ).all() as RecentLogEntry[];
    return html(dashboardPage({ tasks, agents, daemon: daemonStatus, recentLogs }));
  });

  // Recent logs fragment (for SSE-triggered HTMX refresh fallback)
  addRoute("GET", "/api/logs/recent", () => {
    const recentLogs = db.prepare(
      `SELECT to2.agent_id, a.name as agent_name, to2.stream, to2.data, to2.created_at
       FROM terminal_outputs to2
       JOIN agents a ON to2.agent_id = a.id
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
    if (!task) return html("<p>Task not found</p>");

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

    return html(taskDetailPage(task, notes, delegations, artifacts, teams, getPollIntervalSeconds(db)));
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

  // Agents list
  addRoute("GET", "/agents", () => {
    const agents = fetchAgents(db);
    return html(agentsPage(agents, getPollIntervalSeconds(db)));
  });

  // Agent detail
  addRoute("GET", "/agents/:id", (req, params) => {
    const agent = fetchAgentById(db, params.id);
    if (!agent) return html("<p>Agent not found</p>");

    // Fetch sessions for this agent
    const sessions = db.prepare(
      "SELECT id, created_at FROM agent_sessions WHERE agent_id = ? ORDER BY created_at DESC",
    ).all(params.id) as { id: string; created_at: string }[];

    // Determine selected session from query param
    const url = new URL(req.url);
    const selectedSessionId = url.searchParams.get("session") ?? undefined;

    return html(agentDetailPage(agent, sessions, selectedSessionId, getPollIntervalSeconds(db)));
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

    let rows: { stream: string; data: string; sequence: number }[];
    if (sessionId) {
      rows = db.prepare(
        "SELECT stream, data, sequence FROM terminal_outputs WHERE agent_id = ? AND session_id = ? ORDER BY sequence",
      ).all(params.id, sessionId) as { stream: string; data: string; sequence: number }[];
    } else {
      // Default: show latest session's output
      const latestSession = db.prepare(
        "SELECT id FROM agent_sessions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1",
      ).get(params.id) as { id: string } | null;

      if (latestSession) {
        rows = db.prepare(
          "SELECT stream, data, sequence FROM terminal_outputs WHERE agent_id = ? AND session_id = ? ORDER BY sequence",
        ).all(params.id, latestSession.id) as { stream: string; data: string; sequence: number }[];
      } else {
        // Fallback for outputs without session_id (pre-migration data)
        rows = db.prepare(
          "SELECT stream, data, sequence FROM terminal_outputs WHERE agent_id = ? ORDER BY sequence",
        ).all(params.id) as { stream: string; data: string; sequence: number }[];
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
    if (!team) return html("<p>Team not found</p>");
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
      `SELECT t.id, t.agent_id, a.name as agent_name, t.session_id, t.stream, t.data, t.sequence, t.created_at
       FROM terminal_outputs t
       JOIN agents a ON t.agent_id = a.id
       ${where}
       ORDER BY t.id DESC LIMIT 200`,
    ).all(...values) as LogEntryData[];

    const agents = db.prepare("SELECT id, name FROM agents ORDER BY name").all() as { id: string; name: string }[];

    return html(logsPage(entries, filters, agents));
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
          `SELECT to2.agent_id, a.name as agent_name, to2.stream, to2.data, to2.created_at
           FROM terminal_outputs to2
           JOIN agents a ON to2.agent_id = a.id
           ORDER BY to2.id DESC LIMIT 10`,
        ).all() as RecentLogEntry[];
        send("logs:activity", recentActivityFragment(recentLogs));
      };
      eventBus.on("agent:output", handler);
      return () => eventBus.off("agent:output", handler);
    });
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
