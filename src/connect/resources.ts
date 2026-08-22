import type { TaskScheduler } from "../tasks/scheduler";
import type { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import type { EscalationManager } from "../escalations/manager";
import type { ArtifactManager } from "../orchestrator/artifact-manager";
import type { PhaseManager } from "../orchestrator/phase-manager";
import { timingSafeEqual } from "crypto";
import { fetchTaskNotes, fetchTaskArtifacts } from "../data/queries";
import { fetchScheduledTaskRows, fetchRecentScheduledRuns } from "../data/command-center";
import { MessageManager } from "../messages/manager";
import { TeamManager } from "../teams/manager";
import { getDb } from "../db/connection";
import { eventBus } from "../events/bus";
import { looksLikeHtml } from "../html/atoms/sniff-html";
import { CONNECT_PROTOCOL_VERSION, type StateSnapshot } from "./protocol";
import { getPublicArtifactUrl } from "./public-links";
import { snapshotOpenEscalations, snapshotTasks } from "./serializers";

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
          case "create": {
            const taskType = params.taskType != null ? String(params.taskType) : undefined;
            if (taskType && taskType !== "standard" && taskType !== "real_time") {
              return { ok: false, error: `Invalid taskType: ${taskType}` };
            }
            return {
              ok: true,
              data: taskScheduler.createTask({
                title: String(params.title ?? ""),
                description: params.description != null ? String(params.description) : undefined,
                teamId: params.teamId != null ? String(params.teamId) : undefined,
                taskType: taskType as "standard" | "real_time" | undefined,
                workingDirectory: params.workingDirectory != null ? String(params.workingDirectory) : process.cwd(),
              }),
            };
          }
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
          case "pause": {
            const id = String(params.id ?? "");
            if (!id) return { ok: false, error: "id is required" };
            return { ok: true, data: taskScheduler.pauseTask(id) };
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
            return { ok: true, data: taskScheduler.completeTask(id) };
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

      case "teams": {
        // Light projection for remote task creation: pick a team, never its full config.
        if (action === "list") {
          const teams = new TeamManager(db).listTeams();
          return {
            ok: true,
            data: teams.map((t) => ({
              id: t.id,
              name: t.name,
              goal: t.goal ?? null,
              phase_count: t.phases.length,
            })),
          };
        }
        return { ok: false, error: `Unknown teams action: ${action}` };
      }

      case "recurring": {
        // Recurring task series + their recent runs, for a client-side
        // "Recurring" view. Mirrors the main UI's sidebar run strip.
        if (action === "list") {
          const runsBy = fetchRecentScheduledRuns(db);
          const series = fetchScheduledTaskRows(db).map((s) => ({
            id: s.id,
            title: s.title,
            teamName: s.team_name ?? null,
            scheduleUnit: s.schedule_unit ?? null,
            scheduleAmount: s.schedule_amount ?? null,
            scheduleMatrix: s.schedule_matrix ?? null,
            status: s.status,
            nextRunAt: s.next_run_at ?? null,
            lastRunAt: s.last_run_at ?? null,
            runs: (runsBy[s.id] ?? []).map((r) => ({
              id: r.id,
              title: r.title,
              status: r.status,
              createdAt: r.created_at,
              completedAt: r.completed_at ?? null,
            })),
          }));
          return { ok: true, data: series };
        }
        return { ok: false, error: `Unknown recurring action: ${action}` };
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
        // Support both "taskId" and "id" param names for robustness.
        const taskId = String(params.taskId ?? params.id ?? "");
        if (action === "create") {
          const content = String(params.content ?? "").trim();
          if (!taskId) return { ok: false, error: "taskId is required" };
          if (!content) return { ok: false, error: "content is required" };
          const task = taskScheduler.getTask(taskId);
          if (!task) return { ok: false, error: "Task not found" };

          // Find a valid agent_id: use the team entrypoint to satisfy FK
          // constraints in monolith mode; 'user' is fine in split-mode runtime.
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
          try {
            db.prepare(
              "INSERT INTO task_notes (id, task_id, agent_id, content, source) VALUES (?, ?, ?, ?, 'user')",
            ).run(noteId, taskId, agentId, content);
          } catch (err: unknown) {
            return { ok: false, error: err instanceof Error ? err.message : "Internal error" };
          }

          eventBus.emit("task:note_added", { noteId, taskId, agentId, content });

          const created = fetchTaskNotes(db, taskId).find((n) => n.id === noteId);
          return {
            ok: true,
            data: created
              ? {
                  id: created.id,
                  taskId: created.task_id,
                  agentName: created.agent_name ?? null,
                  source: created.source ?? null,
                  content: created.content,
                  createdAt: created.created_at,
                }
              : { id: noteId, taskId, agentName: null, source: "user", content, createdAt: null },
          };
        }
        if (action !== "list") return { ok: false, error: `Unknown notes action: ${action}` };
        const raw = fetchTaskNotes(db, taskId);
        return {
          ok: true,
          data: raw.map((n) => ({
            id: n.id,
            taskId: n.task_id,
            agentName: n.agent_name ?? null,
            source: n.source ?? null,
            content: n.content,
            createdAt: n.created_at,
          })),
        };
      }

      case "messages": {
        if (action !== "list") return { ok: false, error: `Unknown messages action: ${action}` };
        // Operator messages (agent → human progress updates), newest-first.
        // Support both "taskId" and "id" param names for robustness.
        const taskId = String(params.taskId ?? params.id ?? "");
        if (!taskId) return { ok: false, error: "taskId is required" };
        const rows = new MessageManager(db).listMessages(taskId);
        return {
          ok: true,
          data: rows.map((m) => ({
            id: m.id,
            taskId: m.task_id,
            agentName: m.agent_name ?? null,
            content: m.content,
            format: m.format ?? null,
            createdAt: m.created_at,
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
                format: artifact.format ?? null,
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
              format: artifact.format ?? null,
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
              kind: updated.kind,
              version: updated.version,
              description: updated.description ?? null,
              format: updated.format ?? null,
              createdAt: updated.created_at,
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
              // Prefer the stored format; fall back to the heuristic for legacy
              // rows created before the format column existed.
              contentType: (artifact.format ? artifact.format === "html" : looksLikeHtml(artifact.body))
                ? "text/html; charset=utf-8"
                : "text/plain; charset=utf-8",
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
            format: a.format ?? null,
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

      case "webhooks": {
        if (action !== "trigger") return { ok: false, error: `Unknown webhooks action: ${action}` };
        // Relay target for the integrator's public webhook route
        // (POST /wh/:gid/:scheduledTaskId?key=...). Auth is possession of the
        // per-task webhook_key, validated HERE - the integrator only relays.
        // One opaque error for unknown id / disabled / wrong key so the public
        // route cannot enumerate scheduled tasks.
        const id = String(params.id ?? "");
        const key = String(params.key ?? "");
        const scheduled = id ? scheduledTaskScheduler.getScheduledTask(id) : null;
        if (!scheduled?.webhook_key || !key) return { ok: false, error: "Not found" };
        const expected = Buffer.from(scheduled.webhook_key);
        const provided = Buffer.from(key);
        if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
          return { ok: false, error: "Not found" };
        }
        // Key holder is semi-trusted from here: real errors (e.g. not approved).
        const payload = params.payload;
        const runInput =
          payload == null
            ? undefined
            : typeof payload === "string"
              ? payload
              : JSON.stringify(payload);
        // Per-task leading-edge debounce: a webhook inside the window is
        // ignored and restamps the window, so only a burst's first webhook
        // runs. Cron and manual runs never consume the window.
        const fired = scheduledTaskScheduler.runWebhookTask(
          id,
          taskScheduler,
          runInput ? `Webhook payload:\n${runInput.slice(0, 16_384)}` : undefined,
        );
        if (fired.debounced) {
          return { ok: false, error: "Debounced: ignored, within the debounce window of the previous webhook" };
        }
        return { ok: true, data: { triggered: true, taskId: fired.task.id, title: fired.task.title } };
      }

      case "state": {
        if (action !== "snapshot") return { ok: false, error: `Unknown state action: ${action}` };
        // One-shot full state for the integrator web app: fetched on every WS
        // (re)connect, after which fat events keep its local store patched.
        // Projections only - no result/orchestration_state/artifact bodies.
        const tasks = snapshotTasks(db);
        const escalations = snapshotOpenEscalations(db);
        const reviews = tasks.filter((t) => t.needs_review);
        const snapshot: StateSnapshot = {
          protocolVersion: CONNECT_PROTOCOL_VERSION,
          ts: new Date().toISOString(),
          tasks,
          escalations,
          reviews,
          counts: { openEscalations: escalations.length, pendingReviews: reviews.length },
        };
        return { ok: true, data: snapshot };
      }

      default:
        return { ok: false, error: `Unknown resource: ${resource}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
