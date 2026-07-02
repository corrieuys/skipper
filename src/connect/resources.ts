import type { TaskScheduler } from "../tasks/scheduler";
import type { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import type { EscalationManager } from "../escalations/manager";
import type { ArtifactManager } from "../orchestrator/artifact-manager";
import type { PhaseManager } from "../orchestrator/phase-manager";
import { fetchTaskNotes, fetchTaskArtifacts } from "../data/queries";
import { getDb } from "../db/connection";
import { looksLikeHtml } from "../html/atoms/sniff-html";
import { getPublicArtifactUrl } from "./public-links";

export interface ResourceDeps {
  taskScheduler: TaskScheduler;
  scheduledTaskScheduler: ScheduledTaskScheduler;
  escalationManager: EscalationManager;
  artifactManager: ArtifactManager;
  phaseManager: PhaseManager;
}

export type ResourceResult = { ok: true; data: unknown } | { ok: false; error: string };

export async function handleResourceRequest(
  resource: string,
  action: string,
  params: Record<string, unknown>,
  deps: ResourceDeps,
): Promise<ResourceResult> {
  try {
    const { taskScheduler, scheduledTaskScheduler, escalationManager, phaseManager } = deps;
    const db = getDb();

    switch (resource) {
      case "tasks": {
        switch (action) {
          case "list":
            return { ok: true, data: taskScheduler.listTasks() };
          case "read":
            return { ok: true, data: taskScheduler.getTask(String(params.id ?? "")) };
          case "create":
            return {
              ok: true,
              data: taskScheduler.createTask({
                title: String(params.title ?? ""),
                description: params.description != null ? String(params.description) : undefined,
                teamId: params.teamId != null ? String(params.teamId) : undefined,
                workingDirectory: params.workingDirectory != null ? String(params.workingDirectory) : process.cwd(),
              }),
            };
          case "delete":
            return { ok: true, data: { deleted: taskScheduler.deleteTask(String(params.id ?? "")) } };
          case "approve":
            return { ok: true, data: taskScheduler.approveTask(String(params.id ?? "")) };
          case "run-recurring":
            return { ok: true, data: scheduledTaskScheduler.runTaskNow(String(params.id ?? ""), taskScheduler) };
          case "resume": {
            // Unlike the HTTP routes, paused->running via this path does NOT respawn agents (daemon not injected).
            const id = String(params.id ?? "");
            if (!id) return { ok: false, error: "id is required" };
            const task = taskScheduler.getTask(id);
            if (!task) return { ok: false, error: "Task not found" };
            if (task.status === "failed") return { ok: true, data: taskScheduler.resumeTask(id) };
            if (task.status === "paused") return { ok: true, data: taskScheduler.resumeFromPause(id) };
            return { ok: false, error: `Cannot resume task with status: ${task.status}` };
          }
          case "retry": {
            const id = String(params.id ?? "");
            if (!id) return { ok: false, error: "id is required" };
            return { ok: true, data: taskScheduler.retryTask(id) };
          }
          case "complete": {
            // Unlike POST /api/tasks/:id/complete, this cannot kill live agent processes (daemon not injected).
            const id = String(params.id ?? "");
            if (!id) return { ok: false, error: "id is required" };
            return { ok: true, data: taskScheduler.completeTask(id, "Manually completed via Skipper Connect") };
          }
          case "iterate": {
            const id = String(params.id ?? "");
            const additionalInput = String(params.additionalInput ?? "");
            if (!id) return { ok: false, error: "id is required" };
            if (!additionalInput.trim()) return { ok: false, error: "additionalInput is required" };
            return { ok: true, data: taskScheduler.iterateTask(id, additionalInput) };
          }
          default:
            return { ok: false, error: `Unknown tasks action: ${action}` };
        }
      }

      case "escalations": {
        const status = params.status;
        switch (action) {
          case "list":
            return {
              ok: true,
              data: escalationManager.listEscalations(
                status === "open" || status === "resolved" ? status : undefined,
              ),
            };
          case "read":
            return { ok: true, data: escalationManager.getEscalation(String(params.id ?? "")) };
          case "respond": {
            // Resolve/respond to an open escalation with an operator message.
            // params: { id: string, message: string }
            const id = String(params.id ?? "");
            const message = String(params.message ?? "");
            if (!id) return { ok: false, error: "id is required" };
            if (!message) return { ok: false, error: "message is required" };
            const resolved = await escalationManager.resolveEscalation(id, message);
            return { ok: true, data: resolved };
          }
          default:
            return { ok: false, error: `Unknown escalations action: ${action}` };
        }
      }

      case "reviews": {
        switch (action) {
          case "list":
            return { ok: true, data: taskScheduler.listTasks().filter((t) => t.needs_review) };
          case "read":
            return { ok: true, data: taskScheduler.getTask(String(params.id ?? "")) };
          case "approve": {
            // Approve a pending phase review and advance the phase.
            // params: { taskId: string, message?: string }
            const taskId = String(params.taskId ?? params.id ?? "");
            if (!taskId) return { ok: false, error: "taskId is required" };
            const note = params.message != null ? String(params.message) : undefined;
            await phaseManager.approveReview(taskId, note);
            return { ok: true, data: { taskId, approved: true } };
          }
          case "reject": {
            // Reject a pending phase review and regress the phase.
            // params: { taskId: string, message?: string }
            const taskId = String(params.taskId ?? params.id ?? "");
            if (!taskId) return { ok: false, error: "taskId is required" };
            const reason = params.message != null ? String(params.message) : undefined;
            await phaseManager.rejectReview(taskId, reason);
            return { ok: true, data: { taskId, rejected: true } };
          }
          default:
            return { ok: false, error: `Unknown reviews action: ${action}` };
        }
      }

      case "notes": {
        if (action !== "list") return { ok: false, error: `Unknown notes action: ${action}` };
        // Support both "taskId" and "id" param names for robustness.
        const taskId = String(params.taskId ?? params.id ?? "");
        const raw = fetchTaskNotes(db, taskId);
        return {
          ok: true,
          data: raw.map((n) => ({
            id: n.id,
            taskId: n.task_id,
            agentName: n.agent_name ?? null,
            content: n.content,
            createdAt: n.created_at,
          })),
        };
      }

      case "artifacts": {
        if (action === "read") {
          // Fetch one artifact WITH body.
          // params: { taskId, name, version? } — version omitted → latest.
          // Also accepts { id } to fetch by primary key.
          const { artifactManager } = deps;
          if (params.id) {
            const artifact = artifactManager.getArtifactById(String(params.id));
            if (!artifact) return { ok: false, error: "Artifact not found" };
            return {
              ok: true,
              data: {
                id: artifact.id,
                taskId: artifact.task_id,
                name: artifact.name,
                kind: artifact.kind,
                version: artifact.version,
                description: artifact.description ?? null,
                body: artifact.body,
                createdAt: artifact.created_at,
                publishedAt: artifact.published_at,
                publicUrl: artifact.published_at ? getPublicArtifactUrl(db, artifact) : null,
              },
            };
          }
          const taskId = String(params.taskId ?? "");
          const name = String(params.name ?? "");
          if (!taskId || !name) return { ok: false, error: "taskId and name (or id) are required" };
          const version = params.version != null ? (Number(params.version) as "latest" | number) : "latest";
          const artifact = artifactManager.getArtifact(taskId, name, version);
          if (!artifact) return { ok: false, error: "Artifact not found" };
          return {
            ok: true,
            data: {
              id: artifact.id,
              taskId: artifact.task_id,
              name: artifact.name,
              kind: artifact.kind,
              version: artifact.version,
              description: artifact.description ?? null,
              body: artifact.body,
              createdAt: artifact.created_at,
              publishedAt: artifact.published_at,
              publicUrl: artifact.published_at ? getPublicArtifactUrl(db, artifact) : null,
            },
          };
        }
        if (action === "publish" || action === "unpublish") {
          // params: { id } or { taskId, name, version? } — version omitted → latest.
          const { artifactManager } = deps;
          let target = params.id ? artifactManager.getArtifactById(String(params.id)) : null;
          if (!target) {
            const taskId = String(params.taskId ?? "");
            const name = String(params.name ?? "");
            if (!taskId || !name) return { ok: false, error: "id, or taskId and name, are required" };
            const version = params.version != null ? (Number(params.version) as "latest" | number) : "latest";
            target = artifactManager.getArtifact(taskId, name, version);
          }
          if (!target) return { ok: false, error: "Artifact not found" };
          const updated = action === "publish"
            ? artifactManager.publishArtifact(target.id)
            : artifactManager.unpublishArtifact(target.id);
          if (!updated) return { ok: false, error: "Artifact not found" };
          return {
            ok: true,
            data: {
              id: updated.id,
              taskId: updated.task_id,
              name: updated.name,
              version: updated.version,
              publishedAt: updated.published_at,
              publicUrl: updated.published_at ? getPublicArtifactUrl(db, updated) : null,
            },
          };
        }
        if (action === "read-published") {
          // Relay target for the integrator's unauthenticated public route
          // (GET /p/:guid/:artifactId?key=...). Authed by the per-version
          // publish key only; one opaque error for wrong id, wrong key, or
          // unpublished so the public route cannot enumerate artifacts.
          const { artifactManager } = deps;
          const artifact = artifactManager.getPublishedArtifact(String(params.id ?? ""), String(params.key ?? ""));
          if (!artifact) return { ok: false, error: "Not found or not published" };
          return {
            ok: true,
            data: {
              name: artifact.name,
              kind: artifact.kind,
              version: artifact.version,
              body: artifact.body,
              contentType: looksLikeHtml(artifact.body) ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
            },
          };
        }
        if (action !== "list") return { ok: false, error: `Unknown artifacts action: ${action}` };
        // Support both "taskId" and "id" param names for robustness.
        const taskId = String(params.taskId ?? params.id ?? "");
        const raw = fetchTaskArtifacts(db, taskId);
        return {
          ok: true,
          data: raw.map((a) => ({
            id: a.id,
            name: a.name,
            kind: a.kind,
            version: a.version,
            description: a.description ?? null,
            createdAt: a.created_at,
          })),
        };
      }

      case "outputs": {
        if (action !== "list") return { ok: false, error: `Unknown outputs action: ${action}` };
        // Last N agent output lines for a task, newest-first.
        // Source: terminal_outputs joined through agent_instances (task_id).
        // params: { taskId, limit? } — limit capped at 100, default 10.
        const taskId = String(params.taskId ?? params.id ?? "");
        if (!taskId) return { ok: false, error: "taskId is required" };
        const limit = Math.min(Number(params.limit) || 10, 100);
        type OutputRow = { id: number; agent_name: string | null; stream: string; data: string; created_at: string };
        const rows = db
          .prepare(
            `SELECT tout.id, a.name AS agent_name, tout.stream, tout.data, tout.created_at
             FROM terminal_outputs tout
             LEFT JOIN agent_instances ai ON ai.id = tout.agent_id
             LEFT JOIN agents a ON a.id = ai.template_agent_id
             WHERE ai.task_id = ?
             ORDER BY tout.created_at DESC, tout.id DESC
             LIMIT ?`,
          )
          .all(taskId, limit) as OutputRow[];
        return {
          ok: true,
          data: rows.map((r) => ({
            id: r.id,
            agentName: r.agent_name ?? null,
            stream: r.stream,
            content: r.data,
            createdAt: r.created_at,
          })),
        };
      }

      default:
        return { ok: false, error: `Unknown resource: ${resource}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
