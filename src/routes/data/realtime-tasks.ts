import { addDataRoute } from "./auth";
import { getDb } from "../../db/connection";
import { TaskScheduler } from "../../tasks/scheduler";
import { getRealtimeTeamId } from "../../config/teams";
import type { ManagerDaemon } from "../../agents/manager-daemon";

function ok(data: unknown, status: number = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

function err(message: string, status: number = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function parseTaskConfig(taskConfigStr: string): Record<string, unknown> {
  try {
    return JSON.parse(taskConfigStr || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function registerDataRealtimeTaskRoutes(daemon?: ManagerDaemon): void {
  const scheduler = new TaskScheduler();

  // ---------------------------------------------------------------------------
  // GET routes
  // ---------------------------------------------------------------------------

  addDataRoute("GET", "/data/realtime-tasks", () => {
    const db = getDb();
    const tasks = db
      .prepare("SELECT * FROM tasks WHERE task_type = 'real_time' ORDER BY created_at DESC")
      .all();
    return ok(tasks);
  });

  addDataRoute("GET", "/data/realtime-tasks/:id", (_req, params) => {
    const db = getDb();
    const task = db
      .prepare(
        `SELECT t.*, tm.name AS team_name,
                (SELECT COUNT(*) FROM task_input_streams WHERE task_id = t.id) AS segment_count
         FROM tasks t
         LEFT JOIN teams tm ON tm.id = t.team_id
         WHERE t.id = ? AND t.task_type = 'real_time'`,
      )
      .get(params.id);
    if (!task) return err("Task not found", 404);
    return ok(task);
  });

  addDataRoute("GET", "/data/realtime-tasks/:id/timeline", (_req, params) => {
    const db = getDb();
    const timeline = db
      .prepare("SELECT * FROM realtime_timeline WHERE task_id = ? ORDER BY created_at DESC")
      .all(params.id);
    return ok(timeline);
  });

  addDataRoute("GET", "/data/realtime-tasks/:id/notes", (_req, params) => {
    const db = getDb();
    const notes = db.prepare(
      `SELECT n.id, n.agent_id, COALESCE(a.name, n.agent_id) AS agent_name, n.content, n.created_at
       FROM task_notes n
       LEFT JOIN agents a ON a.id = n.agent_id
       WHERE n.task_id = ?
       ORDER BY n.created_at DESC
       LIMIT 50`,
    ).all(params.id);
    return ok(notes);
  });

  addDataRoute("GET", "/data/realtime-tasks/:id/agents", (_req, params) => {
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
    ).all(params.id);
    return ok(agents);
  });

  addDataRoute("GET", "/data/realtime-tasks/:id/pipeline-status", (_req, params) => {
    const db = getDb();
    const pipelineStatus = db
      .prepare("SELECT * FROM realtime_pipeline_state WHERE task_id = ?")
      .get(params.id);

    if (!pipelineStatus) {
      return ok({
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
      .get(params.id, params.id, params.id, params.id, params.id);

    return ok({ ...pipelineStatus as object, ...counts as object });
  });

  // ---------------------------------------------------------------------------
  // POST/mutation routes
  // ---------------------------------------------------------------------------

  addDataRoute("POST", "/data/realtime-tasks", async (req) => {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title.trim() : null;
    const description = typeof body.description === "string" ? body.description.trim() : null;
    const teamIdRaw = typeof body.teamId === "string" ? body.teamId.trim() : null;

    if (!title) return err("title is required");

    try {
      const db = getDb();
      const resolvedTeamId = teamIdRaw || (() => {
        const preferred = getRealtimeTeamId();
        if (preferred) return preferred;
        const fallback = db.prepare("SELECT id FROM teams ORDER BY created_at, id LIMIT 1").get() as { id: string } | null;
        return fallback?.id ?? undefined;
      })();

      const task = scheduler.createTask({
        title,
        description: description || undefined,
        teamId: resolvedTeamId,
        workingDirectory: process.cwd(),
        taskType: "real_time",
      });

      // Real-time tasks bypass the standard draft→approved→running pipeline
      db.prepare(
        `UPDATE tasks SET status = 'running', approved_at = datetime('now'), started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);

      if (daemon) {
        try {
          daemon.getRealtimeSessionManager().startSession(task.id);
        } catch { /* non-fatal */ }
      }

      return ok(task, 201);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/realtime-tasks/:id", async (req, params) => {
    const db = getDb();
    const task = db
      .prepare("SELECT id, task_type FROM tasks WHERE id = ?")
      .get(params.id) as { id: string; task_type: string } | null;
    if (!task || task.task_type !== "real_time") return err("Task not found", 404);

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title.trim() : null;
    const description = typeof body.description === "string" ? body.description.trim() : null;

    if (!title) return err("title is required");

    db.prepare(
      `UPDATE tasks SET title = ?, description = ?, updated_at = datetime('now') WHERE id = ? AND task_type = 'real_time'`,
    ).run(title, description || null, params.id);

    const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(params.id);
    return ok(updated);
  });

  addDataRoute("POST", "/data/realtime-tasks/:id/start", (_req, params) => {
    try {
      const task = scheduler.getTask(params.id);
      if (!task || task.task_type !== "real_time") return err("Task not found", 404);
      if (task.status !== "approved" && task.status !== "running") {
        return err("Task must be approved or running to start");
      }
      if (!daemon) return err("Daemon not available", 503);

      if (task.status === "approved") scheduler.startTask(params.id);
      daemon.getRealtimeSessionManager().startSession(params.id);
      return ok({ id: params.id, started: true });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/realtime-tasks/:id/stop", async (_req, params) => {
    try {
      if (daemon) {
        const rtMgr = daemon.getRealtimeSessionManager();
        if (rtMgr.isSessionActive(params.id)) {
          await rtMgr.stopSession(params.id);
        }
      }
      return ok({ id: params.id, stopped: true });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/realtime-tasks/:id/resume", (_req, params) => {
    try {
      if (!daemon) return err("Daemon not available", 503);
      daemon.getRealtimeSessionManager().resumeSession(params.id);
      return ok({ id: params.id, resumed: true });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/realtime-tasks/:id/close", (_req, params) => {
    try {
      if (daemon) {
        daemon.getRealtimeSessionManager().closeSession(params.id);
      }
      const task = scheduler.getTask(params.id);
      if (task && task.status === "running") {
        scheduler.completeTask(params.id, { stopped_by: "user" });
      }
      return ok({ id: params.id, closed: true });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/realtime-tasks/:id/delete", (_req, params) => {
    try {
      const task = scheduler.getTask(params.id);
      if (!task) return err("Task not found", 404);

      if (daemon && task.status === "running") {
        daemon.getRealtimeSessionManager().closeSession(params.id);
      }
      if (task.status === "running") {
        scheduler.failTask(params.id, "Deleted by user");
      }
      scheduler.deleteTask(params.id);
      return ok({ id: params.id, deleted: true });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/realtime-tasks/:id/unarchive", (_req, params) => {
    try {
      const db = getDb();
      const task = scheduler.getTask(params.id);
      if (!task) return err("Task not found", 404);
      if (task.status !== "completed" && task.status !== "failed") {
        return err("Only archived or failed tasks can be unarchived");
      }

      db.prepare(
        "UPDATE tasks SET status = 'running', result = NULL, completed_at = NULL, updated_at = datetime('now') WHERE id = ?",
      ).run(params.id);

      if (daemon) {
        const rtMgr = daemon.getRealtimeSessionManager();
        if (!rtMgr.isSessionActive(params.id)) {
          rtMgr.resumeSession(params.id);
        }
      }
      return ok({ id: params.id, unarchived: true });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/realtime-tasks/:id/input", async (req, params) => {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const text = typeof body.text === "string" ? body.text.trim() : null;

    if (!text) return err("text is required");
    if (!daemon) return err("Daemon not available", 503);

    const rtMgr = daemon.getRealtimeSessionManager();
    if (!rtMgr.isSessionActive(params.id)) {
      return err("Session is paused. Resume the task first.");
    }

    try {
      await rtMgr.ingestInput(params.id, { sourceType: "text", contentBody: text });
      return ok({ id: params.id, ingested: true });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/realtime-tasks/:id/config", async (req, params) => {
    const db = getDb();
    const task = db
      .prepare("SELECT id, task_config FROM tasks WHERE id = ? AND task_type = 'real_time'")
      .get(params.id) as { id: string; task_config: string } | null;
    if (!task) return err("Task not found", 404);

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const summarizerAgentId = typeof body.summarizer_agent_id === "string" ? body.summarizer_agent_id : "";
    const assignedAgentIds = Array.isArray(body.assigned_agent_ids) ? (body.assigned_agent_ids as string[]) : [];

    const existingConfig = parseTaskConfig(task.task_config);
    const newConfig = {
      ...existingConfig,
      summarizer_agent_id: summarizerAgentId || undefined,
      assigned_agent_ids: assignedAgentIds.length > 0 ? assignedAgentIds : undefined,
    };

    db.prepare("UPDATE tasks SET task_config = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(newConfig), params.id);

    return ok({ id: params.id, config: newConfig });
  });
}
