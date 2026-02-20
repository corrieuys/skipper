import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { logError } from "../logging";
import { eventBus } from "../events/bus";
import type { AgentOutputEvent, AgentExitEvent, TaskStateChangedEvent, AgentStateChangedEvent, EscalationCreatedEvent } from "../events/bus";
import {
  dashboardPage,
  tasksPage,
  taskDetailPage,
  agentsPage,
  agentDetailPage,
  teamsPage,
  teamDetailPage,
  escalationsPage,
  terminalOutputFragment,
  auditEventsPage,
  helpPage,
} from "../html/components";
import type {
  DashboardData,
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

export function registerPageRoutes(daemon: ManagerDaemon): void {
  const db = getDb();

  // Dashboard
  addRoute("GET", "/", () => {
    const tasks = db.prepare("SELECT id, title, status, priority FROM tasks ORDER BY priority, created_at DESC").all() as DashboardData["tasks"];
    const agents = db.prepare("SELECT id, name, status, type, current_task_id FROM agents ORDER BY created_at").all() as DashboardData["agents"];
    const daemonStatus = daemon ? daemon.getStatus() : { state: "stopped" as const, uptime: 0 };
    return html(dashboardPage({ tasks, agents, daemon: daemonStatus }));
  });

  // Tasks list
  addRoute("GET", "/tasks", () => {
    const rows = db.prepare("SELECT * FROM tasks ORDER BY priority, created_at DESC").all() as Record<string, unknown>[];
    const tasks = rows.map((r) => parseRow(r, ["result", "orchestration_state"])) as unknown as TaskData[];
    return html(tasksPage(tasks));
  });

  // Task detail
  addRoute("GET", "/tasks/:id", (_req, params) => {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(params.id) as Record<string, unknown> | null;
    if (!row) return html("<p>Task not found</p>");
    const task = parseRow(row, ["result", "orchestration_state"]) as unknown as TaskData;

    // Attach team phases for the stepper
    if (task.team_id) {
      const teamRow = db.prepare("SELECT phases FROM teams WHERE id = ?").get(task.team_id) as { phases: string } | null;
      if (teamRow) {
        try { task.phases = JSON.parse(teamRow.phases); } catch { /* ignore */ }
      }
    }

    const notes = db.prepare("SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at").all(params.id) as TaskNoteData[];
    const delegations = db.prepare("SELECT * FROM delegations WHERE task_id = ? ORDER BY created_at").all(params.id) as DelegationData[];
    const artifacts = db.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at").all(params.id) as ArtifactData[];

    return html(taskDetailPage(task, notes, delegations, artifacts));
  });

  // Agents list
  addRoute("GET", "/agents", () => {
    const rows = db.prepare("SELECT * FROM agents ORDER BY created_at").all() as Record<string, unknown>[];
    const agents = rows.map((r) => parseRow(r, ["config", "capabilities"])) as unknown as AgentData[];
    return html(agentsPage(agents));
  });

  // Agent detail
  addRoute("GET", "/agents/:id", (_req, params) => {
    const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(params.id) as Record<string, unknown> | null;
    if (!row) return html("<p>Agent not found</p>");
    const agent = parseRow(row, ["config", "capabilities"]) as unknown as AgentData;
    return html(agentDetailPage(agent));
  });

  // Agent terminal output
  addRoute("GET", "/agents/:id/output", (_req, params) => {
    const rows = db.prepare(
      "SELECT stream, data, sequence FROM terminal_outputs WHERE agent_id = ? ORDER BY sequence",
    ).all(params.id) as { stream: string; data: string; sequence: number }[];
    return html(terminalOutputFragment(rows));
  });

  // Teams list
  addRoute("GET", "/teams", () => {
    const rows = db.prepare("SELECT * FROM teams ORDER BY created_at").all() as Record<string, unknown>[];
    const teams = rows.map((r) => parseRow(r, ["phases"])) as unknown as TeamData[];
    return html(teamsPage(teams));
  });

  // Team detail
  addRoute("GET", "/teams/:id", (_req, params) => {
    const row = db.prepare("SELECT * FROM teams WHERE id = ?").get(params.id) as Record<string, unknown> | null;
    if (!row) return html("<p>Team not found</p>");
    const team = parseRow(row, ["phases"]) as unknown as TeamData;

    const agentRows = db.prepare(
      `SELECT ta.agent_id, a.name as agent_name, ta.role, ta.level, ta.skills
       FROM team_agents ta JOIN agents a ON ta.agent_id = a.id
       WHERE ta.team_id = ? ORDER BY ta.level`,
    ).all(params.id) as Record<string, unknown>[];
    const agents = agentRows.map((r) => parseRow(r, ["skills"])) as unknown as TeamAgentData[];

    return html(teamDetailPage(team, agents));
  });

  // Escalations
  addRoute("GET", "/escalations", () => {
    const rows = db.prepare("SELECT * FROM escalations ORDER BY created_at DESC").all() as EscalationData[];
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
    const rows = db.prepare("SELECT * FROM escalations ORDER BY created_at DESC").all() as EscalationData[];
    return html(escalationsPage(rows));
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
      const handler = (event: TaskStateChangedEvent) => {
        const tasks = db.prepare("SELECT id, title, status, priority FROM tasks WHERE status IN ('running', 'approved') ORDER BY priority").all();
        send("task:state_changed", tasks.map((t: any) => taskRowHtml(t)).join("") || "<p class='muted'>No active tasks</p>");
      };
      eventBus.on("task:state_changed", handler);
      return () => eventBus.off("task:state_changed", handler);
    });
  });

  addRoute("GET", "/events/agents", () => {
    return createSSEStream((send) => {
      const handler = (event: AgentStateChangedEvent) => {
        const agents = db.prepare("SELECT id, name, status, type FROM agents ORDER BY created_at").all();
        send("agent:state_changed", agents.map((a: any) => agentRowHtml(a)).join("") || "<p class='muted'>No agents configured</p>");
      };
      eventBus.on("agent:state_changed", handler);
      return () => eventBus.off("agent:state_changed", handler);
    });
  });

  addRoute("GET", "/events/agent/:id/output", (_req, params) => {
    return createSSEStream((send) => {
      const handler = (event: AgentOutputEvent) => {
        if (event.agentId === params.id) {
          const cls = event.stream === "stderr" ? "terminal-stderr" : "terminal-stdout";
          send("agent:output", `<div class="terminal-line ${cls}">${escapeForHtml(event.data)}</div>`);
        }
      };
      eventBus.on("agent:output", handler);
      return () => eventBus.off("agent:output", handler);
    });
  });

  addRoute("GET", "/events/escalations", () => {
    return createSSEStream((send) => {
      const handler = (event: EscalationCreatedEvent) => {
        const row = db.prepare("SELECT * FROM escalations WHERE id = ?").get(event.escalationId) as EscalationData | null;
        if (row) {
          send("escalation:created", escalationCardHtml(row));
        }
      };
      eventBus.on("escalation:created", handler);
      return () => eventBus.off("escalation:created", handler);
    });
  });
}

// Inline HTML helpers for SSE updates (avoid importing full components for small fragments)
function taskRowHtml(task: { id: string; title: string; status: string; priority: number }): string {
  return `<div class="list-item">
    <span class="badge badge-${task.status}">${task.status}</span>
    <a href="/tasks/${escapeForHtml(task.id)}">${escapeForHtml(task.title)}</a>
    <span class="priority">P${task.priority}</span>
  </div>`;
}

function agentRowHtml(agent: { id: string; name: string; status: string; type: string }): string {
  return `<div class="list-item">
    <span class="badge badge-${agent.status}">${agent.status}</span>
    <a href="/agents/${escapeForHtml(agent.id)}">${escapeForHtml(agent.name)}</a>
    <span class="muted">${escapeForHtml(agent.type)}</span>
  </div>`;
}

function escalationCardHtml(esc: EscalationData): string {
  return `<div class="card escalation-card">
    <div class="escalation-header">
      <span class="badge badge-open">open</span>
      <span class="badge">${escapeForHtml(esc.type)}</span>
      <span class="muted">${escapeForHtml(esc.created_at)}</span>
    </div>
    <div class="escalation-question"><strong>Question:</strong> ${escapeForHtml(esc.question)}</div>
    <form hx-post="/api/escalations/${escapeForHtml(esc.id)}/resolve" hx-target="body" hx-swap="innerHTML" class="escalation-form">
      <textarea name="response" placeholder="Type your response..." rows="3" required></textarea>
      <button type="submit">Respond</button>
    </form>
  </div>`;
}

function escapeForHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
