import { addRoute } from "../server";
import { TaskScheduler } from "../tasks/scheduler";
import type { TaskType, RealtimeTaskConfig } from "../tasks/scheduler";
import { getTemplateSkipperPrompt } from "../templates/helpers";
import { getDb } from "../db/connection";
import { setBoolSetting, SETTING_PARALLEL_TASKS } from "../config/app-settings";
import { buildSkillsPromptAddition as _buildSkillsPromptAddition } from "../config-readers/skills";
import { getPollIntervalSeconds } from "./pages";
import type {
  DelegationData,
  TaskData,
  TaskNoteData,
  TeamOptionData,
  TaskHealthSummary,
} from "../html/components";
import type { ManagerDaemon } from "../agents/manager-daemon";
import { ArtifactManager } from "../orchestrator/artifact-manager";
import { eventBus } from "../events/bus";
import { htmlResponse, parseRequestBody } from "./utils";
import { noteItemFragment } from "../html/dashboardNotesFragment";
import { getRealtimeTeamId } from "../config/teams";

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
     WHERE t.task_type != 'real_time'
     ORDER BY
       CASE t.status WHEN 'approved' THEN 0 WHEN 'draft' THEN 1 WHEN 'running' THEN 2 ELSE 3 END,
       COALESCE(t.updated_at, t.created_at) DESC,
       t.rowid DESC`,
  ).all() as Record<string, unknown>[];
  return rows.map(parseTaskRow);
}

function listTeamsForUi(): TeamOptionData[] {
  const db = getDb();
  return db.prepare("SELECT id, name FROM teams ORDER BY name").all() as TeamOptionData[];
}

function findDefaultTaskTeamId(db: ReturnType<typeof getDb>, taskType?: TaskType): string | undefined {
  // Real-time tasks must default to the Real Time team — the realtime session
  // manager spawns from that team's phases. Standard-team fallback would queue
  // it through Skipper instead of the realtime pipeline.
  if (taskType === "real_time") {
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

export function buildSkillsPromptAddition(taskId: string, agentProvider: string): string {
  return _buildSkillsPromptAddition(taskId, agentProvider, getDb());
}

function taskDetailResponse(id: string, _daemonStatus?: { state: "running" | "pausing" | "paused" | "stopped"; uptime: number }): Response {
  return new Response("", { status: 200, headers: { "HX-Redirect": `/?task=${id}` } });
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

function killRunningRuntimesForTask(taskId: string, daemon?: Pick<ManagerDaemon, "getAgentManager">): void {
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

  // 4. Force kill all collected PIDs with SIGKILL to ensure processes die
  for (const pid of killedPids) {
    try { process.kill(pid, 9); } catch { /* already dead or no permission */ }
  }
}

export function registerTaskRoutes(daemon?: Pick<ManagerDaemon, "getAgentManager" | "getRealtimeSessionManager" | "getPhaseManager" | "getStatus">): void {
  const scheduler = new TaskScheduler();

  addRoute("POST", "/api/settings/parallel-tasks", async (req) => {
    const body = await parseRequestBody<Record<string, string>>(req);
    const enabled = body.enabled === "on" || body.enabled === "true" || body.enabled === "1";
    setBoolSetting(getDb(), SETTING_PARALLEL_TASKS, enabled);
    return Response.json({ parallel: enabled });
  });

  addRoute("POST", "/api/tasks", async (req) => {
    const formData = await req.formData();
    const title = formData.get("title");
    const description = formData.get("description");
    const teamId = formData.get("teamId");
    const workingDirectoryRaw = formData.get("workingDirectory");
    const taskTypeRaw = formData.get("taskType");
    const taskConfigRaw = formData.get("taskConfig");
    const autoApproveRaw = formData.get("autoApprove");
    const templateIdRaw = formData.get("templateId");
    const templateId = typeof templateIdRaw === "string" && templateIdRaw.trim() ? templateIdRaw.trim() : undefined;
    const shouldAutoApprove = autoApproveRaw === "1" || autoApproveRaw === "true";

    if (!title || typeof title !== "string" || !title.trim()) {
      return taskCreationPageResponse("title is required", daemon?.getStatus());
    }

    const workingDirectory = typeof workingDirectoryRaw === "string" && workingDirectoryRaw.trim()
      ? workingDirectoryRaw.trim()
      : "";
    // working directory is optional; Skipper will discover it from the task
    // description if blank (see prompts/skipper.md, "WORKING DIRECTORY" section).

    let taskType: TaskType | undefined;
    if (typeof taskTypeRaw === "string" && (taskTypeRaw === "standard" || taskTypeRaw === "real_time")) {
      taskType = taskTypeRaw;
    }

    let taskConfig: RealtimeTaskConfig | undefined;
    if (typeof taskConfigRaw === "string" && taskConfigRaw.trim()) {
      try {
        taskConfig = JSON.parse(taskConfigRaw);
      } catch { /* ignore */ }
    }
    // Build config from individual form fields if not supplied as JSON
    if (!taskConfig && taskType === "real_time") {
      taskConfig = {};
      const ws = formData.get("window_seconds");
      if (ws) taskConfig.window_seconds = Number(ws);
      const sc = formData.get("summary_cadence_seconds");
      if (sc) taskConfig.summary_cadence_seconds = Number(sc);
      const tc = formData.get("trigger_min_confidence");
      if (tc) taskConfig.trigger_min_confidence = Number(tc);
      const mp = formData.get("max_pending_windows");
      if (mp) taskConfig.max_pending_windows = Number(mp);
      const cmd = formData.get("transcription_command");
      if (cmd && typeof cmd === "string" && cmd.trim()) taskConfig.transcription_command = cmd.trim();
    }

    try {
      const db = getDb();
      let resolvedTeamId = typeof teamId === "string" && teamId.trim() ? teamId.trim() : findDefaultTaskTeamId(db, taskType);
      const templateId = typeof templateIdRaw === "string" && templateIdRaw.trim() ? templateIdRaw.trim() : undefined;

      // Append template skipper_prompt to description before task creation
      const baseDescription = typeof description === "string" && description.trim() ? description.trim() : undefined;
      let finalDescription = baseDescription;
      if (templateId) {
        const skipperPrompt = getTemplateSkipperPrompt(db, templateId);
        if (skipperPrompt) {
          finalDescription = baseDescription ? `${baseDescription}\n\n${skipperPrompt}` : skipperPrompt;
        }
      }

      let created = scheduler.createTask({
        title: title.trim(),
        description: finalDescription,
        teamId: resolvedTeamId,
        workingDirectory,
        taskType,
        taskConfig,
      });

      // Collect per-task phase overrides from form fields. The task-create
      // form (src/routes/pages.ts ~2070-2110) posts one review field and up
      // to five consensus fields per phase:
      //   phaseReviewOverride_<phase>          = "" | "true" | "false"
      //   phaseConsensusMode_<phase>           = "" | "override" | "disabled"
      //   phaseConsensusAgentCount_<phase>     = number (when mode=override)
      //   phaseConsensusStrategy_<phase>       = "best_of" | "merge"
      //   phaseConsensusWorktree_<phase>       = "on" (checkbox; absent = off)
      //   phaseConsensusReviewerAgentId_<phase> = string
      type ConsensusConfig = import("../teams/manager").ConsensusConfig;
      const phaseOverrides: Record<string, { review?: boolean; consensus?: ConsensusConfig | null }> = {};
      const REVIEW_PREFIX = "phaseReviewOverride_";
      const CONSENSUS_MODE_PREFIX = "phaseConsensusMode_";

      // The task-create form names per-phase fields with a sanitized phase name
      // (pages.ts:2443 safeNameAttr = phase.name.replace(/[^a-zA-Z0-9_-]/g, "_")),
      // but downstream consumers (templates/helpers.ts) look up overrides by the
      // ORIGINAL phase name. Build a safeName → realName map from the team's
      // phases and translate when persisting so spaces/punctuation in phase
      // names don't silently drop the override.
      const safeNameToRealName: Record<string, string> = {};
      if (resolvedTeamId) {
        try {
          const teamRow = db
            .prepare("SELECT phases FROM teams WHERE id = ?")
            .get(resolvedTeamId) as { phases: string } | null;
          if (teamRow?.phases) {
            const teamPhases = JSON.parse(teamRow.phases) as Array<{ name: string }>;
            for (const p of teamPhases) {
              if (p && typeof p.name === "string") {
                const safe = p.name.replace(/[^a-zA-Z0-9_-]/g, "_");
                safeNameToRealName[safe] = p.name;
              }
            }
          }
        } catch { /* ignore — fall back to safe name if team phases unreadable */ }
      }
      const resolvePhaseName = (safe: string): string => safeNameToRealName[safe] ?? safe;

      const upsert = (phaseName: string, patch: Partial<{ review: boolean; consensus: ConsensusConfig | null }>) => {
        phaseOverrides[phaseName] = { ...phaseOverrides[phaseName], ...patch };
      };

      for (const [key, value] of formData.entries()) {
        if (key.startsWith(REVIEW_PREFIX) && key.length > REVIEW_PREFIX.length) {
          const phaseName = resolvePhaseName(key.slice(REVIEW_PREFIX.length));
          const val = typeof value === "string" ? value : "";
          if (val === "true") upsert(phaseName, { review: true });
          else if (val === "false") upsert(phaseName, { review: false });
        } else if (key.startsWith(CONSENSUS_MODE_PREFIX) && key.length > CONSENSUS_MODE_PREFIX.length) {
          const safe = key.slice(CONSENSUS_MODE_PREFIX.length);
          const phaseName = resolvePhaseName(safe);
          const mode = typeof value === "string" ? value : "";
          if (mode === "disabled") {
            upsert(phaseName, { consensus: null });
          } else if (mode === "override") {
            const countRaw = formData.get(`phaseConsensusAgentCount_${safe}`);
            const strategyRaw = formData.get(`phaseConsensusStrategy_${safe}`);
            const worktreeRaw = formData.get(`phaseConsensusWorktree_${safe}`);
            const reviewerRaw = formData.get(`phaseConsensusReviewerAgentId_${safe}`);
            const agent_count = Math.max(1, parseInt(typeof countRaw === "string" ? countRaw : "", 10) || 2);
            const strategy: ConsensusConfig["strategy"] =
              strategyRaw === "merge" ? "merge" : "best_of";
            const consensus: ConsensusConfig = {
              agent_count,
              strategy,
              worktree: typeof worktreeRaw === "string" && worktreeRaw.length > 0,
            };
            const reviewer = typeof reviewerRaw === "string" ? reviewerRaw.trim() : "";
            if (reviewer) consensus.reviewer_agent_id = reviewer;
            upsert(phaseName, { consensus });
          }
        }
      }

      // Store template_id, phase_overrides, and hooks in task_config
      if (templateId || Object.keys(phaseOverrides).length > 0) {
        const currentConfig = created.task_config as unknown as Record<string, unknown>;
        const updatedConfig: Record<string, unknown> = { ...currentConfig };
        if (templateId) updatedConfig.template_id = templateId;
        if (Object.keys(phaseOverrides).length > 0) updatedConfig.phase_overrides = phaseOverrides;
        if (templateId) {
          const templateRow = db
            .prepare("SELECT hooks FROM task_templates WHERE id = ? AND deleted_at IS NULL")
            .get(templateId) as { hooks: string } | null;
          if (templateRow?.hooks) {
            try {
              const hooks = JSON.parse(templateRow.hooks);
              if (Array.isArray(hooks) && hooks.length > 0) updatedConfig.hooks = hooks;
            } catch { /* ignore invalid hooks JSON */ }
          }
        }
        db.prepare("UPDATE tasks SET task_config = ?, updated_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(updatedConfig), created.id);
      }

      if (shouldAutoApprove) {
        created = scheduler.approveTask(created.id);
      }

      // Real-time tasks bypass the standard draft→approved→running pipeline.
      // When auto-approved (or after explicit approval), start them immediately
      // and initialise the realtime session.
      if (created.task_type === "real_time") {
        if (created.status === "approved") {
          scheduler.startTask(created.id);
        }
        if (daemon && created.status === "running") {
          try {
            daemon.getRealtimeSessionManager().startSession(created.id);
          } catch {
            // Session start failure is non-fatal; task is still running
          }
        }
      }

      if (req.headers.get("HX-Request")) {
        const redirectTo = shouldAutoApprove
          ? (created.task_type === "real_time" ? `/?task=${created.id}` : "/")
          : (created.task_type === "real_time" ? `/realtime/${created.id}` : `/tasks/${created.id}`);
        return new Response("", {
          status: 200,
          headers: {
            "HX-Redirect": redirectTo,
            "Content-Type": "text/html; charset=utf-8",
          },
        });
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
      let taskType: TaskType | undefined;
      if (body.taskType === "standard" || body.taskType === "real_time") {
        taskType = body.taskType;
      }
      let taskConfig: RealtimeTaskConfig | undefined;
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
        taskType,
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
      // Allow editing draft, approved, running, completed, and failed tasks

      const formData = await req.formData();
      const title = formData.get("title");
      const description = formData.get("description");
      const teamId = formData.get("teamId");
      const workingDirectory = formData.get("workingDirectory");
      const templateIdRaw = formData.get("templateId");
      const templateIdSubmitted = formData.has("templateId");
      const templateId = typeof templateIdRaw === "string" && templateIdRaw.trim() ? templateIdRaw.trim() : null;

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

      // Collect per-task phase overrides (phaseReviewOverride_<name>, phaseConsensusOverride_<name>)
      const phaseOverrides: Record<string, { review?: boolean; consensus?: import("../teams/manager").ConsensusConfig | null }> = {};
      let phaseOverridesSubmitted = false;
      // Build safeName → realName map so sanitized form field names resolve to
      // the original phase names (same logic as the create route).
      const resolvedTeamId = typeof teamId === "string" ? teamId.trim() : task.team_id;
      const safeNameToRealName: Record<string, string> = {};
      if (resolvedTeamId) {
        try {
          const teamRow = db.prepare("SELECT phases FROM teams WHERE id = ?").get(resolvedTeamId) as { phases: string } | null;
          if (teamRow?.phases) {
            const teamPhases = JSON.parse(teamRow.phases) as Array<{ name: string }>;
            for (const p of teamPhases) {
              if (p && typeof p.name === "string") {
                const safe = p.name.replace(/[^a-zA-Z0-9_-]/g, "_");
                safeNameToRealName[safe] = p.name;
              }
            }
          }
        } catch { /* ignore */ }
      }
      const resolvePhaseName = (safe: string): string => safeNameToRealName[safe] ?? safe;

      const REVIEW_PREFIX = "phaseReviewOverride_";
      const CONSENSUS_MODE_PREFIX = "phaseConsensusMode_";
      for (const [key, value] of formData.entries()) {
        if (key.startsWith(REVIEW_PREFIX) && key.length > REVIEW_PREFIX.length) {
          phaseOverridesSubmitted = true;
          const phaseName = resolvePhaseName(key.slice(REVIEW_PREFIX.length));
          const val = typeof value === "string" ? value : "";
          if (val === "true") {
            phaseOverrides[phaseName] = { ...phaseOverrides[phaseName], review: true };
          } else if (val === "false") {
            phaseOverrides[phaseName] = { ...phaseOverrides[phaseName], review: false };
          }
        } else if (key.startsWith(CONSENSUS_MODE_PREFIX) && key.length > CONSENSUS_MODE_PREFIX.length) {
          phaseOverridesSubmitted = true;
          const safe = key.slice(CONSENSUS_MODE_PREFIX.length);
          const phaseName = resolvePhaseName(safe);
          const mode = typeof value === "string" ? value : "";
          if (mode === "disabled") {
            phaseOverrides[phaseName] = { ...phaseOverrides[phaseName], consensus: null };
          } else if (mode === "override") {
            const countRaw = formData.get(`phaseConsensusAgentCount_${safe}`);
            const strategyRaw = formData.get(`phaseConsensusStrategy_${safe}`);
            const worktreeRaw = formData.get(`phaseConsensusWorktree_${safe}`);
            const reviewerRaw = formData.get(`phaseConsensusReviewerAgentId_${safe}`);
            const agent_count = Math.max(1, parseInt(typeof countRaw === "string" ? countRaw : "", 10) || 2);
            const strategy: import("../teams/manager").ConsensusConfig["strategy"] =
              strategyRaw === "merge" ? "merge" : "best_of";
            const consensus: import("../teams/manager").ConsensusConfig = {
              agent_count,
              strategy,
              worktree: typeof worktreeRaw === "string" && worktreeRaw.length > 0,
            };
            const reviewer = typeof reviewerRaw === "string" ? reviewerRaw.trim() : "";
            if (reviewer) consensus.reviewer_agent_id = reviewer;
            phaseOverrides[phaseName] = { ...phaseOverrides[phaseName], consensus };
          }
        }
      }

      // If templateId or phase overrides were part of the submission, rewrite task_config
      if (templateIdSubmitted || phaseOverridesSubmitted) {
        const row = db.prepare("SELECT task_config FROM tasks WHERE id = ?").get(params.id) as { task_config: string } | null;
        let currentConfig: Record<string, unknown> = {};
        try { currentConfig = row?.task_config ? JSON.parse(row.task_config) : {}; } catch { /* ignore */ }
        const updatedConfig: Record<string, unknown> = { ...currentConfig };
        if (templateIdSubmitted) {
          if (templateId) {
            updatedConfig.template_id = templateId;
            // Copy hooks from the selected template so they fire for this task
            const templateRow = db
              .prepare("SELECT hooks FROM task_templates WHERE id = ? AND deleted_at IS NULL")
              .get(templateId) as { hooks: string } | null;
            if (templateRow?.hooks) {
              try {
                const hooks = JSON.parse(templateRow.hooks);
                if (Array.isArray(hooks) && hooks.length > 0) updatedConfig.hooks = hooks;
                else delete updatedConfig.hooks;
              } catch { /* ignore */ }
            } else {
              delete updatedConfig.hooks;
            }
          } else {
            delete updatedConfig.template_id;
            delete updatedConfig.hooks;
          }
        }
        if (phaseOverridesSubmitted) {
          if (Object.keys(phaseOverrides).length > 0) updatedConfig.phase_overrides = phaseOverrides;
          else delete updatedConfig.phase_overrides;
        }
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
        scheduler.approveTask(params.id);
        const updated = scheduler.getTask(params.id);
        if (updated && updated.task_type === "real_time") {
          scheduler.startTask(params.id);
          if (daemon) {
            try { daemon.getRealtimeSessionManager().startSession(params.id); } catch { /* non-fatal */ }
          }
        }
      }

      if (req.headers.get("HX-Request")) {
        return new Response("", { status: 200, headers: { "HX-Redirect": `/?task=${params.id}` } });
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/approve", (_req, params) => {
    try {
      const beforeTask = scheduler.getTask(params.id);
      scheduler.approveTask(params.id);

      // Real-time tasks auto-start when approved so the session is ready immediately
      if (beforeTask && beforeTask.task_type === "real_time") {
        scheduler.startTask(params.id);
        if (daemon) {
          try {
            daemon.getRealtimeSessionManager().startSession(params.id);
          } catch {
            // Session start failure is non-fatal; task is still running
          }
        }
      }

      if (_req.headers.get("HX-Request")) {
        return new Response("", { status: 200, headers: { "HX-Redirect": `/?task=${params.id}` } });
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
        return new Response("", { status: 200, headers: { "HX-Redirect": `/?task=${params.id}` } });
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
      scheduler.completeTask(params.id, "Manually completed");
      if (_req.headers.get("HX-Request")) {
        return new Response("", { status: 200, headers: { "HX-Redirect": `/?task=${params.id}` } });
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
      scheduler.cancelTask(params.id);
      if (_req.headers.get("HX-Request")) {
        return new Response("", { status: 200, headers: { "HX-Redirect": `/?task=${params.id}` } });
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/retry", (_req, params) => {
    try {
      scheduler.retryTask(params.id);
      if (_req.headers.get("HX-Request")) {
        return new Response("", { status: 200, headers: { "HX-Redirect": `/?task=${params.id}` } });
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/resume", (_req, params) => {
    try {
      scheduler.resumeTask(params.id);
      if (_req.headers.get("HX-Request")) {
        return new Response("", { status: 200, headers: { "HX-Redirect": `/?task=${params.id}` } });
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/iterate", async (req, params) => {
    try {
      const body = await parseRequestBody<Record<string, string>>(req);
      const additionalInput = body.additionalInput || body.additional_input;
      if (!additionalInput) {
        return Response.json({ error: "additionalInput is required" }, { status: 400 });
      }
      const updated = scheduler.iterateTask(params.id, additionalInput);
      if (req.headers.get("HX-Request")) {
        return new Response("", { status: 200, headers: { "HX-Redirect": `/?task=${params.id}` } });
      }
      return Response.json(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      if (req.headers.get("HX-Request")) {
        return Response.json({ error: message }, { status: 400 });
      }
      return Response.json({ error: message }, { status: 400 });
    }
  });

  const handleDelete = (req: Request, params: { id: string }): Response => {
    try {
      const task = scheduler.getTask(params.id);
      if (task && task.status === "running") {
        killRunningRuntimesForTask(params.id, daemon);
        try { scheduler.failTask(params.id, "Deleted by user"); } catch { /* already failed or transitioned */ }
      }

      scheduler.deleteTask(params.id);

      // List-page row deletes set X-Skip-Redirect so HTMX swaps the row in
      // place. Other surfaces (detail page) still get the redirect-to-home.
      const skipRedirect = req.headers.get("X-Skip-Redirect") === "1";
      if (req.headers.get("HX-Request")) {
        if (skipRedirect) return new Response("", { status: 200 });
        return new Response("", { status: 200, headers: { "HX-Redirect": "/" } });
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
      // Clear stale agent assignments for this task
      db.prepare("UPDATE agents SET current_task_id = NULL, process_pid = NULL WHERE current_task_id = ?").run(params.id);
      // Fail active instances
      db.prepare(
        "UPDATE agent_instances SET status = 'failed', process_pid = NULL, updated_at = datetime('now') WHERE task_id = ? AND status IN ('running', 'waiting_delegation', 'pending')",
      ).run(params.id);

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

  // --- Artifact REST API ---

  const artifactManager = new ArtifactManager();

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
    return Response.json(artifact);
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
    if (task.task_type !== "real_time") {
      return Response.json({ error: "Task is not a real_time task" }, { status: 400 });
    }
    if (task.status !== "running" && task.status !== "approved") {
      return Response.json({ error: "Task must be approved or running to start a realtime session" }, { status: 400 });
    }

    if (daemon) {
      if (task.status === "approved") {
        try {
          scheduler.startTask(params.id);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal error";
          return Response.json({ error: message }, { status: 400 });
        }
      }
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
    if (task.task_type !== "real_time") {
      return Response.json({ error: "Task is not a real_time task" }, { status: 400 });
    }

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
    if (task.task_type !== "real_time") {
      return Response.json({ error: "Task is not a real_time task" }, { status: 400 });
    }

    // SSE endpoint — emit events for transcript/summary windows and triggers
    const encoder = new TextEncoder();

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

        eventBus.on("realtime:window_ready", windowHandler);
        eventBus.on("realtime:trigger_fired", triggerHandler);
        eventBus.on("realtime:session_state", sessionHandler);
        eventBus.on("realtime:timeline_updated", timelineHandler);

        // Send initial state
        sendEvent("session.state", { state: task.status === "running" ? "active" : "stopped" });

        // Cleanup on close
        req.signal.addEventListener("abort", () => {
          eventBus.off("realtime:window_ready", windowHandler);
          eventBus.off("realtime:trigger_fired", triggerHandler);
          eventBus.off("realtime:session_state", sessionHandler);
          eventBus.off("realtime:timeline_updated", timelineHandler);
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
