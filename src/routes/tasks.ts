import { addRoute } from "../server";
import { TaskScheduler } from "../tasks/scheduler";
import { getDb } from "../db/connection";
import { taskDetailPage, tasksPage, taskListFragment, diagnosticCard } from "../html/components";
import { getPollIntervalSeconds } from "./pages";
import type {
  ArtifactData,
  DelegationData,
  TaskData,
  TaskNoteData,
  TeamOptionData,
  TaskHealthSummary,
} from "../html/components";

function html(content: string): Response {
  return new Response(content, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseTaskRow(row: Record<string, unknown>): TaskData {
  const result = { ...row };
  for (const field of ["result", "orchestration_state"]) {
    if (typeof result[field] === "string") {
      try {
        result[field] = JSON.parse(result[field] as string);
      } catch {
        // leave as string if not valid JSON
      }
    }
  }
  return result as unknown as TaskData;
}

function listTaskRowsForUi(): TaskData[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT t.*, tm.name AS team_name
     FROM tasks t
     LEFT JOIN teams tm ON tm.id = t.team_id
     ORDER BY t.priority, t.created_at DESC, t.rowid DESC`,
  ).all() as Record<string, unknown>[];
  return rows.map(parseTaskRow);
}

function listTeamsForUi(): TeamOptionData[] {
  const db = getDb();
  return db.prepare("SELECT id, name FROM teams ORDER BY name").all() as TeamOptionData[];
}

async function parseBody(req: Request): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await req.formData();
    const body: Record<string, string> = {};
    formData.forEach((value, key) => {
      body[key] = value.toString();
    });
    return body;
  }
  return req.json();
}

function tasksPageResponse(errorMessage?: string): Response {
  return html(tasksPage(listTaskRowsForUi(), listTeamsForUi(), getPollIntervalSeconds(getDb()), errorMessage));
}

function taskDetailResponse(id: string): Response {
  const db = getDb();
  const row = db.prepare(
    `SELECT t.*, tm.name AS team_name
     FROM tasks t
     LEFT JOIN teams tm ON tm.id = t.team_id
     WHERE t.id = ?`,
  ).get(id) as Record<string, unknown> | null;
  if (!row) return new Response("<p>Task not found</p>", { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  const task = parseTaskRow(row);

  if (task.team_id) {
    const teamRow = db.prepare("SELECT phases FROM teams WHERE id = ?").get(task.team_id) as { phases: string } | null;
    if (teamRow) {
      try { task.phases = JSON.parse(teamRow.phases); } catch { /* ignore */ }
    }
  }

  const notes = db.prepare(
    `SELECT n.*, a.name AS agent_name
     FROM task_notes n
     LEFT JOIN agents a ON a.id = n.agent_id
     WHERE n.task_id = ?
     ORDER BY n.created_at`,
  ).all(id) as TaskNoteData[];
  const delegations = db.prepare(
    `SELECT d.*,
            pa.name AS parent_agent_name,
            ca.name AS child_agent_name
     FROM delegations d
     LEFT JOIN agents pa ON pa.id = d.parent_agent_id
     LEFT JOIN agents ca ON ca.id = d.child_agent_id
     WHERE d.task_id = ?
     ORDER BY d.created_at`,
  ).all(id) as DelegationData[];
  const artifacts = db.prepare(
    `SELECT ar.*, a.name AS agent_name
     FROM artifacts ar
     LEFT JOIN agents a ON a.id = ar.agent_id
     WHERE ar.task_id = ?
     ORDER BY ar.created_at`,
  ).all(id) as ArtifactData[];

  // Fetch health summary for running tasks
  if (task.status === "running") {
    task.healthSummary = fetchTaskHealthSummary(id, db);
  }

  return html(taskDetailPage(task, notes, delegations, artifacts, listTeamsForUi(), getPollIntervalSeconds(getDb())));
}

function fetchTaskHealthSummary(taskId: string, db: ReturnType<typeof getDb>): TaskHealthSummary {
  const row = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM agent_instances WHERE task_id = ? AND status IN ('running', 'waiting_delegation')) AS live_runtime_count,
       (SELECT COUNT(*) FROM delegations WHERE task_id = ? AND status IN ('pending', 'running')) AS active_delegation_count,
       (SELECT COUNT(*) FROM escalations WHERE task_id = ? AND status = 'open') AS open_escalation_count,
       (SELECT MAX(created_at) FROM task_checkpoints WHERE task_id = ?) AS last_progress,
       (SELECT COUNT(*) FROM events WHERE task_id = ? AND type LIKE 'remediation:%') AS remediation_event_count`,
  ).get(taskId, taskId, taskId, taskId, taskId) as {
    live_runtime_count: number;
    active_delegation_count: number;
    open_escalation_count: number;
    last_progress: string | null;
    remediation_event_count: number;
  };

  return {
    liveRuntimeCount: row.live_runtime_count,
    activeDelegationCount: row.active_delegation_count,
    openEscalationCount: row.open_escalation_count,
    lastProgressAt: row.last_progress,
    remediationEventCount: row.remediation_event_count,
  };
}

export function registerTaskRoutes(): void {
  const scheduler = new TaskScheduler();

  addRoute("POST", "/api/tasks", async (req) => {
    const formData = await req.formData();
    const title = formData.get("title");
    const description = formData.get("description");
    const teamId = formData.get("teamId");
    const priorityRaw = formData.get("priority");

    if (!title || typeof title !== "string" || !title.trim()) {
      return html("<p class='error'>title is required</p>");
    }

    try {
      scheduler.createTask({
        title: title.trim(),
        description: typeof description === "string" && description.trim() ? description.trim() : undefined,
        teamId: typeof teamId === "string" && teamId.trim() ? teamId.trim() : undefined,
        priority: priorityRaw ? Number(priorityRaw) : undefined,
      });
      return html(taskListFragment(listTaskRowsForUi()));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return html(`<p class='error'>${escapeHtml(message)}</p>`);
    }
  });

  addRoute("GET", "/api/tasks", () => {
    const tasks = scheduler.listTasks();
    return Response.json(tasks);
  });

  addRoute("GET", "/api/tasks/:id", (_req, params) => {
    const task = scheduler.getTask(params.id);
    if (!task) {
      return Response.json({ error: "Task not found" }, { status: 404 });
    }
    return Response.json(task);
  });

  addRoute("POST", "/api/tasks/:id", async (req, params) => {
    const body = await parseBody(req);

    if (!body.title || !body.title.trim()) {
      return Response.json(
        { error: "title is required" },
        { status: 400 },
      );
    }

    try {
      const updated = scheduler.updateTask(params.id, {
        title: body.title,
        description: body.description,
        teamId: body.teamId,
        priority: body.priority ? Number(body.priority) : undefined,
      });

      if (req.headers.get("HX-Request")) {
        return taskDetailResponse(updated.id);
      }

      return Response.json(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/approve", (_req, params) => {
    try {
      scheduler.approveTask(params.id);
      return tasksPageResponse();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      if (_req.headers.get("HX-Request")) {
        return tasksPageResponse(message);
      }
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/cancel", (_req, params) => {
    try {
      scheduler.cancelTask(params.id);
      return tasksPageResponse();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/retry", (_req, params) => {
    try {
      scheduler.retryTask(params.id);
      return tasksPageResponse();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/delete", (_req, params) => {
    try {
      scheduler.deleteTask(params.id);
      return tasksPageResponse();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/clear-stale", (_req, params) => {
    try {
      const db = getDb();
      // Clear stale agent assignments for this task
      db.prepare("UPDATE agents SET current_task_id = NULL, process_pid = NULL WHERE current_task_id = ?").run(params.id);
      // Fail active instances
      db.prepare(
        "UPDATE agent_instances SET status = 'failed', process_pid = NULL, updated_at = datetime('now') WHERE task_id = ? AND status IN ('running', 'waiting_delegation', 'pending')",
      ).run(params.id);

      if (_req.headers.get("HX-Request")) {
        return taskDetailResponse(params.id);
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });
}
