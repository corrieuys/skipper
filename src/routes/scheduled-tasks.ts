import { addRoute } from "../server";
import { hxRedirect } from "./utils";
import { ScheduledTaskScheduler, isValidScheduleMatrix } from "../tasks/scheduled-scheduler";
import type { ScheduleUnit, ScheduleMatrix } from "../tasks/scheduled-scheduler";
import type { ManagerDaemon } from "../agents/manager-daemon";
import { parsePhaseOverridesFromForm } from "./phase-overrides";



// Parse the optional recurring schedule from form fields. Two mutually
// exclusive modes: a fixed interval (unit + amount) or a weekly matrix
// (JSON 7x24 grid of 0/1). Empty unit AND empty matrix means manual-only.
// A set unit requires a valid amount; leftover amount values are ignored
// when no unit is selected.
export function parseScheduleFields(
  unitRaw: string | File | null,
  amountRaw: string | File | null,
  matrixRaw: string | File | null,
): { unit: ScheduleUnit | null; amount: number | null; matrix: ScheduleMatrix | null; error?: string } {
  const none = { unit: null, amount: null, matrix: null };
  const unitStr = typeof unitRaw === "string" ? unitRaw.trim() : "";
  const amountStr = typeof amountRaw === "string" ? amountRaw.trim() : "";
  const matrixStr = typeof matrixRaw === "string" ? matrixRaw.trim() : "";

  if (unitStr && matrixStr) {
    return { ...none, error: "Provide either an interval or a weekly schedule, not both" };
  }

  if (matrixStr) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(matrixStr);
    } catch {
      return { ...none, error: "scheduleMatrix must be valid JSON" };
    }
    if (!isValidScheduleMatrix(parsed)) {
      return { ...none, error: "scheduleMatrix must be a 7x24 array of 0/1 with at least one enabled hour" };
    }
    return { unit: null, amount: null, matrix: parsed };
  }

  // No unit selected => manual-only. Ignore the amount field entirely.
  if (!unitStr) return none;

  if (!["minutes", "hours", "days"].includes(unitStr)) {
    return { ...none, error: "scheduleUnit must be minutes, hours, or days" };
  }
  const amount = parseInt(amountStr, 10);
  if (!Number.isFinite(amount) || amount < 1) {
    return { ...none, error: "scheduleAmount must be a positive integer" };
  }
  return { unit: unitStr as ScheduleUnit, amount, matrix: null };
}

export function registerScheduledTaskRoutes(daemon?: ManagerDaemon): void {
  const getScheduler = () => daemon?.getScheduledTaskScheduler() ?? new ScheduledTaskScheduler();

  addRoute("POST", "/api/scheduled-tasks", async (req) => {
    const formData = await req.formData();
    const title = formData.get("title");
    const description = formData.get("description");
    const teamId = formData.get("teamId");
    const workingDirectory = formData.get("workingDirectory");
    const scheduleUnit = formData.get("scheduleUnit");
    const scheduleAmountRaw = formData.get("scheduleAmount");
    const scheduleMatrixRaw = formData.get("scheduleMatrix");
    const globalStoreInstructions = formData.get("globalStoreInstructions");
    const autoApproveRaw = formData.get("autoApprove");

    if (!title || typeof title !== "string" || !title.trim()) {
      return Response.json({ error: "title is required" }, { status: 400 });
    }
    // Schedule is optional. When omitted (or blank) the task is manual-only and
    // only runs via "Run Now". Interval and weekly matrix are mutually exclusive.
    const { unit: scheduleUnitVal, amount: scheduleAmountVal, matrix: scheduleMatrixVal, error: scheduleError } =
      parseScheduleFields(scheduleUnit, scheduleAmountRaw, scheduleMatrixRaw);
    if (scheduleError) return Response.json({ error: scheduleError }, { status: 400 });

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
      scheduleMatrix: scheduleMatrixVal,
      globalStoreInstructions: typeof globalStoreInstructions === "string" && globalStoreInstructions.trim() ? globalStoreInstructions.trim() : undefined,
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
    const id = params?.id;
    if (!id) return Response.json({ error: "id required" }, { status: 400 });

    const formData = await req.formData();
    const title = formData.get("title");
    const description = formData.get("description");
    const teamId = formData.get("teamId");
    const workingDirectory = formData.get("workingDirectory");
    const scheduleUnit = formData.get("scheduleUnit");
    const scheduleAmountRaw = formData.get("scheduleAmount");
    const scheduleMatrixRaw = formData.get("scheduleMatrix");
    const globalStoreInstructions = formData.get("globalStoreInstructions");

    if (!title || typeof title !== "string" || !title.trim()) {
      return Response.json({ error: "title is required" }, { status: 400 });
    }

    // The edit form always submits scheduleUnit and scheduleMatrix, so empty
    // values are an explicit clear; switching modes wipes the other mode.
    const { unit: scheduleUnitVal, amount: scheduleAmountVal, matrix: scheduleMatrixVal, error: scheduleError } =
      parseScheduleFields(scheduleUnit, scheduleAmountRaw, scheduleMatrixRaw);
    if (scheduleError) return Response.json({ error: scheduleError }, { status: 400 });

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
        scheduleMatrix: scheduleMatrixVal,
        globalStoreInstructions: typeof globalStoreInstructions === "string" && globalStoreInstructions.trim() ? globalStoreInstructions.trim() : undefined,
        taskConfig: Object.keys(taskConfig).length > 0 ? taskConfig : undefined,
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }

    return hxRedirect(`/?scheduled=${id}`);
  });

  addRoute("POST", "/api/scheduled-tasks/:id/approve", async (_req, params) => {
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

  // Webhook trigger lifecycle: enable generates a stable per-task secret,
  // regenerate rotates it (revokes shared URLs), disable clears it. The public
  // URL is built from the connect settings (see connect/public-links.ts).
  for (const webhookAction of ["enable", "regenerate", "disable"] as const) {
    addRoute("POST", `/api/scheduled-tasks/:id/webhook/${webhookAction}`, async (_req, params) => {
      const id = params?.id;
      if (!id) return Response.json({ error: "id required" }, { status: 400 });

      const scheduler = getScheduler();
      try {
        if (webhookAction === "enable") scheduler.enableWebhook(id);
        else if (webhookAction === "regenerate") scheduler.regenerateWebhookKey(id);
        else scheduler.disableWebhook(id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, { status: msg.includes("not found") ? 404 : 400 });
      }

      return hxRedirect(`/?scheduled=${id}`);
    });
  }

  // Webhook debounce: webhooks arriving within this many minutes of the
  // previous webhook are ignored. Floor 1, so the trigger can never fire
  // more than once per minute.
  addRoute("POST", "/api/scheduled-tasks/:id/webhook/debounce", async (req, params) => {
    const id = params?.id;
    if (!id) return Response.json({ error: "id required" }, { status: 400 });

    const formData = await req.formData();
    const raw = formData.get("debounceMinutes");
    const minutes = typeof raw === "string" ? parseInt(raw.trim(), 10) : NaN;
    if (!Number.isInteger(minutes) || minutes < 1) {
      return Response.json({ error: "debounceMinutes must be a whole number of minutes, at least 1" }, { status: 400 });
    }

    try {
      getScheduler().setWebhookDebounce(id, minutes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: msg }, { status: msg.includes("not found") ? 404 : 400 });
    }

    return hxRedirect(`/?scheduled=${id}`);
  });

  addRoute("POST", "/api/scheduled-tasks/:id/clear-schedule", async (_req, params) => {
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
