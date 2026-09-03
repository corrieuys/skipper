import { addRoute } from "../server";
import { TaskScheduler } from "../tasks/scheduler";
import { getDb } from "../db/connection";
import {
  fetchRealtimeTimeline,
  fetchRealtimeNotes,
  fetchRealtimeTaskAgents,
  fetchRealtimeRunningAgents,
  fetchRealtimePipelineStatus,
  EMPTY_PIPELINE_COUNTS,
} from "../data/realtime";
import { getRealtimeConfig, updateRealtimeConfig } from "../realtime/config";
import type { RealtimeConfig } from "../realtime/config";
import type { ManagerDaemon } from "../agents/manager-daemon";
import {
  timelineEntriesFragment,
  notesFragment,
  runningAgentsFragment,
  agentAssignmentFragment,
} from "../html/realtime-components";
import type {
  AvailableAgent,
  RealtimeTaskConfig,
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

// Legacy /api/realtime-tasks/* aliases retained for the embedded public JS
// (realtime.js) and older clients. Create/edit/list/delete moved to the
// unified /api/tasks surface; the session + read endpoints below work for
// ANY task in the unified model.
export function registerRealtimeRoutes(daemon?: ManagerDaemon): void {
  const scheduler = new TaskScheduler();

  // --- Page routes (legacy redirects) ---

  // Redirect /realtime to /tasks: task lists are combined
  addRoute("GET", "/realtime", () => {
    return new Response("", { status: 302, headers: { "Location": "/tasks", "HX-Redirect": "/tasks" } });
  });

  addRoute("GET", "/realtime/new", () => {
    return new Response("", { status: 302, headers: { "Location": "/tasks/new", "HX-Redirect": "/tasks/new" } });
  });

  // Legacy standalone real-time page retired: redirect any old link to the
  // command center's task view.
  addRoute("GET", "/realtime/:id", (_req, params) => {
    const to = `/?task=${encodeURIComponent(params.id!)}`;
    return new Response("", { status: 302, headers: { Location: to, "HX-Redirect": to } });
  });

  // --- Session lifecycle (any active task) ---

  addRoute("POST", "/api/realtime-tasks/:id/start", (_req, params) => {
    try {
      const url = new URL(_req.url);
      const stayMode = url.searchParams.get("stay");
      const task = scheduler.getTask(params.id);
      if (!task) {
        return Response.json({ error: "Task not found" }, { status: 404 });
      }
      if (task.status !== "active") {
        return Response.json({ error: "Task must be active to start a session" }, { status: 400 });
      }
      if (!daemon) {
        return Response.json({ error: "Daemon not available" }, { status: 503 });
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
        return hxRedirect(`/?task=${params.id}`);
      }

      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/realtime-tasks/:id/stop", async (_req, params) => {
    try {
      // Pause the input session (does not settle the task)
      if (daemon) {
        const rtMgr = daemon.getRealtimeSessionManager();
        if (rtMgr.isSessionActive(params.id)) {
          await rtMgr.stopSession(params.id);
        }
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

  addRoute("POST", "/api/realtime-tasks/:id/resume", (_req, params) => {
    try {
      if (!daemon) {
        return Response.json({ error: "Daemon not available" }, { status: 503 });
      }

      const rtMgr = daemon.getRealtimeSessionManager();
      rtMgr.resumeSession(params.id);

      if (_req.headers.get("HX-Request")) {
        return hxRedirect(`/?task=${params.id}`);
      }
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/realtime-tasks/:id/close", (_req, params) => {
    try {
      // Permanently end the input session and settle the task
      if (daemon) {
        const rtMgr = daemon.getRealtimeSessionManager();
        rtMgr.closeSession(params.id);
      }

      const task = scheduler.getTask(params.id);
      if (task && task.status === "active") {
        scheduler.settleTask(params.id, { result: { stopped_by: "user" } });
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

  // --- Text input (unified: routes through daemon.inputTask) ---

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

    try {
      const result = await daemon.inputTask(params.id, text, "web");
      return Response.json({ ok: true, delivered: result.delivered });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  // Per-task agent assignment config
  addRoute("POST", "/api/realtime-tasks/:id/config", async (req, params) => {
    const db = getDb();
    const task = db.prepare("SELECT id, task_config FROM tasks WHERE id = ?").get(params.id) as { id: string; task_config: string } | null;
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

  // --- Read endpoints (any task) ---

  addRoute("GET", "/api/realtime-tasks/:id/timeline", (_req, params) => {
    const db = getDb();
    const timeline = fetchRealtimeTimeline(db, params.id);

    // If HTMX request, return HTML fragment
    if (_req.headers.get("HX-Request")) {
      return html(timelineEntriesFragment(timeline));
    }
    return Response.json(timeline);
  });

  addRoute("GET", "/api/realtime-tasks/:id/notes", (_req, params) => {
    const db = getDb();
    const notes = fetchRealtimeNotes(db, params.id);

    if (_req.headers.get("HX-Request")) {
      return html(notesFragment(notes));
    }
    return Response.json(notes);
  });

  // All agents (running + recently completed/failed) for the task
  addRoute("GET", "/api/realtime-tasks/:id/agents", (_req, params) => {
    const db = getDb();
    const agents = fetchRealtimeTaskAgents(db, params.id);

    if (_req.headers.get("HX-Request")) {
      return html(runningAgentsFragment(agents));
    }
    return Response.json(agents);
  });

  // Backward compat alias
  addRoute("GET", "/api/realtime-tasks/:id/running-agents", (_req, params) => {
    const db = getDb();
    const agents = fetchRealtimeRunningAgents(db, params.id);

    if (_req.headers.get("HX-Request")) {
      return html(runningAgentsFragment(agents));
    }
    return Response.json(agents);
  });

  addRoute("GET", "/api/realtime-tasks/:id/pipeline-status", (_req, params) => {
    const db = getDb();
    const pipelineStatus = fetchRealtimePipelineStatus(db, params.id);
    if (!pipelineStatus) {
      return Response.json(EMPTY_PIPELINE_COUNTS);
    }
    return Response.json(pipelineStatus);
  });

  // --- Global transcription settings ---

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
