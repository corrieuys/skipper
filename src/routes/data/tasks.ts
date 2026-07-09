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
import type { ManagerDaemon } from "../../agents/manager-daemon";

function ok(data: unknown, status: number = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

function err(message: string, status: number = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export function registerDataTaskRoutes(
  _daemon?: Pick<ManagerDaemon, "getAgentManager" | "getRealtimeSessionManager">,
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
