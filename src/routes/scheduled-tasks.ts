import { addRoute } from "../server";
import { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import type { ScheduleUnit } from "../tasks/scheduled-scheduler";
import type { ManagerDaemon } from "../agents/manager-daemon";
import { isExperimental } from "../config/feature-flags";

const EXPERIMENTAL_REQUIRED = Response.json({ error: "scheduled tasks require --experimental" }, { status: 403 });

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
    if (!scheduleUnit || !["minutes", "hours", "days"].includes(String(scheduleUnit))) {
      return Response.json({ error: "scheduleUnit must be minutes, hours, or days" }, { status: 400 });
    }
    const scheduleAmount = parseInt(String(scheduleAmountRaw), 10);
    if (!Number.isFinite(scheduleAmount) || scheduleAmount < 1) {
      return Response.json({ error: "scheduleAmount must be a positive integer" }, { status: 400 });
    }

    const templateId = formData.get("templateId");
    const taskConfig: Record<string, unknown> = {};
    if (typeof templateId === "string" && templateId.trim()) {
      taskConfig.template_id = templateId.trim();
    }

    const singleInstanceRaw = formData.get("singleInstance");
    const singleInstance = singleInstanceRaw === "1" || singleInstanceRaw === "true" || singleInstanceRaw === "on";

    const scheduler = getScheduler();
    const task = scheduler.createScheduledTask({
      title: String(title).trim(),
      description: typeof description === "string" && description.trim() ? description.trim() : undefined,
      teamId: typeof teamId === "string" && teamId.trim() ? teamId.trim() : undefined,
      workingDirectory: typeof workingDirectory === "string" && workingDirectory.trim() ? workingDirectory.trim() : process.cwd(),
      scheduleUnit: String(scheduleUnit) as ScheduleUnit,
      scheduleAmount,
      taskConfig: Object.keys(taskConfig).length > 0 ? taskConfig : undefined,
      singleInstance,
    });

    const shouldAutoApprove = autoApproveRaw === "1" || autoApproveRaw === "true";
    if (shouldAutoApprove && task.team_id) {
      try {
        scheduler.approveScheduledTask(task.id);
      } catch { /* ignore approval errors for auto-approve */ }
    }

    return new Response(null, {
      status: 303,
      headers: { "HX-Redirect": `/?scheduled=${task.id}`, Location: `/?scheduled=${task.id}` },
    });
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

    const templateId = formData.get("templateId");
    const taskConfig: Record<string, unknown> = {};
    if (typeof templateId === "string" && templateId.trim()) {
      taskConfig.template_id = templateId.trim();
    }

    const singleInstanceRaw = formData.get("singleInstance");
    // For the update form, only treat the field as set when it actually appeared
    // in the form data — otherwise leave the existing value unchanged. We accept
    // any "truthy" string for ON; an explicit "0"/"false" turns it off.
    let singleInstance: boolean | undefined;
    if (singleInstanceRaw !== null) {
      const v = String(singleInstanceRaw);
      singleInstance = v === "1" || v === "true" || v === "on";
    }

    const scheduler = getScheduler();
    try {
      scheduler.updateScheduledTask(id, {
        title: String(title).trim(),
        description: typeof description === "string" && description.trim() ? description.trim() : undefined,
        teamId: typeof teamId === "string" && teamId.trim() ? teamId.trim() : undefined,
        workingDirectory: typeof workingDirectory === "string" && workingDirectory.trim() ? workingDirectory.trim() : undefined,
        scheduleUnit: typeof scheduleUnit === "string" && ["minutes", "hours", "days"].includes(scheduleUnit)
          ? scheduleUnit as ScheduleUnit : undefined,
        scheduleAmount: scheduleAmountRaw ? parseInt(String(scheduleAmountRaw), 10) : undefined,
        taskConfig: Object.keys(taskConfig).length > 0 ? taskConfig : undefined,
        singleInstance,
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }

    return new Response(null, {
      status: 303,
      headers: { "HX-Redirect": `/?scheduled=${id}`, Location: `/?scheduled=${id}` },
    });
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

    return new Response(null, {
      status: 303,
      headers: { "HX-Redirect": `/?scheduled=${id}`, Location: `/?scheduled=${id}` },
    });
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

    return new Response(null, {
      status: 303,
      headers: { "HX-Redirect": `/?scheduled=${id}`, Location: `/?scheduled=${id}` },
    });
  });

  addRoute("POST", "/api/scheduled-tasks/:id/run-now", async (_req, params) => {
    if (!isExperimental()) return EXPERIMENTAL_REQUIRED;
    const id = params?.id;
    if (!id) return Response.json({ error: "id required" }, { status: 400 });

    const scheduler = getScheduler();
    const scheduled = scheduler.getScheduledTask(id);
    if (!scheduled) return Response.json({ error: "not found" }, { status: 404 });
    if (scheduled.status !== "approved") return Response.json({ error: "task must be approved to run" }, { status: 400 });

    const taskScheduler = daemon?.getTaskScheduler();
    if (!taskScheduler) return Response.json({ error: "daemon unavailable" }, { status: 500 });

    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const { getDb } = require("../db/connection");
    const db = getDb();

    const baseDesc = scheduled.description ?? undefined;
    let finalDesc = baseDesc;
    const tplId = (scheduled.task_config as Record<string, unknown>)?.template_id;
    if (typeof tplId === "string" && tplId) {
      const { getTemplateSkipperPrompt } = require("../templates/helpers");
      const sp = getTemplateSkipperPrompt(db, tplId);
      if (sp) finalDesc = baseDesc ? `${baseDesc}\n\n${sp}` : sp;
    }

    const task = taskScheduler.createTask({
      title: `${scheduled.title} (${timestamp})`,
      description: finalDesc,
      teamId: scheduled.team_id ?? undefined,
      workingDirectory: scheduled.working_directory,
      taskConfig: scheduled.task_config as any,
    });
    db.prepare("UPDATE tasks SET source_scheduled_task_id = ? WHERE id = ?").run(scheduled.id, task.id);

    taskScheduler.approveTask(task.id);
    scheduler.recordRun(scheduled.id);

    return new Response(null, {
      status: 303,
      headers: { "HX-Redirect": `/?scheduled=${id}`, Location: `/?scheduled=${id}` },
    });
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

    return new Response(null, {
      status: 303,
      headers: { "HX-Redirect": "/", Location: "/" },
    });
  });
}
