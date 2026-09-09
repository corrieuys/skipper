import type { Database } from "bun:sqlite";
import { addRoute } from "../server";
import { isExperimental } from "../config/feature-flags";
import type { TaskScheduler } from "../tasks/scheduler";
import type { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import type { TaskMemoryManager } from "../task-memory/manager";
import { isMemoryMode, resolveMemoryScope, seriesScopeId, taskScopeId } from "../task-memory/scope";
import type { EmbeddingServerManager } from "../task-memory/local-server";
import { getTaskMemoryConfig, saveTaskMemoryConfig } from "../task-memory/settings";
import { isEmbedder, resolveEmbedder } from "../task-memory/embeddings";
import { taskMemoryStatusFragment, type TaskMemoryPanelData } from "../html/fragments/task-memory-config.fragment";
import { htmlResponse, hxRedirect, parseRequestBody } from "./utils";

/**
 * Task memory routes (experimental, 404 without the flag):
 *   POST /api/tasks/:id/memory            flip a one-off task's toggle; on = backfill (runs: 400, series-managed)
 *   POST /api/tasks/:id/memory/clear      hard-delete the task's memory scope (a run clears its series' shared scope)
 *   POST /api/scheduled-tasks/:id/memory  series mode (off|run|shared) + retention days; shared backfills every run
 *   POST /api/scheduled-tasks/:id/memory/clear
 *   POST /api/config/task-memory          save the embeddings settings
 *   GET  /api/config/task-memory/status   status fragment (polled during downloads)
 *   POST /api/config/task-memory/download install server binary + selected model
 *   POST /api/config/task-memory/start|stop   (start is async: fragment polls)
 */
export interface TaskMemoryRouteDeps {
  db: Database;
  scheduler: TaskScheduler;
  scheduledScheduler: ScheduledTaskScheduler;
  taskMemory: TaskMemoryManager;
  embeddingServer: EmbeddingServerManager;
}

export function buildTaskMemoryPanelData(deps: Pick<TaskMemoryRouteDeps, "db" | "taskMemory" | "embeddingServer">): TaskMemoryPanelData {
  const config = getTaskMemoryConfig(deps.db);
  const embedder = resolveEmbedder(deps.db, deps.embeddingServer);
  return {
    config,
    local: deps.embeddingServer.getStatus(config.localModelId),
    unavailable: isEmbedder(embedder) ? null : embedder.reason,
    lastEmbedError: deps.taskMemory.getLastEmbedError(),
  };
}

export function registerTaskMemoryRoutes(deps: TaskMemoryRouteDeps): void {
  const { db, scheduler, scheduledScheduler, taskMemory, embeddingServer } = deps;
  const notFound = () => new Response("not found", { status: 404 });
  const status = () => htmlResponse(taskMemoryStatusFragment(buildTaskMemoryPanelData(deps)));

  addRoute("POST", "/api/tasks/:id/memory", async (req, params) => {
    if (!isExperimental()) return notFound();
    const id = String(params.id ?? "");
    try {
      const task = scheduler.getTask(id);
      if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
      if (task.source_scheduled_task_id) {
        return Response.json({ error: "Memory for a recurring run is set on the recurring task, not on the run" }, { status: 400 });
      }
      const body = await parseRequestBody(req);
      const raw = body.on ?? body.memory;
      const on = raw === true || raw === "true" || raw === "on" || raw === "1";
      scheduler.setMemoryEnabled(id, on);
      let backfilled = 0;
      if (on) backfilled = taskMemory.backfill(id);
      if (req.headers.get("HX-Request")) {
        return hxRedirect(`/?task=${id}`);
      }
      return Response.json({ ok: true, memory_enabled: on, backfilled });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/tasks/:id/memory/clear", (req, params) => {
    if (!isExperimental()) return notFound();
    const id = String(params.id ?? "");
    const task = scheduler.getTask(id);
    if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
    const scope = resolveMemoryScope(db, id);
    const cleared = taskMemory.clearScope(scope.scopeId ?? taskScopeId(id));
    if (req.headers.get("HX-Request")) return hxRedirect(`/?task=${id}`);
    return Response.json({ ok: true, cleared });
  });

  addRoute("POST", "/api/scheduled-tasks/:id/memory", async (req, params) => {
    if (!isExperimental()) return notFound();
    const id = String(params.id ?? "");
    try {
      const body = await parseRequestBody<Record<string, unknown>>(req);
      const modeRaw = body.mode ?? body.memoryMode;
      const daysRaw = body.retention_days ?? body.retentionDays ?? body.memoryRetentionDays;
      if (modeRaw !== undefined && !isMemoryMode(modeRaw)) {
        return Response.json({ error: "mode must be off, run, or shared" }, { status: 400 });
      }
      const retentionDays = daysRaw === undefined || daysRaw === "" ? undefined : Number(daysRaw);
      const updated = scheduledScheduler.setMemoryConfig(id, { mode: modeRaw as never, retentionDays });
      let backfilled = 0;
      if (updated.task_config.memory_mode === "shared") backfilled = taskMemory.backfillSeries(id);
      else taskMemory.prune(seriesScopeId(id), 0);
      if (req.headers.get("HX-Request")) return hxRedirect(`/?scheduled=${id}`);
      return Response.json({ ok: true, memory_mode: updated.task_config.memory_mode ?? "off", retention_days: updated.task_config.memory_retention_days ?? 0, backfilled });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/scheduled-tasks/:id/memory/clear", (req, params) => {
    if (!isExperimental()) return notFound();
    const id = String(params.id ?? "");
    if (!scheduledScheduler.getScheduledTask(id)) return Response.json({ error: "Recurring task not found" }, { status: 404 });
    const cleared = taskMemory.clearScope(seriesScopeId(id));
    if (req.headers.get("HX-Request")) return hxRedirect(`/?scheduled=${id}`);
    return Response.json({ ok: true, cleared });
  });

  addRoute("POST", "/api/config/task-memory", async (req) => {
    if (!isExperimental()) return notFound();
    const body = await parseRequestBody<Record<string, string>>(req);
    const previous = getTaskMemoryConfig(db);
    const err = saveTaskMemoryConfig(db, {
      endpoint: body.endpoint,
      localModelId: body.local_model,
      customBaseUrl: body.custom_base_url,
      customApiKey: body.custom_api_key,
      customModel: body.custom_model,
    });
    if (err) return new Response(err, { status: 400 });
    const next = getTaskMemoryConfig(db);
    // A different local model needs a fresh server; the next embed restarts it.
    if (embeddingServer.isRunning() && (next.endpoint !== "local" || next.localModelId !== previous.localModelId)) {
      embeddingServer.stop();
    }
    // Rows embedded under the old model are re-embedded lazily; kick it now.
    taskMemory.scheduleFlush();
    return new Response(null, { status: 204 });
  });

  addRoute("GET", "/api/config/task-memory/status", () => {
    if (!isExperimental()) return notFound();
    return status();
  });

  addRoute("POST", "/api/config/task-memory/download", () => {
    if (!isExperimental()) return notFound();
    const config = getTaskMemoryConfig(db);
    if (!embeddingServer.isDownloading()) {
      // Fire and forget: the status fragment polls progress. Binary first, then
      // the selected model; either may already be present.
      void (async () => {
        try {
          if (!embeddingServer.isBinaryInstalled()) await embeddingServer.installBinary();
          if (!embeddingServer.isModelInstalled(config.localModelId)) await embeddingServer.installModel(config.localModelId);
          taskMemory.scheduleFlush();
        } catch (err) {
          console.error(`[task-memory] download failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }
    // Render after the download has registered so the fragment shows progress + polls.
    return new Promise<Response>((resolve) => setTimeout(() => resolve(status()), 50));
  });

  addRoute("POST", "/api/config/task-memory/start", () => {
    if (!isExperimental()) return notFound();
    const config = getTaskMemoryConfig(db);
    // Loading a model can take tens of seconds; do not hold the request. The
    // fragment comes back in the "starting" state and polls until healthy
    // (or shows the recorded error).
    if (!embeddingServer.isRunning() && !embeddingServer.isStarting()) {
      void embeddingServer.ensureRunning(config.localModelId)
        .then(() => taskMemory.scheduleFlush())
        .catch((err) => console.error(`[task-memory] start failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return new Promise<Response>((resolve) => setTimeout(() => resolve(status()), 50));
  });

  addRoute("POST", "/api/config/task-memory/stop", () => {
    if (!isExperimental()) return notFound();
    embeddingServer.stop();
    return status();
  });
}
