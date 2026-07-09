import { addDataRoute } from "./auth";
import { getDb } from "../../db/connection";
import {
  fetchTasksWithTeams,
  fetchTaskById,
  fetchTaskDelegations,
  fetchTaskNotes,
  fetchTaskForensics,
} from "../../data/queries";
import { TaskScheduler } from "../../tasks/scheduler";
import { finalizeActiveInstancesForTask } from "../../agents/instance-status";
import type { TaskType, RealtimeTaskConfig } from "../../tasks/scheduler";
import { ArtifactManager } from "../../orchestrator/artifact-manager";
import { parseRequestBody } from "../utils";
import { eventBus } from "../../events/bus";
import type { ManagerDaemon } from "../../agents/manager-daemon";

function ok(data: unknown, status: number = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

function err(message: string, status: number = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export function registerDataTaskRoutes(
  _daemon?: Pick<ManagerDaemon, "getAgentManager" | "getRealtimeSessionManager" | "getPhaseManager">,
): void {
  const scheduler = new TaskScheduler();
  const artifactManager = new ArtifactManager();

  // ---------------------------------------------------------------------------
  // GET routes
  // ---------------------------------------------------------------------------

  addDataRoute("GET", "/data/tasks", () => {
    const db = getDb();
    return ok(fetchTasksWithTeams(db));
  });

  addDataRoute("GET", "/data/tasks/:id", (_req, params) => {
    const db = getDb();
    const task = fetchTaskById(db, params.id);
    if (!task) return err("Task not found", 404);
    return ok(task);
  });

  addDataRoute("GET", "/data/tasks/:id/phases", (_req, params) => {
    const db = getDb();
    const task = fetchTaskById(db, params.id);
    if (!task) return err("Task not found", 404);
    return ok({ phases: (task as unknown as Record<string, unknown>).phases ?? [] });
  });

  addDataRoute("GET", "/data/tasks/:id/delegations", (_req, params) => {
    const db = getDb();
    const task = fetchTaskById(db, params.id);
    if (!task) return err("Task not found", 404);
    return ok(fetchTaskDelegations(db, params.id));
  });

  addDataRoute("GET", "/data/tasks/:id/notes", (_req, params) => {
    const db = getDb();
    return ok(fetchTaskNotes(db, params.id));
  });

  addDataRoute("GET", "/data/tasks/:id/artifacts", (req, params) => {
    const url = new URL(req.url);
    const kind = url.searchParams.get("kind") ?? undefined;
    const name = url.searchParams.get("name") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    const artifacts = artifactManager.listArtifacts({ taskId: params.id, kind, namePrefix: name, limit });
    return ok(artifacts);
  });

  addDataRoute("GET", "/data/tasks/:id/artifacts/:name", (req, params) => {
    const url = new URL(req.url);
    const versionParam = url.searchParams.get("version") ?? "latest";
    const version: "latest" | number = versionParam === "latest" ? "latest" : parseInt(versionParam, 10);
    const artifact = artifactManager.getArtifact(params.id, params.name, version);
    if (!artifact) return err("Artifact not found", 404);
    return ok(artifact);
  });

  addDataRoute("GET", "/data/tasks/:id/forensics", (_req, params) => {
    const db = getDb();
    const task = fetchTaskById(db, params.id);
    if (!task) return err("Task not found", 404);
    return ok(fetchTaskForensics(db, params.id));
  });

  addDataRoute("GET", "/data/tasks/:id/review", (_req, params) => {
    const db = getDb();
    const task = fetchTaskById(db, params.id) as (Record<string, unknown> & {
      phases?: Array<{ name: string }> | null;
    }) | null;
    if (!task) return err("Task not found", 404);
    const currentPhase = Number(task.current_phase ?? 0);
    const phase = task.phases?.[currentPhase];
    return ok({
      needs_review: !!task.needs_review,
      status: task.status,
      current_phase: currentPhase,
      phase: phase ? { index: currentPhase, name: phase.name } : null,
    });
  });

  // ---------------------------------------------------------------------------
  // POST/mutation routes
  // ---------------------------------------------------------------------------

  addDataRoute("POST", "/data/tasks", async (req) => {
    const body = await parseRequestBody<Record<string, string>>(req);

    if (!body.title || !body.title.trim()) {
      return err("title is required");
    }

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

    try {
      const created = scheduler.createTask({
        title: body.title.trim(),
        description: body.description?.trim() || undefined,
        teamId: body.teamId?.trim() || undefined,
        workingDirectory: body.workingDirectory?.trim() || process.cwd(),
        taskType,
        taskConfig,
      });
      return ok(created, 201);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/tasks/:id", async (req, params) => {
    const body = await parseRequestBody<Record<string, string>>(req);

    if (!body.title || !body.title.trim()) {
      return err("title is required");
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
        title: body.title.trim(),
        description: body.description,
        teamId: body.teamId,
        taskType,
        taskConfig,
      });
      return ok(updated);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/tasks/:id/approve", (_req, params) => {
    try {
      scheduler.approveTask(params.id);
      return ok({ id: params.id, status: "approved" });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/tasks/:id/unapprove", (_req, params) => {
    try {
      scheduler.unapproveTask(params.id);
      return ok({ id: params.id, status: "draft" });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/tasks/:id/cancel", (_req, params) => {
    try {
      if (_daemon) {
        const rtMgr = _daemon.getRealtimeSessionManager();
        if (rtMgr.isSessionActive(params.id)) {
          rtMgr.closeSession(params.id);
        }
        const agentManager = _daemon.getAgentManager();
        const runtimeIds = Array.from(agentManager.getRunningAgents().values())
          .filter((runtime) => runtime.taskId === params.id)
          .map((runtime) => runtime.id);
        for (const runtimeId of runtimeIds) {
          try { agentManager.killAgent(runtimeId); } catch { /* best-effort */ }
        }
      }
      scheduler.cancelTask(params.id);
      return ok({ id: params.id, status: "cancelled" });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/tasks/:id/retry", (_req, params) => {
    try {
      scheduler.retryTask(params.id);
      return ok({ id: params.id });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/tasks/:id/resume", (_req, params) => {
    try {
      scheduler.resumeTask(params.id);
      return ok({ id: params.id });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/tasks/:id/iterate", async (req, params) => {
    try {
      const body = await parseRequestBody<Record<string, string>>(req);
      const additionalInput = body.additionalInput || body.additional_input;
      if (!additionalInput) {
        return err("additionalInput is required");
      }
      const updated = scheduler.iterateTask(params.id, additionalInput);
      return ok(updated);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/tasks/:id/delete", (_req, params) => {
    try {
      scheduler.deleteTask(params.id);
      return ok({ id: params.id, deleted: true });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  // --- Phase review gate ---

  // Optional { message } body, JSON or form; absent/malformed body is fine.
  async function readOptionalMessage(req: Request): Promise<string | undefined> {
    try {
      const body = await parseRequestBody<Record<string, string>>(req);
      const msg = body.message;
      return typeof msg === "string" && msg.trim() ? msg.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  for (const action of ["approve", "reject"] as const) {
    addDataRoute("POST", `/data/tasks/:id/review/${action}`, async (req, params) => {
      if (!_daemon) return err("Daemon not available", 503);
      const task = scheduler.getTask(params.id);
      if (!task) return err("Task not found", 404);
      // PhaseManager silently no-ops outside this state — surface it instead.
      if (task.status !== "running" || !task.needs_review) {
        return err("Task is not awaiting review", 409);
      }
      const message = await readOptionalMessage(req);
      try {
        const pm = _daemon.getPhaseManager();
        if (action === "approve") await pm.approveReview(params.id, message);
        else await pm.rejectReview(params.id, message);
        return ok({ id: params.id, review: action === "approve" ? "approved" : "rejected" });
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : "Internal error");
      }
    });
  }

  // --- Notes ---

  addDataRoute("POST", "/data/tasks/:id/notes", async (req, params) => {
    const body = await parseRequestBody<{ content?: string }>(req);
    if (!body.content || !body.content.trim()) return err("content is required");

    const db = getDb();
    const task = scheduler.getTask(params.id);
    if (!task) return err("Task not found", 404);

    // Use the team entrypoint agent to satisfy the FK in monolith mode;
    // 'user' fallback matches /api/tasks/:id/notes.
    let agentId = "user";
    try {
      if (task.team_id) {
        const teamRow = db
          .prepare("SELECT entrypoint_agent_id FROM teams WHERE id = ?")
          .get(task.team_id) as { entrypoint_agent_id: string | null } | null;
        if (teamRow?.entrypoint_agent_id) agentId = teamRow.entrypoint_agent_id;
      }
    } catch { /* fallback to 'user' */ }

    const noteId = crypto.randomUUID();
    const content = body.content.trim();
    try {
      db.prepare(
        "INSERT INTO task_notes (id, task_id, agent_id, content, source) VALUES (?, ?, ?, ?, 'user')",
      ).run(noteId, params.id, agentId, content);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error", 500);
    }

    eventBus.emit("task:note_added", { noteId, taskId: params.id, agentId, content });

    const note = db
      .prepare("SELECT n.*, a.name AS agent_name FROM task_notes n LEFT JOIN agents a ON a.id = n.agent_id WHERE n.id = ?")
      .get(noteId);
    return ok(note, 201);
  });

  addDataRoute("DELETE", "/data/tasks/:id/notes/:noteId", (_req, params) => {
    // Soft delete — deleted notes stay visible in the UI but are excluded
    // from agent context injection (same semantics as the /api route).
    const result = getDb()
      .prepare("UPDATE task_notes SET deleted_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ? AND task_id = ?")
      .run(params.noteId, params.id);
    if (result.changes === 0) return err("Note not found", 404);
    return ok({ id: params.noteId, deleted: true });
  });

  // --- Artifact create (reads live above with the other GETs) ---

  addDataRoute("POST", "/data/tasks/:id/artifacts", async (req, params) => {
    const body = await parseRequestBody<Record<string, string>>(req);
    if (!body.name?.trim()) return err("name is required");
    if (!body.kind?.trim()) return err("kind is required");
    if (typeof body.body !== "string" || !body.body) return err("body is required");
    const task = scheduler.getTask(params.id);
    if (!task) return err("Task not found", 404);
    try {
      const artifact = artifactManager.createArtifact({
        taskId: params.id,
        name: body.name.trim(),
        kind: body.kind.trim() as Parameters<typeof artifactManager.createArtifact>[0]["kind"],
        body: body.body,
        description: body.description?.trim() || undefined,
        createdByAgentId: "api",
      });
      return ok(artifact, 201);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  addDataRoute("POST", "/data/tasks/:id/clear-stale", (_req, params) => {
    try {
      const db = getDb();
      db.prepare(
        "UPDATE agents SET current_task_id = NULL, process_pid = NULL WHERE current_task_id = ?",
      ).run(params.id);
      finalizeActiveInstancesForTask(db, params.id, "failed");
      return ok({ id: params.id, cleared: true });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });
}
