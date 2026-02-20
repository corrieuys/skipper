import { addRoute } from "../server";
import { TaskScheduler } from "../tasks/scheduler";
import { getDb } from "../db/connection";
import { taskDetailPage, tasksPage, taskListFragment } from "../html/components";
import type { ArtifactData, DelegationData, TaskData, TaskNoteData } from "../html/components";

function html(content: string): Response {
  return new Response(content, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
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

function tasksPageResponse(): Response {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM tasks ORDER BY priority, created_at DESC").all() as Record<string, unknown>[];
  const tasks = rows.map(parseTaskRow);
  return html(tasksPage(tasks));
}

function taskDetailResponse(id: string): Response {
  const db = getDb();
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!row) return html("<p>Task not found</p>");
  const task = parseTaskRow(row);

  if (task.team_id) {
    const teamRow = db.prepare("SELECT phases FROM teams WHERE id = ?").get(task.team_id) as { phases: string } | null;
    if (teamRow) {
      try { task.phases = JSON.parse(teamRow.phases); } catch { /* ignore */ }
    }
  }

  const notes = db.prepare("SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at").all(id) as TaskNoteData[];
  const delegations = db.prepare("SELECT * FROM delegations WHERE task_id = ? ORDER BY created_at").all(id) as DelegationData[];
  const artifacts = db.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at").all(id) as ArtifactData[];

  return html(taskDetailPage(task, notes, delegations, artifacts));
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
      const tasks = scheduler.listTasks() as unknown as TaskData[];
      return html(taskListFragment(tasks));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return html(`<p class='error'>${message}</p>`);
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
}
