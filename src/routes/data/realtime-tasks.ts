import { addDataRoute } from "./auth";
import { getDb } from "../../db/connection";
import {
  fetchRealtimeTimeline,
  fetchRealtimeNotes,
  fetchRealtimeTaskAgents,
  fetchRealtimePipelineStatus,
  EMPTY_PIPELINE_COUNTS,
} from "../../data/realtime";
import { TaskScheduler } from "../../tasks/scheduler";
import { finalizeActiveInstancesForTask } from "../../agents/instance-status";
import { getRealtimeTeamId } from "../../config/teams";
import type { ManagerDaemon } from "../../agents/manager-daemon";
import { ok, err } from "./envelope";

function parseTaskConfig(taskConfigStr: string): Record<string, unknown> {
  try {
    return JSON.parse(taskConfigStr || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Legacy /data/realtime-tasks/* surface kept as thin wrappers over the unified
// task model so older clients (iOS) keep working. Session, input, and read
// endpoints work for ANY task; create makes a conversational-mode task.
export function registerDataRealtimeTaskRoutes(daemon?: ManagerDaemon): void {
  const scheduler = new TaskScheduler();

  // ---------------------------------------------------------------------------
  // GET routes
  // ---------------------------------------------------------------------------

  addDataRoute("GET", "/data/realtime-tasks", () => {
    const db = getDb();
    const tasks = db
      .prepare("SELECT * FROM tasks WHERE mode = 'conversational' ORDER BY created_at DESC")
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
         WHERE t.id = ?`,
      )
      .get(params.id);
    if (!task) return err("Task not found", 404);
    return ok(task);
  });

  addDataRoute("GET", "/data/realtime-tasks/:id/timeline", (_req, params) => {
    const db = getDb();
    return ok(fetchRealtimeTimeline(db, params.id));
  });

  addDataRoute("GET", "/data/realtime-tasks/:id/notes", (_req, params) => {
    const db = getDb();
    return ok(fetchRealtimeNotes(db, params.id));
  });

  addDataRoute("GET", "/data/realtime-tasks/:id/agents", (_req, params) => {
    const db = getDb();
    return ok(fetchRealtimeTaskAgents(db, params.id));
  });

  addDataRoute("GET", "/data/realtime-tasks/:id/pipeline-status", (_req, params) => {
    const db = getDb();
    const pipelineStatus = fetchRealtimePipelineStatus(db, params.id);
    if (!pipelineStatus) return ok(EMPTY_PIPELINE_COUNTS);
    return ok(pipelineStatus);
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
        mode: "conversational",
      });

      // Conversational tasks go live immediately: approve (draft to active)
      // and open the input session.
      const approved = scheduler.approveTask(task.id);

      if (daemon) {
        try {
          daemon.getRealtimeSessionManager().startSession(task.id);
        } catch { /* non-fatal */ }
      }

      return ok(approved, 201);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/realtime-tasks/:id", async (req, params) => {
    const task = scheduler.getTask(params.id);
    if (!task) return err("Task not found", 404);

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title.trim() : null;
    const description = typeof body.description === "string" ? body.description.trim() : null;

    if (!title) return err("title is required");

    try {
      // Draft-only edit via the unified scheduler; preserve team/config.
      const updated = scheduler.updateTask(params.id, {
        title,
        description: description || undefined,
        teamId: task.team_id ?? undefined,
        workingDirectory: task.working_directory,
        mode: "conversational",
        taskConfig: task.task_config,
      });
      return ok(updated);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/realtime-tasks/:id/start", (_req, params) => {
    try {
      const task = scheduler.getTask(params.id);
      if (!task) return err("Task not found", 404);
      if (task.status !== "active") {
        return err("Task must be active to start a session");
      }
      if (!daemon) return err("Daemon not available", 503);

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
      if (task && task.status === "active") {
        scheduler.settleTask(params.id, { result: { stopped_by: "user" } });
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

      // Kill first so deleteTask does not reject a task with live agents.
      if (task.status === "active") {
        if (daemon) {
          const rtMgr = daemon.getRealtimeSessionManager();
          if (rtMgr.isSessionActive(params.id)) {
            rtMgr.closeSession(params.id);
          }
          const agentManager = daemon.getAgentManager();
          const runtimeIds = Array.from(agentManager.getRunningAgents().values())
            .filter((runtime) => runtime.taskId === params.id)
            .map((runtime) => runtime.id);
          for (const runtimeId of runtimeIds) {
            try { agentManager.killAgent(runtimeId); } catch { /* best-effort */ }
          }
        }
        try { finalizeActiveInstancesForTask(getDb(), params.id, "failed"); } catch { /* best-effort */ }
      }
      scheduler.deleteTask(params.id);
      return ok({ id: params.id, deleted: true });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/realtime-tasks/:id/unarchive", (_req, params) => {
    try {
      const task = scheduler.getTask(params.id);
      if (!task) return err("Task not found", 404);
      if (task.status !== "settled") {
        return err("Only settled tasks can be revived");
      }

      scheduler.reviveTask(params.id);

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

    try {
      const result = await daemon.inputTask(params.id, text, "api");
      return ok({ id: params.id, ingested: true, delivered: result.delivered });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/realtime-tasks/:id/config", async (req, params) => {
    const db = getDb();
    const task = db
      .prepare("SELECT id, task_config FROM tasks WHERE id = ?")
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
