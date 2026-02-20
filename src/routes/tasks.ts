import { addRoute } from "../server";
import { TaskScheduler } from "../tasks/scheduler";
import { getDb } from "../db/connection";
import { tasksPage, taskListFragment } from "../html/components";
import type { TaskData } from "../html/components";

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

function tasksPageResponse(): Response {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM tasks ORDER BY priority, created_at DESC").all() as Record<string, unknown>[];
  const tasks = rows.map(parseTaskRow);
  return html(tasksPage(tasks));
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
