import { addRoute } from "../server";
import { TaskScheduler } from "../tasks/scheduler";
import { getDb } from "../db/connection";
import { eventBus } from "../events/bus";
import { getRealtimeTeamId } from "../config/teams";
import { getRealtimeConfig, updateRealtimeConfig } from "../realtime/config";
import type { RealtimeConfig } from "../realtime/config";
import type { ManagerDaemon } from "../agents/manager-daemon";
import {
  realtimeTasksPage,
  realtimeTaskDetailPage,
  timelineEntriesFragment,
  notesFragment,
  runningAgentsFragment,
  agentAssignmentFragment,
} from "../html/realtime-components";
import type {
  RealtimeTaskData,
  TimelineEntry,
  PipelineStatus,
  RunningAgentInstance,
  TaskNote,
  AvailableAgent,
  RealtimeTaskConfig,
  TeamAssignedAgent,
} from "../html/realtime-components";
import { htmlResponse as html, hxRedirect } from "./utils";

function fetchAvailableAgents(): AvailableAgent[] {
  const db = getDb();
  return db
    .prepare("SELECT id, name, type, capabilities FROM agents WHERE id != 'skipper' ORDER BY name")
    .all() as AvailableAgent[];
}

function parseTaskConfig(taskConfigStr: string): RealtimeTaskConfig {
  try {
    return JSON.parse(taskConfigStr || "{}") as RealtimeTaskConfig;
  } catch {
    return {};
  }
}

function resolveDefaultRealtimeTeamId(): string | null {
  const preferred = getRealtimeTeamId();
  if (preferred) return preferred;

  const fallback = getDb()
    .prepare("SELECT id FROM teams ORDER BY created_at, id LIMIT 1")
    .get() as { id: string } | null;
  return fallback?.id ?? null;
}

export function registerRealtimeRoutes(daemon?: ManagerDaemon): void {
  const scheduler = new TaskScheduler();

  // --- Page routes ---

  // Redirect /realtime to /tasks — task lists are now combined
  addRoute("GET", "/realtime", () => {
    return new Response("", { status: 302, headers: { "Location": "/tasks", "HX-Redirect": "/tasks" } });
  });

  addRoute("GET", "/realtime/new", () => {
    return new Response("", { status: 302, headers: { "Location": "/tasks/new", "HX-Redirect": "/tasks/new" } });
  });

  addRoute("GET", "/realtime/:id", (_req, params) => {
    const db = getDb();
    const task = db
      .prepare(
        `SELECT t.*, tm.name AS team_name, (SELECT COUNT(*) FROM task_input_streams WHERE task_id = t.id) AS segment_count
         FROM tasks t
         LEFT JOIN teams tm ON tm.id = t.team_id
         WHERE t.id = ? AND t.task_type = 'real_time'`,
      )
      .get(params.id) as RealtimeTaskData | null;

    if (!task) {
      return new Response("<p>Real-time task not found</p>", {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const timeline = db
      .prepare(
        "SELECT * FROM realtime_timeline WHERE task_id = ? ORDER BY created_at DESC",
      )
      .all(params.id) as TimelineEntry[];

    const pipelineStatus = db
      .prepare("SELECT * FROM realtime_pipeline_state WHERE task_id = ?")
      .get(params.id) as PipelineStatus | null;

    if (pipelineStatus) {
      const counts = db
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM task_input_streams WHERE task_id = ?) AS total_segments,
            (SELECT COUNT(*) FROM task_input_streams WHERE task_id = ? AND transcription_status = 'pending') AS pending_transcription,
            (SELECT COUNT(*) FROM task_input_streams WHERE task_id = ? AND transcription_status = 'failed') AS failed_transcription,
            (SELECT COUNT(*) FROM task_input_streams WHERE task_id = ? AND summary_batch_id IS NULL AND transcription_status != 'pending') AS pending_summarization,
            (SELECT COUNT(*) FROM realtime_timeline WHERE task_id = ?) AS timeline_entry_count`,
        )
        .get(params.id, params.id, params.id, params.id, params.id) as {
          total_segments: number;
          pending_transcription: number;
          failed_transcription: number;
          pending_summarization: number;
          timeline_entry_count: number;
        };
      pipelineStatus.total_segments = counts.total_segments;
      pipelineStatus.pending_transcription = counts.pending_transcription;
      pipelineStatus.failed_transcription = counts.failed_transcription;
      pipelineStatus.pending_summarization = counts.pending_summarization;
      pipelineStatus.timeline_entry_count = counts.timeline_entry_count;
    }

    const config = getRealtimeConfig(db);
    const isSessionActive = daemon
      ? daemon.getRealtimeSessionManager().isSessionActive(params.id)
      : (pipelineStatus?.cadence_timer_active === 1);

    const runningAgents = db.prepare(
      `SELECT ai.id, ai.template_agent_id, a.name AS agent_name, ai.status, ai.created_at
       FROM agent_instances ai
       JOIN agents a ON a.id = ai.template_agent_id
       WHERE ai.task_id = ? AND ai.status IN ('running', 'pending')
       ORDER BY ai.created_at DESC`,
    ).all(params.id) as RunningAgentInstance[];

    const notes = db.prepare(
      `SELECT n.id, n.agent_id, COALESCE(a.name, n.agent_id) AS agent_name, n.content, n.created_at
       FROM task_notes n
       LEFT JOIN agents a ON a.id = n.agent_id
       WHERE n.task_id = ?
       ORDER BY n.created_at DESC
       LIMIT 50`,
    ).all(params.id) as TaskNote[];

    const availableAgents = fetchAvailableAgents();
    const teamAgents = task.team_id
      ? db.prepare(
        `SELECT a.id, a.name, ta.role
         FROM team_agents ta
         JOIN agents a ON a.id = ta.agent_id
         WHERE ta.team_id = ? AND a.id != 'skipper'
         ORDER BY ta.level ASC, a.name ASC`,
      ).all(task.team_id) as TeamAssignedAgent[]
      : [];

    return html(realtimeTaskDetailPage(task, timeline, pipelineStatus, config, isSessionActive, runningAgents, notes, availableAgents, teamAgents, daemon?.getStatus()));
  });

  // --- API routes ---

  addRoute("POST", "/api/realtime-tasks", async (req) => {
    const contentType = req.headers.get("content-type") ?? "";
    let title: string | null = null;
    let description: string | null = null;
    let teamId: string | null = null;

    if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      title = formData.get("title") as string | null;
      description = formData.get("description") as string | null;
      teamId = formData.get("teamId") as string | null;
    } else {
      const body = await req.json();
      title = body.title ?? null;
      description = body.description ?? null;
      teamId = body.teamId ?? null;
    }

    if (!title || typeof title !== "string" || !title.trim()) {
      if (req.headers.get("HX-Request")) {
        const db = getDb();
        const tasks = db
          .prepare(
            `SELECT t.*, (SELECT COUNT(*) FROM task_input_streams WHERE task_id = t.id) AS segment_count
             FROM tasks t WHERE t.task_type = 'real_time' ORDER BY t.created_at DESC`,
          )
          .all() as RealtimeTaskData[];
        return html(realtimeTasksPage(tasks, "Title is required", daemon?.getStatus()));
      }
      return Response.json({ error: "title is required" }, { status: 400 });
    }

    try {
      const resolvedTeamId = (typeof teamId === "string" && teamId.trim())
        ? teamId.trim()
        : resolveDefaultRealtimeTeamId() ?? undefined;
      // Create the task with realtime team
      const task = scheduler.createTask({
        title: title.trim(),
        description: typeof description === "string" && description.trim() ? description.trim() : undefined,
        teamId: resolvedTeamId,
        workingDirectory: process.cwd(),
        taskType: "real_time",
      });

      // Real-time tasks bypass the standard draft→approved→running pipeline.
      // They don't go through the task runner / Skipper — they're managed
      // entirely by the RealtimeSessionManager.
      const db = getDb();
      db.prepare(
        `UPDATE tasks SET status = 'running', approved_at = datetime('now'), started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);

      // Initialize realtime session if daemon available
      if (daemon) {
        try {
          const rtMgr = daemon.getRealtimeSessionManager();
          rtMgr.startSession(task.id);
        } catch {
          // Session start failure is non-fatal; task is still running
        }
      }

      if (req.headers.get("HX-Request")) {
        // Redirect to detail page
        return hxRedirect(`/realtime/${task.id}`);
      }
      return Response.json(task, { status: 201 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      if (req.headers.get("HX-Request")) {
        const db = getDb();
        const tasks = db
          .prepare(
            `SELECT t.*, (SELECT COUNT(*) FROM task_input_streams WHERE task_id = t.id) AS segment_count
             FROM tasks t WHERE t.task_type = 'real_time' ORDER BY t.created_at DESC`,
          )
          .all() as RealtimeTaskData[];
        return html(realtimeTasksPage(tasks, message, daemon?.getStatus()));
      }
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("GET", "/api/realtime-tasks", () => {
    const db = getDb();
    const tasks = db
      .prepare(
        "SELECT * FROM tasks WHERE task_type = 'real_time' ORDER BY created_at DESC",
      )
      .all();
    return Response.json(tasks);
  });

  addRoute("POST", "/api/realtime-tasks/:id", async (req, params) => {
    const db = getDb();
    const task = db
      .prepare("SELECT id, task_type FROM tasks WHERE id = ?")
      .get(params.id) as { id: string; task_type: string } | null;
    if (!task || task.task_type !== "real_time") {
      return Response.json({ error: "Task not found" }, { status: 404 });
    }

    const contentType = req.headers.get("content-type") ?? "";
    let title: string | null = null;
    let description: string | null = null;

    if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      title = formData.get("title") as string | null;
      description = formData.get("description") as string | null;
    } else {
      const body = await req.json();
      title = body.title ?? null;
      description = body.description ?? null;
    }

    if (!title || typeof title !== "string" || !title.trim()) {
      return Response.json({ error: "title is required" }, { status: 400 });
    }

    db.prepare(
      `UPDATE tasks
       SET title = ?, description = ?, updated_at = datetime('now')
       WHERE id = ? AND task_type = 'real_time'`,
    ).run(
      title.trim(),
      typeof description === "string" && description.trim() ? description.trim() : null,
      params.id,
    );

    if (req.headers.get("HX-Request")) {
      return hxRedirect(`/realtime/${params.id}`);
    }

    const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(params.id);
    return Response.json(updated);
  });

  addRoute("POST", "/api/realtime-tasks/:id/start", (_req, params) => {
    try {
      const url = new URL(_req.url);
      const stayMode = url.searchParams.get("stay");
      const task = scheduler.getTask(params.id);
      if (!task || task.task_type !== "real_time") {
        return Response.json({ error: "Task not found" }, { status: 404 });
      }
      if (task.status !== "approved" && task.status !== "running") {
        return Response.json({ error: "Task must be approved or running to start" }, { status: 400 });
      }
      if (!daemon) {
        return Response.json({ error: "Daemon not available" }, { status: 503 });
      }

      if (task.status === "approved") {
        scheduler.startTask(params.id);
      }

      const rtMgr = daemon.getRealtimeSessionManager();
      rtMgr.startSession(params.id);

      if (_req.headers.get("HX-Request")) {
        if (stayMode === "dashboard") {
          return new Response("", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return hxRedirect(`/realtime/${params.id}`);
      }

      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/realtime-tasks/:id/stop", async (_req, params) => {
    try {
      // Pause the realtime session (does not complete the task)
      if (daemon) {
        const rtMgr = daemon.getRealtimeSessionManager();
        if (rtMgr.isSessionActive(params.id)) {
          await rtMgr.stopSession(params.id);
        }
      }

      if (_req.headers.get("HX-Request")) {
        return hxRedirect(`/realtime/${params.id}`);
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/realtime-tasks/:id/resume", (_req, params) => {
    try {
      if (!daemon) {
        return Response.json({ error: "Daemon not available" }, { status: 503 });
      }

      const rtMgr = daemon.getRealtimeSessionManager();
      rtMgr.resumeSession(params.id);

      if (_req.headers.get("HX-Request")) {
        return hxRedirect(`/realtime/${params.id}`);
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/realtime-tasks/:id/close", (_req, params) => {
    try {
      // Permanently end the realtime session and complete the task
      if (daemon) {
        const rtMgr = daemon.getRealtimeSessionManager();
        rtMgr.closeSession(params.id);
      }

      const task = scheduler.getTask(params.id);
      if (task && task.status === "running") {
        scheduler.completeTask(params.id, { stopped_by: "user" });
      }

      if (_req.headers.get("HX-Request")) {
        return hxRedirect(`/realtime/${params.id}`);
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  const handleRealtimeDelete = (req: Request, params: { id: string }): Response => {
    try {
      const task = scheduler.getTask(params.id);
      if (!task) {
        if (req.headers.get("HX-Request")) {
          return hxRedirect("/realtime");
        }
        return Response.json({ error: "Task not found" }, { status: 404 });
      }

      // Close any active session first
      if (daemon && task.status === "running") {
        const rtMgr = daemon.getRealtimeSessionManager();
        rtMgr.closeSession(params.id);
      }

      // If task is still running, fail it so deleteTask doesn't throw
      if (task.status === "running") {
        try { scheduler.failTask(params.id, "Deleted by user"); } catch { /* already failed */ }
      }

      scheduler.deleteTask(params.id);

      if (req.headers.get("HX-Request")) {
        return hxRedirect("/realtime");
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  };

  addRoute("POST", "/api/realtime-tasks/:id/delete", handleRealtimeDelete);
  addRoute("DELETE", "/api/realtime-tasks/:id", handleRealtimeDelete);

  addRoute("POST", "/api/realtime-tasks/:id/unarchive", (_req, params) => {
    try {
      const db = getDb();
      const task = scheduler.getTask(params.id);
      if (!task) {
        return Response.json({ error: "Task not found" }, { status: 404 });
      }
      if (task.status !== "completed" && task.status !== "failed") {
        return Response.json({ error: "Only archived or failed tasks can be unarchived" }, { status: 400 });
      }

      const previousStatus = task.status;

      // Move back to running and restart the session
      db.prepare(
        "UPDATE tasks SET status = 'running', result = NULL, completed_at = NULL, updated_at = datetime('now') WHERE id = ?",
      ).run(params.id);

      eventBus.emit("task:state_changed", {
        taskId: params.id,
        previousStatus,
        newStatus: "running",
      });

      if (daemon) {
        const rtMgr = daemon.getRealtimeSessionManager();
        if (!rtMgr.isSessionActive(params.id)) {
          rtMgr.resumeSession(params.id);
        }
      }

      if (_req.headers.get("HX-Request")) {
        return new Response("", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/realtime-tasks/:id/input", async (req, params) => {
    const contentType = req.headers.get("content-type") ?? "";
    let text: string | null = null;

    if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      text = formData.get("text") as string | null;
    } else {
      const body = await req.json();
      text = body.text ?? null;
    }

    if (!text || typeof text !== "string" || !text.trim()) {
      return Response.json({ error: "text is required" }, { status: 400 });
    }

    if (!daemon) {
      return Response.json({ error: "Daemon not available" }, { status: 503 });
    }

    const rtMgr = daemon.getRealtimeSessionManager();
    if (!rtMgr.isSessionActive(params.id)) {
      return Response.json({ error: "Session is paused. Resume the task first." }, { status: 400 });
    }

    try {
      await rtMgr.ingestInput(params.id, {
        sourceType: "text",
        contentBody: text.trim(),
      });
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  // Per-task agent assignment config
  addRoute("POST", "/api/realtime-tasks/:id/config", async (req, params) => {
    const db = getDb();
    const task = db.prepare("SELECT id, task_config FROM tasks WHERE id = ? AND task_type = 'real_time'").get(params.id) as { id: string; task_config: string } | null;
    if (!task) {
      return Response.json({ error: "Task not found" }, { status: 404 });
    }

    const contentType = req.headers.get("content-type") ?? "";
    let summarizerAgentId = "";
    let assignedAgentIds: string[] = [];

    if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      summarizerAgentId = (formData.get("summarizer_agent_id") as string | null) ?? "";
      assignedAgentIds = formData.getAll("assigned_agent_ids").map(v => v.toString());
    } else {
      const body = await req.json();
      summarizerAgentId = body.summarizer_agent_id ?? "";
      assignedAgentIds = Array.isArray(body.assigned_agent_ids) ? body.assigned_agent_ids : [];
    }

    const existingConfig = parseTaskConfig(task.task_config);
    const newConfig: RealtimeTaskConfig = {
      ...existingConfig,
      summarizer_agent_id: summarizerAgentId || undefined,
      assigned_agent_ids: assignedAgentIds.length > 0 ? assignedAgentIds : undefined,
    };

    db.prepare("UPDATE tasks SET task_config = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(newConfig), params.id);

    if (req.headers.get("HX-Request")) {
      const selectableAgents = fetchAvailableAgents();
      return html(agentAssignmentFragment(
        params.id,
        selectableAgents,
        newConfig.assigned_agent_ids ?? [],
        newConfig.summarizer_agent_id ?? "",
      ));
    }
    return Response.json({ ok: true, config: newConfig });
  });

  addRoute("GET", "/api/realtime-tasks/:id/timeline", (_req, params) => {
    const db = getDb();
    const timeline = db
      .prepare(
        "SELECT * FROM realtime_timeline WHERE task_id = ? ORDER BY created_at DESC",
      )
      .all(params.id) as TimelineEntry[];

    // If HTMX request, return HTML fragment
    if (_req.headers.get("HX-Request")) {
      return html(timelineEntriesFragment(timeline));
    }
    return Response.json(timeline);
  });

  addRoute("GET", "/api/realtime-tasks/:id/notes", (_req, params) => {
    const db = getDb();
    const notes = db.prepare(
      `SELECT n.id, n.agent_id, COALESCE(a.name, n.agent_id) AS agent_name, n.content, n.created_at
       FROM task_notes n
       LEFT JOIN agents a ON a.id = n.agent_id
       WHERE n.task_id = ?
       ORDER BY n.created_at DESC
       LIMIT 50`,
    ).all(params.id) as TaskNote[];

    if (_req.headers.get("HX-Request")) {
      return html(notesFragment(notes));
    }
    return Response.json(notes);
  });

  // All agents (running + recently completed/failed) for the task
  addRoute("GET", "/api/realtime-tasks/:id/agents", (_req, params) => {
    const db = getDb();
    const agents = db.prepare(
      `SELECT ai.id, ai.template_agent_id, a.name AS agent_name, ai.status, ai.created_at
       FROM agent_instances ai
       JOIN agents a ON a.id = ai.template_agent_id
       WHERE ai.task_id = ?
         AND (ai.status IN ('running', 'pending')
              OR (ai.status IN ('completed', 'failed')
                  AND ai.created_at > datetime('now', '-1 hour')))
       ORDER BY
         CASE WHEN ai.status IN ('running', 'pending') THEN 0 ELSE 1 END,
         ai.created_at DESC
       LIMIT 20`,
    ).all(params.id) as RunningAgentInstance[];

    if (_req.headers.get("HX-Request")) {
      return html(runningAgentsFragment(agents));
    }
    return Response.json(agents);
  });

  // Backward compat alias
  addRoute("GET", "/api/realtime-tasks/:id/running-agents", (_req, params) => {
    const db = getDb();
    const agents = db.prepare(
      `SELECT ai.id, ai.template_agent_id, a.name AS agent_name, ai.status, ai.created_at
       FROM agent_instances ai
       JOIN agents a ON a.id = ai.template_agent_id
       WHERE ai.task_id = ? AND ai.status IN ('running', 'pending')
       ORDER BY ai.created_at DESC`,
    ).all(params.id) as RunningAgentInstance[];

    if (_req.headers.get("HX-Request")) {
      return html(runningAgentsFragment(agents));
    }
    return Response.json(agents);
  });

  addRoute("GET", "/api/realtime-tasks/:id/pipeline-status", (_req, params) => {
    const db = getDb();
    const pipelineStatus = db
      .prepare("SELECT * FROM realtime_pipeline_state WHERE task_id = ?")
      .get(params.id) as PipelineStatus | null;

    if (!pipelineStatus) {
      return Response.json({
        total_segments: 0,
        pending_transcription: 0,
        failed_transcription: 0,
        pending_summarization: 0,
        timeline_entry_count: 0,
      });
    }

    const counts = db
      .prepare(
        `SELECT
            (SELECT COUNT(*) FROM task_input_streams WHERE task_id = ?) AS total_segments,
            (SELECT COUNT(*) FROM task_input_streams WHERE task_id = ? AND transcription_status = 'pending') AS pending_transcription,
            (SELECT COUNT(*) FROM task_input_streams WHERE task_id = ? AND transcription_status = 'failed') AS failed_transcription,
            (SELECT COUNT(*) FROM task_input_streams WHERE task_id = ? AND summary_batch_id IS NULL AND transcription_status != 'pending') AS pending_summarization,
            (SELECT COUNT(*) FROM realtime_timeline WHERE task_id = ?) AS timeline_entry_count`,
      )
      .get(params.id, params.id, params.id, params.id, params.id) as {
        total_segments: number;
        pending_transcription: number;
        failed_transcription: number;
        pending_summarization: number;
        timeline_entry_count: number;
      };

    return Response.json({
      ...pipelineStatus,
      ...counts,
    });
  });

  addRoute("GET", "/api/realtime/config", () => {
    const config = getRealtimeConfig();
    return Response.json(config);
  });

  addRoute("POST", "/api/realtime/config", async (req) => {
    const contentType = req.headers.get("content-type") ?? "";
    let updates: Partial<RealtimeConfig>;

    if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      updates = {};
      const transcriptionEndpoint = formData.get("transcription_endpoint");
      if (transcriptionEndpoint !== null) {
        updates.transcription_endpoint = transcriptionEndpoint.toString();
      }
      const summarizationModel = formData.get("summarization_model");
      if (summarizationModel !== null && summarizationModel.toString().trim()) {
        updates.summarization_model = summarizationModel.toString().trim();
      }
      const cadenceSeconds = formData.get("cadence_seconds");
      if (cadenceSeconds !== null) {
        const val = parseInt(cadenceSeconds.toString(), 10);
        if (!isNaN(val) && val >= 5) {
          updates.cadence_seconds = val;
        }
      }
      const transcriptionProvider = formData.get("transcription_provider");
      if (transcriptionProvider !== null) {
        const prov = transcriptionProvider.toString();
        if (prov === "local" || prov === "openai") {
          updates.transcription_provider = prov;
        }
      }
      const overlapSeconds = formData.get("overlap_seconds");
      if (overlapSeconds !== null) {
        const val = parseInt(overlapSeconds.toString(), 10);
        if (!isNaN(val) && val >= 0) {
          updates.overlap_seconds = Math.min(val, 15);
        }
      }
      const openaiModel = formData.get("openai_transcription_model");
      if (openaiModel !== null && openaiModel.toString().trim()) {
        updates.openai_transcription_model = openaiModel.toString().trim();
      }
    } else {
      updates = await req.json();
    }

    const config = updateRealtimeConfig(updates);

    if (req.headers.get("HX-Request")) {
      return hxRedirect("/config");
    }
    return Response.json(config);
  });
}
