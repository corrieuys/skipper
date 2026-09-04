import { addRoute } from "../server";
import { TaskScheduler } from "../tasks/scheduler";
import type { TaskMode, TaskConfig } from "../tasks/scheduler";
import { getDb } from "../db/connection";
import { setBoolSetting, SETTING_PARALLEL_TASKS, SETTING_SKIPPER_CONNECT_ENABLED } from "../config/app-settings";
import { getConnectClient, type ConnectionStatus } from "../connect/client";
import { finalizeActiveInstancesForTask } from "../agents/instance-status";
import type { TaskNoteData } from "../html/components";
import type { ManagerDaemon } from "../agents/manager-daemon";
import { ArtifactManager, artifactToJson } from "../orchestrator/artifact-manager";
import { PRIMARY_ARTIFACT_LIST_VARIANT, artifactListFragment } from "../html/fragments/artifact-list.fragment";
import { eventBus } from "../events/bus";
import { htmlResponse, parseRequestBody, hxRedirect } from "./utils";
import { noteItemFragment } from "../html/dashboardNotesFragment";
import { getRealtimeTeamId } from "../config/teams";
import { parsePhaseOverridesFromForm } from "./phase-overrides";
import { parseScheduleFields } from "./scheduled-tasks";
import { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import { isTaskTitleGeneratorConfigured } from "../config/model-settings";
import { ensureTaskTitle } from "../tasks/title-generator";

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function connectStatusFragment(status: ConnectionStatus): string {
  return `<span class="sk-connect__status" data-status="${status}" hx-get="/api/settings/skipper-connect/status" hx-trigger="every 5s" hx-swap="outerHTML"></span>`;
}

function findDefaultTaskTeamId(db: ReturnType<typeof getDb>, mode?: TaskMode): string | undefined {
  // Conversational tasks default to the Real Time team — the realtime session
  // manager spawns from that team's phases. A workflow-team fallback would queue
  // it through Skipper instead of the input pipeline.
  if (mode === "conversational") {
    const rtId = getRealtimeTeamId();
    if (rtId) return rtId;
  }

  const software = db
    .prepare("SELECT id FROM teams WHERE lower(trim(name)) = 'software' ORDER BY name LIMIT 1")
    .get() as { id: string } | null;
  if (software?.id) return software.id;

  const fallback = db
    .prepare("SELECT id FROM teams ORDER BY name LIMIT 1")
    .get() as { id: string } | null;
  return fallback?.id;
}

function taskCreationPageResponse(_errorMessage?: string, _daemonStatus?: { state: "running" | "pausing" | "paused" | "stopped"; uptime: number }): Response {
  return new Response(null, { status: 302, headers: { Location: "/tasks/new" } });
}

function taskDetailResponse(id: string, _daemonStatus?: { state: "running" | "pausing" | "paused" | "stopped"; uptime: number }): Response {
  return hxRedirect(`/?task=${id}`);
}

export function killRunningRuntimesForTask(taskId: string, daemon?: Pick<ManagerDaemon, "getAgentManager">): void {
  if (!daemon) return;
  const agentManager = daemon.getAgentManager();
  const db = getDb();
  const killedPids = new Set<number>();

  // 1. Kill in-memory tracked agents (SIGTERM for graceful exit handler)
  const runningAgents = Array.from(agentManager.getRunningAgents().values())
    .filter((runtime) => runtime.taskId === taskId);

  for (const runtime of runningAgents) {
    try {
      if (runtime.process.pid) killedPids.add(runtime.process.pid);
      agentManager.killAgent(runtime.id);
    } catch {
      // Best-effort kill during cancellation.
    }
  }

  // 2. Kill DB-tracked instance PIDs not in memory (orphaned processes)
  const dbInstances = db.prepare(
    "SELECT process_pid FROM agent_instances WHERE task_id = ? AND process_pid IS NOT NULL",
  ).all(taskId) as Array<{ process_pid: number }>;

  for (const inst of dbInstances) {
    if (!killedPids.has(inst.process_pid)) {
      killedPids.add(inst.process_pid);
    }
  }

  // 3. Kill entrypoint agents assigned to this task
  const agentPids = db.prepare(
    "SELECT process_pid FROM agents WHERE current_task_id = ? AND process_pid IS NOT NULL",
  ).all(taskId) as Array<{ process_pid: number }>;

  for (const agent of agentPids) {
    if (!killedPids.has(agent.process_pid)) {
      killedPids.add(agent.process_pid);
    }
  }

  // 4. Force kill all collected process trees with SIGKILL. Agents are spawned
  // detached (pid===pgid), so the negative pgid kills the agent AND every
  // subprocess it spawned. Fall back to the positive pid for legacy processes.
  for (const pid of killedPids) {
    try { process.kill(-pid, 9); }
    catch { try { process.kill(pid, 9); } catch { /* already dead or no permission */ } }
  }
}

export function registerTaskRoutes(daemon?: Pick<ManagerDaemon, "getAgentManager" | "getRealtimeSessionManager" | "getPhaseManager" | "getStatus" | "pauseTaskAgents" | "resumeTaskAgents" | "inputTask" | "getArtifactManager">): void {
  const scheduler = new TaskScheduler();

  addRoute("POST", "/api/settings/parallel-tasks", async (req) => {
    const body = await parseRequestBody<Record<string, string>>(req);
    const enabled = body.enabled === "on" || body.enabled === "true" || body.enabled === "1";
    setBoolSetting(getDb(), SETTING_PARALLEL_TASKS, enabled);
    return Response.json({ parallel: enabled });
  });

  addRoute("POST", "/api/settings/skipper-connect", async (req) => {
    const body = await parseRequestBody<Record<string, string>>(req);
    const enabled = body.enabled === "on" || body.enabled === "true" || body.enabled === "1";
    setBoolSetting(getDb(), SETTING_SKIPPER_CONNECT_ENABLED, enabled);
    const client = getConnectClient();
    if (client) {
      if (enabled) {
        client.start();
      } else {
        client.stop();
      }
    }
    return Response.json({ skipperConnect: enabled });
  });

  addRoute("GET", "/api/settings/skipper-connect/status", () => {
    const status = getConnectClient()?.getConnectionStatus() ?? "disabled";
    return htmlResponse(connectStatusFragment(status));
  });

  addRoute("POST", "/api/tasks", async (req) => {
    const formData = await req.formData();
    const title = formData.get("title");
    const description = formData.get("description");
    const teamId = formData.get("teamId");
    const workingDirectoryRaw = formData.get("workingDirectory");
    const modeRaw = formData.get("mode");
    const taskTypeRaw = formData.get("taskType");
    const taskConfigRaw = formData.get("taskConfig");
    const autoApproveRaw = formData.get("autoApprove");
    const shouldAutoApprove = autoApproveRaw === "1" || autoApproveRaw === "true";

    // Title is optional ONLY when a title-generator provider is configured; the
    // daemon then generates one from the description. Without a generator the
    // title stays required.
    const titleStr = typeof title === "string" ? title.trim() : "";
    if (!titleStr && !isTaskTitleGeneratorConfigured(getDb())) {
      return taskCreationPageResponse("title is required", daemon?.getStatus());
    }

    // Recurring tasks are created via the merged task form (Task Type = Recurring).
    // They live in scheduled_tasks, not tasks, so dispatch to the scheduler here.
    if (taskTypeRaw === "recurring") {
      const { unit: scheduleUnitVal, amount: scheduleAmountVal, matrix: scheduleMatrixVal, error: scheduleError } =
        parseScheduleFields(formData.get("scheduleUnit"), formData.get("scheduleAmount"), formData.get("scheduleMatrix"));
      if (scheduleError) return Response.json({ error: scheduleError }, { status: 400 });

      const resolvedTeamId = typeof teamId === "string" && teamId.trim() ? teamId.trim() : undefined;
      const recurringConfig: Record<string, unknown> = {};
      const { overrides: recurringOverrides } = parsePhaseOverridesFromForm(formData, resolvedTeamId);
      if (Object.keys(recurringOverrides).length > 0) recurringConfig.phase_overrides = recurringOverrides;

      const globalStoreInstructionsRaw = formData.get("globalStoreInstructions");
      const scheduledScheduler = new ScheduledTaskScheduler();
      const scheduled = scheduledScheduler.createScheduledTask({
        title: titleStr,
        description: typeof description === "string" && description.trim() ? description.trim() : undefined,
        teamId: resolvedTeamId,
        workingDirectory: typeof workingDirectoryRaw === "string" && workingDirectoryRaw.trim() ? workingDirectoryRaw.trim() : process.cwd(),
        scheduleUnit: scheduleUnitVal,
        scheduleAmount: scheduleAmountVal,
        scheduleMatrix: scheduleMatrixVal,
        globalStoreInstructions: typeof globalStoreInstructionsRaw === "string" && globalStoreInstructionsRaw.trim() ? globalStoreInstructionsRaw.trim() : undefined,
        taskConfig: Object.keys(recurringConfig).length > 0 ? recurringConfig : undefined,
      });

      if (shouldAutoApprove && scheduled.team_id) {
        try { scheduledScheduler.approveScheduledTask(scheduled.id); } catch { /* ignore */ }
      }

      return hxRedirect(`/?scheduled=${scheduled.id}`);
    }

    const workingDirectory = typeof workingDirectoryRaw === "string" && workingDirectoryRaw.trim()
      ? workingDirectoryRaw.trim()
      : "";
    // working directory is optional; Skipper will discover it from the task
    // description if blank (see prompts/skipper.md, "WORKING DIRECTORY" section).

    let mode: TaskMode | undefined;
    if (typeof modeRaw === "string" && (modeRaw === "workflow" || modeRaw === "conversational")) {
      mode = modeRaw;
    } else if (typeof taskTypeRaw === "string") {
      // Legacy form field: taskType real_time/standard maps onto mode.
      if (taskTypeRaw === "real_time") mode = "conversational";
      else if (taskTypeRaw === "standard") mode = "workflow";
    }

    let taskConfig: TaskConfig | undefined;
    if (typeof taskConfigRaw === "string" && taskConfigRaw.trim()) {
      try {
        taskConfig = JSON.parse(taskConfigRaw);
      } catch { /* ignore */ }
    }

    try {
      const db = getDb();
      let resolvedTeamId = typeof teamId === "string" && teamId.trim() ? teamId.trim() : findDefaultTaskTeamId(db, mode);

      const finalDescription = typeof description === "string" && description.trim() ? description.trim() : undefined;

      let created = scheduler.createTask({
        title: titleStr,
        description: finalDescription,
        teamId: resolvedTeamId,
        workingDirectory,
        mode,
        taskConfig,
      });

      // Blank title: generate one from the description asynchronously so the
      // create returns immediately; the title lands via updateTitle's event.
      if (!titleStr) {
        void ensureTaskTitle(db, scheduler, created.id);
      }

      // Collect per-task phase overrides (prompt / review gate) from
      // the task-create form fields. See src/routes/phase-overrides.ts.
      const { overrides: phaseOverrides } = parsePhaseOverridesFromForm(formData, resolvedTeamId);

      if (Object.keys(phaseOverrides).length > 0) {
        const currentConfig = created.task_config as unknown as Record<string, unknown>;
        const updatedConfig: Record<string, unknown> = { ...currentConfig, phase_overrides: phaseOverrides };
        db.prepare("UPDATE tasks SET task_config = ?, updated_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(updatedConfig), created.id);
      }

      if (shouldAutoApprove) {
        // Conversational tasks auto-start + open their session via the daemon's
        // task:state_changed handler (see manager-daemon.ts).
        created = scheduler.approveTask(created.id);
      }

      if (req.headers.get("HX-Request")) {
        const redirectTo = shouldAutoApprove
          ? (created.mode === "conversational" ? `/?task=${created.id}` : "/")
          : (created.mode === "conversational" ? `/?task=${created.id}` : `/tasks/${created.id}`);
        return hxRedirect(redirectTo);
      }
      return new Response(null, { status: 302, headers: { Location: "/" } });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return taskCreationPageResponse(message, daemon?.getStatus());
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
    const body = await parseRequestBody<Record<string, string>>(req);

    if (!body.title || !body.title.trim()) {
      return Response.json(
        { error: "title is required" },
        { status: 400 },
      );
    }

    try {
      let mode: TaskMode | undefined;
      if (body.mode === "workflow" || body.mode === "conversational") {
        mode = body.mode;
      } else if (body.taskType === "real_time") {
        mode = "conversational";
      } else if (body.taskType === "standard") {
        mode = "workflow";
      }
      let taskConfig: TaskConfig | undefined;
      if (body.taskConfig) {
        try {
          taskConfig = typeof body.taskConfig === "string" ? JSON.parse(body.taskConfig) : body.taskConfig;
        } catch { /* ignore */ }
      }
      const updated = scheduler.updateTask(params.id, {
        title: body.title,
        description: body.description,
        teamId: body.teamId,
        workingDirectory: body.workingDirectory,
        mode,
        taskConfig,
      });

      if (req.headers.get("HX-Request")) {
        return taskDetailResponse(updated.id, daemon?.getStatus());
      }

      return Response.json(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/update", async (req, params) => {
    try {
      const db = getDb();
      const task = scheduler.getTask(params.id);
      if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
      // Allow editing tasks in any status (draft, active, settled)

      const formData = await req.formData();
      const title = formData.get("title");
      const description = formData.get("description");
      const teamId = formData.get("teamId");
      const workingDirectory = formData.get("workingDirectory");

      const updates: string[] = [];
      const values: any[] = [];

      if (typeof title === "string" && title.trim()) {
        updates.push("title = ?");
        values.push(title.trim());
      }
      if (typeof description === "string") {
        updates.push("description = ?");
        values.push(description.trim() || null);
      }
      if (typeof teamId === "string") {
        updates.push("team_id = ?");
        values.push(teamId.trim() || null);
      }
      if (typeof workingDirectory === "string") {
        updates.push("working_directory = ?");
        values.push(workingDirectory.trim());
      }

      // Collect per-task phase overrides (prompt / review gate).
      // See src/routes/phase-overrides.ts.
      const resolvedTeamId = typeof teamId === "string" ? teamId.trim() : task.team_id;
      const { overrides: phaseOverrides, submitted: phaseOverridesSubmitted } =
        parsePhaseOverridesFromForm(formData, resolvedTeamId ?? undefined);

      // If phase overrides were part of the submission, rewrite task_config
      if (phaseOverridesSubmitted) {
        const row = db.prepare("SELECT task_config FROM tasks WHERE id = ?").get(params.id) as { task_config: string } | null;
        let currentConfig: Record<string, unknown> = {};
        try { currentConfig = row?.task_config ? JSON.parse(row.task_config) : {}; } catch { /* ignore */ }
        const updatedConfig: Record<string, unknown> = { ...currentConfig };
        if (Object.keys(phaseOverrides).length > 0) updatedConfig.phase_overrides = phaseOverrides;
        else delete updatedConfig.phase_overrides;
        updates.push("task_config = ?");
        values.push(JSON.stringify(updatedConfig));
      }

      if (updates.length > 0) {
        updates.push("updated_at = ?");
        values.push(new Date().toISOString());
        values.push(params.id);
        db.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).run(...values);
      }

      const shouldApprove = formData.get("approve") === "1";
      if (shouldApprove && task.status === "draft") {
        // Conversational auto-start happens in the daemon's state-changed handler.
        scheduler.approveTask(params.id);
      }

      if (req.headers.get("HX-Request")) {
        return hxRedirect(`/?task=${params.id}`);
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/approve", (_req, params) => {
    try {
      // Real-time auto-start happens in the daemon's state-changed handler.
      scheduler.approveTask(params.id);

      if (_req.headers.get("HX-Request")) {
        return hxRedirect(`/?task=${params.id}`);
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      if (_req.headers.get("HX-Request")) {
        return Response.json({ error: message }, { status: 400 });
      }
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/unapprove", (_req, params) => {
    try {
      scheduler.unapproveTask(params.id);
      if (_req.headers.get("HX-Request")) {
        return hxRedirect(`/?task=${params.id}`);
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      if (_req.headers.get("HX-Request")) {
        return Response.json({ error: message }, { status: 400 });
      }
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/complete", (_req, params) => {
    try {
      if (daemon) {
        const rtMgr = daemon.getRealtimeSessionManager();
        if (rtMgr.isSessionActive(params.id)) {
          rtMgr.closeSession(params.id);
        }
      }
      killRunningRuntimesForTask(params.id, daemon);
      scheduler.settleTask(params.id, {});
      if (_req.headers.get("HX-Request")) {
        return hxRedirect(`/?task=${params.id}`);
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/cancel", (_req, params) => {
    try {
      // Close any active realtime session without finalization
      if (daemon) {
        const rtMgr = daemon.getRealtimeSessionManager();
        if (rtMgr.isSessionActive(params.id)) {
          rtMgr.closeSession(params.id);
        }
      }
      killRunningRuntimesForTask(params.id, daemon);
      scheduler.settleTask(params.id, { error: "Cancelled by user" });
      if (_req.headers.get("HX-Request")) {
        return hxRedirect(`/?task=${params.id}`);
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/autopilot", async (req, params) => {
    try {
      const task = scheduler.getTask(params.id);
      if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
      const body = await parseRequestBody(req);
      const raw = body.on ?? body.autopilot;
      const on = raw === true || raw === "true" || raw === "on" || raw === "1";
      const updated = scheduler.setAutopilot(params.id, on);
      if (req.headers.get("HX-Request")) {
        return hxRedirect(`/?task=${params.id}`);
      }
      return Response.json({ ok: true, autopilot: updated.autopilot });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/pause", async (_req, params) => {
    try {
      const task = scheduler.getTask(params.id);
      if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
      // Flip the paused flag first so recovery/health/queue loops immediately
      // stop treating it as a live task, THEN stop the agents + their trees.
      scheduler.pauseTask(params.id);
      if (daemon) await daemon.pauseTaskAgents(params.id);
      if (_req.headers.get("HX-Request")) {
        return hxRedirect(`/?task=${params.id}`);
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/resume-from-pause", async (_req, params) => {
    try {
      const task = scheduler.getTask(params.id);
      if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
      if (!task.paused) {
        return Response.json({ error: "Task is not paused" }, { status: 400 });
      }
      // Respawn the agents first (reading snapshots from orchestration_state),
      // THEN clear the paused flag so the task is only live once agents are back.
      if (daemon) await daemon.resumeTaskAgents(params.id);
      scheduler.resumeFromPause(params.id);
      if (_req.headers.get("HX-Request")) {
        return hxRedirect(`/?task=${params.id}`);
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/retry", () => {
    return Response.json(
      { error: "Retry was removed. Send new input via POST /api/tasks/:id/input instead." },
      { status: 410 },
    );
  });

  addRoute("POST", "/api/tasks/:id/resume", async (_req, params) => {
    try {
      const task = scheduler.getTask(params.id);
      if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
      if (task.paused) {
        // Respawn the agents first, THEN clear the paused flag (same ordering
        // as /resume-from-pause).
        if (daemon) await daemon.resumeTaskAgents(params.id);
        scheduler.resumeFromPause(params.id);
      } else if (task.status === "settled") {
        scheduler.reviveTask(params.id);
        scheduler.requestWake(params.id);
      } else {
        return Response.json({ error: "Task is not paused or settled" }, { status: 409 });
      }
      if (_req.headers.get("HX-Request")) {
        return hxRedirect(`/?task=${params.id}`);
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  // Unified input entry point: draft appends, settled revives + wakes,
  // active queues or accumulates. Replaces the old iterate endpoint.
  const handleInput = async (req: Request, params: { id: string }): Promise<Response> => {
    try {
      if (!daemon) return Response.json({ error: "Daemon not available" }, { status: 503 });
      const body = await parseRequestBody<Record<string, string>>(req);
      const text = body.text || body.additionalInput || body.additional_input;
      if (!text || !text.trim()) {
        return Response.json({ error: "text is required" }, { status: 400 });
      }
      const result = await daemon.inputTask(params.id, text, "web");
      // No HX redirect here: the composer posts with hx-swap="none" and the
      // timeline updates over WS. A full page reload would tear down an active
      // audio recording mid-session. The one case that changes the chrome
      // (input reviving a settled task) already triggers a workspace refresh
      // through the task:state_changed status-transition push.
      return Response.json({ ok: true, delivered: result.delivered });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  };

  addRoute("POST", "/api/tasks/:id/input", handleInput);
  // Legacy shim: iterate is now just input.
  addRoute("POST", "/api/tasks/:id/iterate", handleInput);

  const handleSettle = (_req: Request, params: { id: string }): Response => {
    try {
      if (daemon) {
        const rtMgr = daemon.getRealtimeSessionManager();
        if (rtMgr.isSessionActive(params.id)) {
          rtMgr.closeSession(params.id);
        }
      }
      killRunningRuntimesForTask(params.id, daemon);
      scheduler.settleTask(params.id, {});
      if (_req.headers.get("HX-Request")) {
        return hxRedirect(`/?task=${params.id}`);
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  };
  addRoute("POST", "/api/tasks/:id/settle", handleSettle);
  // Legacy shim for old clients; settle replaces archive.
  addRoute("POST", "/api/tasks/:id/archive", handleSettle);

  const handleRevive = (_req: Request, params: { id: string }): Response => {
    try {
      scheduler.reviveTask(params.id);
      if (_req.headers.get("HX-Request")) {
        return hxRedirect(`/?task=${params.id}`);
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  };
  addRoute("POST", "/api/tasks/:id/revive", handleRevive);
  // Legacy shim for old clients; revive replaces unarchive.
  addRoute("POST", "/api/tasks/:id/unarchive", handleRevive);

  const handleDelete = (req: Request, params: { id: string }): Response => {
    try {
      const task = scheduler.getTask(params.id);
      if (task && task.status === "active") {
        killRunningRuntimesForTask(params.id, daemon);
        try { finalizeActiveInstancesForTask(getDb(), params.id, "failed"); } catch { /* best-effort */ }
      }

      scheduler.deleteTask(params.id);

      // List-page row deletes set X-Skip-Redirect so HTMX swaps the row in
      // place. Other surfaces (detail page) still get the redirect-to-home.
      const skipRedirect = req.headers.get("X-Skip-Redirect") === "1";
      if (req.headers.get("HX-Request")) {
        if (skipRedirect) return new Response("", { status: 200 });
        return hxRedirect("/");
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  };

  addRoute("POST", "/api/tasks/:id/delete", handleDelete);
  addRoute("DELETE", "/api/tasks/:id", handleDelete);

  addRoute("POST", "/api/tasks/:id/approve-phase", async (req, params) => {
    try {
      if (!daemon) return Response.json({ error: "Daemon not available" }, { status: 503 });
      let message: string | undefined;
      try {
        const contentType = req.headers.get("content-type") ?? "";
        if (contentType.includes("json")) {
          const body = await req.json() as Record<string, unknown>;
          if (typeof body.message === "string" && body.message.trim()) message = body.message.trim();
        } else if (contentType) {
          const form = await req.formData();
          const msg = form.get("message");
          if (typeof msg === "string" && msg.trim()) message = msg.trim();
        }
      } catch { /* no body */ }
      await daemon.getPhaseManager().approveReview(params.id, message);
      if (req.headers.get("HX-Request")) {
        return taskDetailResponse(params.id, daemon.getStatus());
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/reject-phase", async (req, params) => {
    try {
      if (!daemon) return Response.json({ error: "Daemon not available" }, { status: 503 });
      let message: string | undefined;
      try {
        const contentType = req.headers.get("content-type") ?? "";
        if (contentType.includes("json")) {
          const body = await req.json() as Record<string, unknown>;
          if (typeof body.message === "string" && body.message.trim()) message = body.message.trim();
        } else {
          const form = await req.formData();
          const msg = form.get("message");
          if (typeof msg === "string" && msg.trim()) message = msg.trim();
        }
      } catch { /* use default */ }
      await daemon.getPhaseManager().rejectReview(params.id, message);
      if (req.headers.get("HX-Request")) {
        return taskDetailResponse(params.id, daemon.getStatus());
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/clear-stale", (_req, params) => {
    try {
      const db = getDb();
      db.prepare("UPDATE agents SET current_task_id = NULL, process_pid = NULL WHERE current_task_id = ?").run(params.id);
      finalizeActiveInstancesForTask(db, params.id, "failed");

      if (_req.headers.get("HX-Request")) {
        return taskDetailResponse(params.id, daemon?.getStatus());
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  // --- Manual note injection ---

  addRoute("POST", "/api/tasks/:id/notes", async (req, params) => {
    const body = await parseRequestBody<{ content?: string }>(req);
    if (!body.content || !body.content.trim()) {
      return Response.json({ error: "content is required" }, { status: 400 });
    }

    const db = getDb();
    const task = scheduler.getTask(params.id);
    if (!task) {
      return Response.json({ error: "Task not found" }, { status: 404 });
    }

    // Find a valid agent_id: use task entrypoint agent to satisfy FK constraints in monolith mode.
    // In split-mode runtime DB there is no FK on agent_id, so 'user' would also work.
    let agentId = "user";
    try {
      if (task.team_id) {
        const teamRow = db
          .prepare("SELECT entrypoint_agent_id FROM teams WHERE id = ?")
          .get(task.team_id) as { entrypoint_agent_id: string | null } | null;
        if (teamRow?.entrypoint_agent_id) agentId = teamRow.entrypoint_agent_id;
      }
    } catch { /* ignore — fallback to 'user' */ }

    const noteId = crypto.randomUUID();
    const content = body.content.trim();

    try {
      db.prepare(
        "INSERT INTO task_notes (id, task_id, agent_id, content, source) VALUES (?, ?, ?, ?, 'user')",
      ).run(noteId, params.id, agentId, content);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 500 });
    }

    const note = db
      .prepare("SELECT n.*, a.name AS agent_name FROM task_notes n LEFT JOIN agents a ON a.id = n.agent_id WHERE n.id = ?")
      .get(noteId) as import("../html/components").TaskNoteData | null;

    eventBus.emit("task:note_added", {
      noteId,
      taskId: params.id,
      agentId,
      content,
    });

    // Return the rendered note row so htmx forms (hx-swap="afterbegin" on
    // #dashboard-notes-list) can drop it straight in without re-fetching
    // the full list. The other caller (notes.panel.ts) uses hx-swap="none"
    // and ignores the body, so HTML here is harmless.
    if (note) {
      return htmlResponse(noteItemFragment(note), 201);
    }
    return Response.json({ error: "note not found after insert" }, { status: 500 });
  });

  // Soft-delete / restore a note. Deleted notes stay visible in the UI (rendered
  // with a "deleted" annotation) but are excluded from agent context injection.
  // Both return the re-rendered single row for htmx outerHTML swap.
  for (const action of ["delete", "restore"] as const) {
    addRoute("POST", `/api/tasks/:id/notes/:noteId/${action}`, (_req, params) => {
      const db = getDb();
      const deletedAt = action === "delete" ? "strftime('%Y-%m-%d %H:%M:%f','now')" : "NULL";
      const result = db
        .prepare(`UPDATE task_notes SET deleted_at = ${deletedAt} WHERE id = ? AND task_id = ?`)
        .run(params.noteId, params.id);
      if (result.changes === 0) {
        return Response.json({ error: "note not found" }, { status: 404 });
      }
      const note = db
        .prepare("SELECT n.*, a.name AS agent_name FROM task_notes n LEFT JOIN agents a ON a.id = n.agent_id WHERE n.id = ?")
        .get(params.noteId) as TaskNoteData | null;
      if (!note) return Response.json({ error: "note not found" }, { status: 404 });
      return htmlResponse(noteItemFragment(note));
    });
  }

  // --- Artifact REST API ---

  const artifactManager = daemon?.getArtifactManager?.() ?? new ArtifactManager();

  // Operator file upload (pictures and any file). Multipart: `file` (one or
  // more, required) + optional `description`. Creates a kind 'upload' file
  // artifact per file and puts it on the task's input timeline with the same
  // wake semantics as typed text. htmx callers get the refreshed rail list;
  // the WS `artifact:created` push updates every other client.
  addRoute("POST", "/api/tasks/:id/artifacts/upload", async (req, params) => {
    const isHx = req.headers.get("HX-Request") === "true";
    const fail = (message: string, status = 400) =>
      isHx ? htmlResponse(`<p class="tc-art-upload__error">${escapeHtmlText(message)}</p>`, status) : Response.json({ error: message }, { status });
    const task = scheduler.getTask(params.id);
    if (!task) return fail("Task not found", 404);
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail("Expected multipart/form-data with a `file` field");
    }
    const files = form.getAll("file").filter((f): f is File => typeof f !== "string" && f.size > 0);
    if (files.length === 0) return fail("file is required");
    const description = String(form.get("description") ?? "").trim() || undefined;

    const created: Record<string, unknown>[] = [];
    for (const file of files) {
      let artifact;
      try {
        artifact = artifactManager.createFileArtifact({
          taskId: params.id,
          name: file.name || "upload",
          kind: "upload",
          mime: file.type || null,
          bytes: new Uint8Array(await file.arrayBuffer()),
          description,
          source: "operator",
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : "Upload failed");
      }
      const rt = daemon?.getRealtimeSessionManager();
      let delivered: string | undefined;
      if (rt) {
        try {
          delivered = rt.ingestArtifactUpload(params.id, artifact, { caption: description, source: "operator" }).delivered;
        } catch (err) {
          return fail(err instanceof Error ? err.message : "Could not attach the upload to the task");
        }
      }
      created.push({ ...artifactToJson(artifact), delivered });
    }

    if (isHx) {
      return htmlResponse(artifactListFragment(getDb(), params.id, PRIMARY_ARTIFACT_LIST_VARIANT));
    }
    return Response.json(created.length === 1 ? created[0] : { artifacts: created }, { status: 201 });
  });

  // File artifact bytes. Immutable per id, so clients may cache forever.
  addRoute("GET", "/api/artifacts/:id/file", (_req, params) => {
    const file = artifactManager.readArtifactBytes(params.id);
    if (!file) return Response.json({ error: "Artifact file not found" }, { status: 404 });
    const { artifact, bytes } = file;
    const mime = artifact.mime ?? "application/octet-stream";
    const disposition = mime.startsWith("image/")
      ? "inline"
      : `attachment; filename="${artifact.name.replace(/["\\]/g, "_")}"`;
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Disposition": disposition,
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  addRoute("GET", "/api/artifacts/:id/meta", (_req, params) => {
    const artifact = artifactManager.getArtifactById(params.id);
    if (!artifact) return Response.json({ error: "Artifact not found" }, { status: 404 });
    return Response.json(artifactToJson(artifact));
  });

  addRoute("GET", "/api/tasks/:id/artifacts", (req, params) => {
    const url = new URL(req.url);
    const kind = url.searchParams.get("kind") ?? undefined;
    const name = url.searchParams.get("name") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;

    const artifacts = artifactManager.listArtifacts({
      taskId: params.id,
      kind,
      namePrefix: name,
      limit,
    });
    return Response.json({ artifacts });
  });

  addRoute("GET", "/api/tasks/:id/artifacts/:name", (req, params) => {
    const url = new URL(req.url);
    const versionParam = url.searchParams.get("version") ?? "latest";
    const version: "latest" | number = versionParam === "latest"
      ? "latest"
      : parseInt(versionParam, 10);

    const artifact = artifactManager.getArtifact(params.id, params.name, version);
    if (!artifact) {
      return Response.json({ error: "Artifact not found" }, { status: 404 });
    }
    return Response.json(artifactToJson(artifact));
  });

  addRoute("POST", "/api/tasks/:id/artifacts/:name", async (req, params) => {
    const body = await req.json() as { body?: string; kind?: string; description?: string };
    if (!body.body) {
      return Response.json({ error: "body is required" }, { status: 400 });
    }
    const existing = artifactManager.getArtifact(params.id, params.name, "latest");
    const kind = (body.kind ?? existing?.kind ?? "other") as import("../orchestrator/artifact-manager").ArtifactKind;
    try {
      const artifact = artifactManager.createArtifact({
        taskId: params.id,
        name: params.name,
        kind,
        description: body.description ?? existing?.description ?? undefined,
        body: body.body,
      });
      return Response.json(artifact);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("GET", "/api/tasks/:id/artifacts/:name/versions", (_req, params) => {
    const versions = artifactManager.listVersions(params.id, params.name);
    return Response.json({ versions });
  });

  // --- Real-time session endpoints ---

  addRoute("POST", "/api/tasks/:id/realtime/session/start", (_req, params) => {
    const task = scheduler.getTask(params.id);
    if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
    if (task.status !== "active") {
      return Response.json({ error: "Task must be active to start a session" }, { status: 400 });
    }

    if (daemon) {
      const mgr = daemon.getRealtimeSessionManager();
      try {
        const result = mgr.startSession(params.id);
        return Response.json(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Internal error";
        return Response.json({ error: message }, { status: 409 });
      }
    }

    return Response.json({ error: "Daemon not available" }, { status: 503 });
  });

  addRoute("POST", "/api/tasks/:id/realtime/session/stop", async (_req, params) => {
    const task = scheduler.getTask(params.id);
    if (!task) return Response.json({ error: "Task not found" }, { status: 404 });

    if (daemon) {
      const mgr = daemon.getRealtimeSessionManager();
      try {
        const result = await mgr.stopSession(params.id);
        return Response.json(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Internal error";
        return Response.json({ error: message }, { status: 400 });
      }
    }

    return Response.json({ error: "Daemon not available" }, { status: 503 });
  });

  addRoute("GET", "/api/tasks/:id/realtime/stream", (req, params) => {
    const task = scheduler.getTask(params.id);
    if (!task) return Response.json({ error: "Task not found" }, { status: 404 });

    // SSE endpoint: emit events for transcript/summary windows and triggers
    const encoder = new TextEncoder();
    const sessionActive = daemon?.getRealtimeSessionManager().isSessionActive(params.id) ?? false;

    const stream = new ReadableStream({
      start(controller) {
        const sendEvent = (eventName: string, data: unknown) => {
          const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
          try {
            controller.enqueue(encoder.encode(payload));
          } catch { /* stream closed */ }
        };

        const windowHandler = (event: { taskId: string; windowId: string; artifactName: string; version: number; windowStartAt: string; windowEndAt: string }) => {
          if (event.taskId === params.id) {
            sendEvent("transcript.window_ready", {
              window_id: event.windowId,
              artifact_name: event.artifactName,
              version: event.version,
              window_start_at: event.windowStartAt,
              window_end_at: event.windowEndAt,
            });
          }
        };

        const triggerHandler = (event: { taskId: string; windowId: string; confidence: number; decision: string; delegationId?: string }) => {
          if (event.taskId === params.id) {
            sendEvent("trigger.fired", {
              window_id: event.windowId,
              confidence: event.confidence,
              decision: event.decision,
              delegation_id: event.delegationId,
            });
          }
        };

        const sessionHandler = (event: { taskId: string; state: string }) => {
          if (event.taskId === params.id) {
            sendEvent("session.state", { state: event.state });
          }
        };

        const timelineHandler = (event: { taskId: string; entryId: string; entryType: string }) => {
          if (event.taskId === params.id) {
            sendEvent("timeline.updated", {
              entry_id: event.entryId,
              entry_type: event.entryType,
            });
          }
        };

        const audioLockHandler = (event: { taskId: string; locked: boolean; owner?: string; ownerLabel?: string }) => {
          if (event.taskId === params.id) {
            sendEvent("audio.lock", { locked: event.locked, owner: event.owner, owner_label: event.ownerLabel });
          }
        };

        eventBus.on("realtime:window_ready", windowHandler);
        eventBus.on("realtime:trigger_fired", triggerHandler);
        eventBus.on("realtime:session_state", sessionHandler);
        eventBus.on("realtime:timeline_updated", timelineHandler);
        eventBus.on("realtime:audio_lock", audioLockHandler);

        // Send initial state
        sendEvent("session.state", { state: sessionActive ? "active" : "stopped" });

        // Cleanup on close
        req.signal.addEventListener("abort", () => {
          eventBus.off("realtime:window_ready", windowHandler);
          eventBus.off("realtime:trigger_fired", triggerHandler);
          eventBus.off("realtime:session_state", sessionHandler);
          eventBus.off("realtime:timeline_updated", timelineHandler);
          eventBus.off("realtime:audio_lock", audioLockHandler);
          try { controller.close(); } catch { /* already closed */ }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });
}
