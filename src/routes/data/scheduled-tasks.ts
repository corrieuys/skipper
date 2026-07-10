import { addDataRoute } from "./auth";
import { ScheduledTaskScheduler } from "../../tasks/scheduled-scheduler";
import type { ScheduleUnit, ScheduleMatrix } from "../../tasks/scheduled-scheduler";
import { parseScheduleFields } from "../scheduled-tasks";
import { parseRequestBody } from "../utils";
import { isExperimental } from "../../config/feature-flags";
import type { ManagerDaemon } from "../../agents/manager-daemon";

function ok(data: unknown, status: number = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

function err(message: string, status: number = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

// Index signature satisfies parseRequestBody's Record<string, unknown> constraint.
interface ScheduledTaskBody extends Record<string, unknown> {
  title?: string;
  description?: string;
  teamId?: string;
  workingDirectory?: string;
  scheduleUnit?: string;
  scheduleAmount?: string | number;
  // Weekly matrix: the natural JSON array or a pre-encoded JSON string.
  scheduleMatrix?: string | number[][];
  // Global-store usage contract, injected into every spawned run's prompt.
  globalStoreInstructions?: string;
  taskConfig?: Record<string, unknown>;
}

function parseSchedule(body: ScheduledTaskBody): { unit: ScheduleUnit | null; amount: number | null; matrix: ScheduleMatrix | null; error?: string } {
  return parseScheduleFields(
    body.scheduleUnit ?? null,
    body.scheduleAmount !== undefined ? String(body.scheduleAmount) : null,
    body.scheduleMatrix !== undefined && typeof body.scheduleMatrix !== "string"
      ? JSON.stringify(body.scheduleMatrix)
      : body.scheduleMatrix ?? null,
  );
}

export function registerDataScheduledTaskRoutes(
  daemon?: Pick<ManagerDaemon, "getScheduledTaskScheduler" | "getTaskScheduler">,
): void {
  const getScheduler = () => daemon?.getScheduledTaskScheduler() ?? new ScheduledTaskScheduler();

  // Mirrors /api/scheduled-tasks: recurring tasks are an experimental feature,
  // so the data API hides them behind the same flag.
  function experimentalGate(): Response | null {
    if (!isExperimental()) return err("Recurring tasks require --experimental", 403);
    return null;
  }

  addDataRoute("GET", "/data/scheduled-tasks", () => {
    return experimentalGate() ?? ok(getScheduler().listScheduledTasks());
  });

  addDataRoute("GET", "/data/scheduled-tasks/:id", (_req, params) => {
    const gate = experimentalGate();
    if (gate) return gate;
    const scheduler = getScheduler();
    const task = scheduler.getScheduledTask(params.id);
    if (!task) return err("Scheduled task not found", 404);
    return ok({ ...task, runs: scheduler.getRunsForScheduledTask(params.id) });
  });

  addDataRoute("POST", "/data/scheduled-tasks", async (req) => {
    const gate = experimentalGate();
    if (gate) return gate;
    const body = await parseRequestBody<ScheduledTaskBody>(req);
    if (!body.title?.trim()) return err("title is required");
    const { unit, amount, matrix, error } = parseSchedule(body);
    if (error) return err(error);
    try {
      const task = getScheduler().createScheduledTask({
        title: body.title.trim(),
        description: body.description?.trim() || undefined,
        teamId: body.teamId?.trim() || undefined,
        workingDirectory: body.workingDirectory?.trim() || process.cwd(),
        scheduleUnit: unit,
        scheduleAmount: amount,
        scheduleMatrix: matrix,
        globalStoreInstructions: body.globalStoreInstructions?.trim() || undefined,
        taskConfig: body.taskConfig,
      });
      return ok(task, 201);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/scheduled-tasks/:id", async (req, params) => {
    const gate = experimentalGate();
    if (gate) return gate;
    const body = await parseRequestBody<ScheduledTaskBody>(req);
    if (!body.title?.trim()) return err("title is required");
    const { unit, amount, matrix, error } = parseSchedule(body);
    if (error) return err(error);
    try {
      const task = getScheduler().updateScheduledTask(params.id, {
        title: body.title.trim(),
        description: body.description?.trim() || undefined,
        teamId: body.teamId?.trim() || undefined,
        workingDirectory: body.workingDirectory?.trim() || undefined,
        scheduleUnit: unit,
        scheduleAmount: amount,
        scheduleMatrix: matrix,
        globalStoreInstructions: body.globalStoreInstructions?.trim() || undefined,
        taskConfig: body.taskConfig,
      });
      return ok(task);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  for (const action of ["approve", "unapprove"] as const) {
    addDataRoute("POST", `/data/scheduled-tasks/:id/${action}`, (_req, params) => {
      const gate = experimentalGate();
      if (gate) return gate;
      try {
        const scheduler = getScheduler();
        const task = action === "approve"
          ? scheduler.approveScheduledTask(params.id)
          : scheduler.unapproveScheduledTask(params.id);
        return ok(task);
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : "Internal error");
      }
    });
  }

  addDataRoute("POST", "/data/scheduled-tasks/:id/run-now", async (req, params) => {
    const gate = experimentalGate();
    if (gate) return gate;
    if (!daemon) return err("Daemon not available", 503);
    let input: string | undefined;
    try {
      const body = await parseRequestBody<{ input?: string }>(req);
      if (typeof body.input === "string" && body.input.trim()) input = body.input.trim();
    } catch { /* no body */ }
    try {
      const task = getScheduler().runTaskNow(params.id, daemon.getTaskScheduler(), input);
      return ok(task, 201);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  const handleDelete = (_req: Request, params: Record<string, string>) => {
    const gate = experimentalGate();
    if (gate) return gate;
    try {
      getScheduler().deleteScheduledTask(params.id);
      return ok({ id: params.id, deleted: true });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  };
  addDataRoute("DELETE", "/data/scheduled-tasks/:id", handleDelete);
  addDataRoute("POST", "/data/scheduled-tasks/:id/delete", handleDelete);
}
