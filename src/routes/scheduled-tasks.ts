import { addRoute } from "../server";
import { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import type { ScheduleUnit } from "../tasks/scheduled-scheduler";
import type { ManagerDaemon } from "../agents/manager-daemon";
import { isExperimental } from "../config/feature-flags";
import { parsePhaseOverridesFromForm } from "./phase-overrides";

const EXPERIMENTAL_REQUIRED = Response.json({ error: "scheduled tasks require --experimental" }, { status: 403 });

// Mirror how regular tasks respond (src/routes/tasks.ts): a 200 with an
// HX-Redirect header. htmx honours the header and navigates client-side. We do
// NOT use a 3xx redirect — the browser's fetch auto-follows 3xx, so the final
// response carries no HX-Redirect header and the UI never updates.
const hxRedirect = (to: string) => new Response("", { status: 200, headers: { "HX-Redirect": to } });

// Parse an optional recurring interval from form fields. The UNIT drives it:
// an empty/"None" unit means manual-only (unit/amount null) regardless of any
// leftover value in the amount field. A set unit requires a valid amount.
export function parseOptionalInterval(
  unitRaw: FormDataEntryValue | null,
  amountRaw: FormDataEntryValue | null,
): { unit: ScheduleUnit | null; amount: number | null; error?: string } {
  const unitStr = typeof unitRaw === "string" ? unitRaw.trim() : "";
  const amountStr = typeof amountRaw === "string" ? amountRaw.trim() : "";

  // No unit selected => manual-only. Ignore the amount field entirely.
  if (!unitStr) return { unit: null, amount: null };

  if (!["minutes", "hours", "days"].includes(unitStr)) {
    return { unit: null, amount: null, error: "scheduleUnit must be minutes, hours, or days" };
  }
  const amount = parseInt(amountStr, 10);
  if (!Number.isFinite(amount) || amount < 1) {
    return { unit: null, amount: null, error: "scheduleAmount must be a positive integer" };
  }
  return { unit: unitStr as ScheduleUnit, amount };
}

export function registerScheduledTaskRoutes(daemon?: ManagerDaemon): void {
  const getScheduler = () => daemon?.getScheduledTaskScheduler() ?? new ScheduledTaskScheduler();

  addRoute("POST", "/api/scheduled-tasks", async (req) => {
    if (!isExperimental()) return EXPERIMENTAL_REQUIRED;


    const formData = await req.formData();
    const title = formData.get("title");
    const description = formData.get("description");
    const teamId = formData.get("teamId");
    const workingDirectory = formData.get("workingDirectory");
    const scheduleUnit = formData.get("scheduleUnit");
    const scheduleAmountRaw = formData.get("scheduleAmount");
    const autoApproveRaw = formData.get("autoApprove");

    if (!title || typeof title !== "string" || !title.trim()) {
      return Response.json({ error: "title is required" }, { status: 400 });
    }
    // Interval is optional. When omitted (or blank) the task is manual-only and
    // only runs via "Run Now". When provided, validate both unit and amount.
    const { unit: scheduleUnitVal, amount: scheduleAmountVal, error: intervalError } =
      parseOptionalInterval(scheduleUnit, scheduleAmountRaw);
    if (intervalError) return Response.json({ error: intervalError }, { status: 400 });

    const taskConfig: Record<string, unknown> = {};
    const resolvedTeamId = typeof teamId === "string" && teamId.trim() ? teamId.trim() : undefined;
    const { overrides: phaseOverrides } = parsePhaseOverridesFromForm(formData, resolvedTeamId);
    if (Object.keys(phaseOverrides).length > 0) taskConfig.phase_overrides = phaseOverrides;

    const scheduler = getScheduler();
    const task = scheduler.createScheduledTask({
      title: String(title).trim(),
      description: typeof description === "string" && description.trim() ? description.trim() : undefined,
      teamId: typeof teamId === "string" && teamId.trim() ? teamId.trim() : undefined,
      workingDirectory: typeof workingDirectory === "string" && workingDirectory.trim() ? workingDirectory.trim() : process.cwd(),
      scheduleUnit: scheduleUnitVal,
      scheduleAmount: scheduleAmountVal,
      taskConfig: Object.keys(taskConfig).length > 0 ? taskConfig : undefined,
    });

    const shouldAutoApprove = autoApproveRaw === "1" || autoApproveRaw === "true";
    if (shouldAutoApprove && task.team_id) {
      try {
        scheduler.approveScheduledTask(task.id);
      } catch { /* ignore approval errors for auto-approve */ }
    }

    return hxRedirect(`/?scheduled=${task.id}`);
  });

  addRoute("POST", "/api/scheduled-tasks/:id/update", async (req, params) => {
    if (!isExperimental()) return EXPERIMENTAL_REQUIRED;
    const id = params?.id;
    if (!id) return Response.json({ error: "id required" }, { status: 400 });

    const formData = await req.formData();
    const title = formData.get("title");
    const description = formData.get("description");
    const teamId = formData.get("teamId");
    const workingDirectory = formData.get("workingDirectory");
    const scheduleUnit = formData.get("scheduleUnit");
    const scheduleAmountRaw = formData.get("scheduleAmount");

    if (!title || typeof title !== "string" || !title.trim()) {
      return Response.json({ error: "title is required" }, { status: 400 });
    }

    // The edit form always submits scheduleUnit, so an empty value is an
    // explicit "clear the interval" (manual-only); a valid value sets it.
    const { unit: scheduleUnitVal, amount: scheduleAmountVal, error: intervalError } =
      parseOptionalInterval(scheduleUnit, scheduleAmountRaw);
    if (intervalError) return Response.json({ error: intervalError }, { status: 400 });

    const taskConfig: Record<string, unknown> = {};
    const resolvedTeamId = typeof teamId === "string" && teamId.trim() ? teamId.trim() : undefined;
    const { overrides: phaseOverrides } = parsePhaseOverridesFromForm(formData, resolvedTeamId);
    if (Object.keys(phaseOverrides).length > 0) taskConfig.phase_overrides = phaseOverrides;

    const scheduler = getScheduler();
    try {
      scheduler.updateScheduledTask(id, {
        title: String(title).trim(),
        description: typeof description === "string" && description.trim() ? description.trim() : undefined,
        teamId: typeof teamId === "string" && teamId.trim() ? teamId.trim() : undefined,
        workingDirectory: typeof workingDirectory === "string" && workingDirectory.trim() ? workingDirectory.trim() : undefined,
        scheduleUnit: scheduleUnitVal,
        scheduleAmount: scheduleAmountVal,
        taskConfig: Object.keys(taskConfig).length > 0 ? taskConfig : undefined,
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }

    return hxRedirect(`/?scheduled=${id}`);
  });

  addRoute("POST", "/api/scheduled-tasks/:id/approve", async (_req, params) => {
    if (!isExperimental()) return EXPERIMENTAL_REQUIRED;
    const id = params?.id;
    if (!id) return Response.json({ error: "id required" }, { status: 400 });

    const scheduler = getScheduler();
    try {
      scheduler.approveScheduledTask(id);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }

    return hxRedirect(`/?scheduled=${id}`);
  });

  addRoute("POST", "/api/scheduled-tasks/:id/unapprove", async (_req, params) => {
    if (!isExperimental()) return EXPERIMENTAL_REQUIRED;
    const id = params?.id;
    if (!id) return Response.json({ error: "id required" }, { status: 400 });

    const scheduler = getScheduler();
    try {
      scheduler.unapproveScheduledTask(id);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }

    return hxRedirect(`/?scheduled=${id}`);
  });

  addRoute("POST", "/api/scheduled-tasks/:id/clear-schedule", async (_req, params) => {
    if (!isExperimental()) return EXPERIMENTAL_REQUIRED;
    const id = params?.id;
    if (!id) return Response.json({ error: "id required" }, { status: 400 });

    const scheduler = getScheduler();
    try {
      scheduler.clearSchedule(id);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }

    return hxRedirect(`/?scheduled=${id}`);
  });

  addRoute("POST", "/api/scheduled-tasks/:id/run-now", async (req, params) => {
    if (!isExperimental()) return EXPERIMENTAL_REQUIRED;
    const id = params?.id;
    if (!id) return Response.json({ error: "id required" }, { status: 400 });

    const scheduler = getScheduler();
    const taskScheduler = daemon?.getTaskScheduler();
    if (!taskScheduler) return Response.json({ error: "daemon unavailable" }, { status: 500 });

    // Optional per-run input injected into the spawned run's prompt.
    let runInput: string | undefined;
    try {
      const formData = await req.formData();
      const raw = formData.get("input");
      if (typeof raw === "string" && raw.trim()) runInput = raw.trim();
    } catch { /* no body / not form-encoded — run without input */ }

    try {
      scheduler.runTaskNow(id, taskScheduler, runInput);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes("not found") ? 404 : 400;
      return Response.json({ error: msg }, { status });
    }

    return hxRedirect(`/?scheduled=${id}`);
  });

  addRoute("DELETE", "/api/scheduled-tasks/:id", async (_req, params) => {
    if (!isExperimental()) return EXPERIMENTAL_REQUIRED;
    const id = params?.id;
    if (!id) return Response.json({ error: "id required" }, { status: 400 });

    const scheduler = getScheduler();
    try {
      scheduler.deleteScheduledTask(id);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }

    return hxRedirect("/");
  });
}
