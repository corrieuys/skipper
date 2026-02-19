import { addRoute } from "../server";
import { TaskScheduler } from "../tasks/scheduler";

export function registerTaskRoutes(): void {
  const scheduler = new TaskScheduler();

  addRoute("POST", "/api/tasks", async (req) => {
    const body = await req.json();

    if (!body.title) {
      return Response.json({ error: "title is required" }, { status: 400 });
    }

    try {
      const task = scheduler.createTask({
        title: body.title,
        description: body.description,
        teamId: body.teamId,
        priority: body.priority,
      });
      return Response.json(task, { status: 201 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
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
      const task = scheduler.approveTask(params.id);
      return Response.json(task);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/cancel", (_req, params) => {
    try {
      const task = scheduler.cancelTask(params.id);
      return Response.json(task);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/retry", (_req, params) => {
    try {
      const task = scheduler.retryTask(params.id);
      return Response.json(task);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });
}
