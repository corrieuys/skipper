import type { Database } from "bun:sqlite";
import {
  eventBus,
  type TaskStateChangedEvent,
  type EscalationCreatedEvent,
  type EscalationResolvedEvent,
  type TaskNeedsReviewChangedEvent,
} from "../events/bus";
import type { HookDefinition, HookEventName, HookEventPayload } from "./types";
import { resolvePlaceholders } from "./placeholder";
import { logError } from "../logging";

const HOOK_TIMEOUT_MS = 30_000;

export class HookManager {
  private db: Database;
  private taskStateHandler: ((event: TaskStateChangedEvent) => void) | null = null;
  private escalationCreatedHandler: ((event: EscalationCreatedEvent) => void) | null = null;
  private escalationResolvedHandler: ((event: EscalationResolvedEvent) => void) | null = null;
  private needsReviewHandler: ((event: TaskNeedsReviewChangedEvent) => void) | null = null;

  constructor(db: Database) {
    this.db = db;
    this.registerListeners();
  }

  private registerListeners(): void {
    this.taskStateHandler = (event: TaskStateChangedEvent) => {
      if (event.previousStatus === "approved" && event.newStatus === "running") {
        this.fireHooksForTask(event.taskId, "task.started", {
          task_id: event.taskId,
        });
      } else if (event.newStatus === "completed") {
        this.fireHooksForTask(event.taskId, "task.completed", {
          task_id: event.taskId,
          status: "completed",
        });
      } else if (event.newStatus === "failed") {
        this.fireHooksForTask(event.taskId, "task.failed", {
          task_id: event.taskId,
          status: "failed",
        });
      }
    };

    this.escalationCreatedHandler = (event: EscalationCreatedEvent) => {
      this.fireHooksForTask(event.taskId, "escalation.created", {
        task_id: event.taskId,
        escalation_id: event.escalationId,
        body: event.question,
        type: event.type,
        agent_id: event.agentId,
      });
    };

    this.escalationResolvedHandler = (event: EscalationResolvedEvent) => {
      this.fireHooksForTask(event.taskId, "escalation.resolved", {
        task_id: event.taskId,
        escalation_id: event.escalationId,
        response: event.response,
      });
    };

    this.needsReviewHandler = (event: TaskNeedsReviewChangedEvent) => {
      if (event.needsReview) {
        this.fireHooksForTask(event.taskId, "phase.review_pending", {
          task_id: event.taskId,
          phase_name: event.phaseName,
          phase_index: event.phaseIndex !== undefined ? String(event.phaseIndex) : undefined,
        });
      }
    };

    eventBus.on("task:state_changed", this.taskStateHandler);
    eventBus.on("escalation:created", this.escalationCreatedHandler);
    eventBus.on("escalation:resolved", this.escalationResolvedHandler);
    eventBus.on("task:needs_review_changed", this.needsReviewHandler);
  }

  private fireHooksForTask(taskId: string, eventName: HookEventName, payload: HookEventPayload): void {
    try {
      const taskRow = this.db
        .prepare("SELECT task_config, title, team_id FROM tasks WHERE id = ?")
        .get(taskId) as { task_config: string; title: string; team_id: string | null } | null;

      if (!taskRow) return;

      let taskConfig: Record<string, unknown>;
      try {
        taskConfig = JSON.parse(taskRow.task_config || "{}");
      } catch {
        return;
      }

      const hooks = taskConfig.hooks as HookDefinition[] | undefined;
      if (!hooks || !Array.isArray(hooks) || hooks.length === 0) return;

      const enrichedPayload: HookEventPayload = {
        ...payload,
        task_title: taskRow.title,
        team_id: taskRow.team_id ?? undefined,
      };

      if (eventName === "task.failed") {
        try {
          const resultRow = this.db
            .prepare("SELECT result FROM tasks WHERE id = ?")
            .get(taskId) as { result: string | null } | null;
          if (resultRow?.result) {
            const parsed = JSON.parse(resultRow.result);
            enrichedPayload.error = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed);
          }
        } catch { /* best effort */ }
      }

      const matchingHooks = hooks.filter((h) => h.event === eventName && !h.disabled);
      for (const hook of matchingHooks) {
        this.executeHook(taskId, hook, enrichedPayload);
      }
    } catch (err) {
      logError(this.db, "hook.fire_hooks", { taskId, eventName }, err);
    }
  }

  private executeHook(taskId: string, hook: HookDefinition, payload: HookEventPayload): void {
    const resolvedCommand = resolvePlaceholders(hook.template, payload);

    (async () => {
      const startedAt = new Date().toISOString();
      try {
        const proc = Bun.spawn(["sh", "-c", resolvedCommand], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        });

        const timeout = setTimeout(() => {
          try { proc.kill(); } catch { /* already exited */ }
        }, HOOK_TIMEOUT_MS);

        const exitCode = await proc.exited;
        clearTimeout(timeout);

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();

        this.db.prepare(
          "INSERT INTO events (type, payload, task_id) VALUES (?, ?, ?)",
        ).run(
          exitCode === 0 ? "hook:executed" : "hook:failed",
          JSON.stringify({
            hook_event: hook.event,
            hook_name: hook.name ?? null,
            hook_type: hook.type,
            exit_code: exitCode,
            stdout: stdout.slice(0, 2000),
            stderr: stderr.slice(0, 2000),
            started_at: startedAt,
            command_preview: resolvedCommand.slice(0, 500),
          }),
          taskId,
        );
      } catch (err) {
        logError(this.db, "hook.execute", {
          taskId,
          hookEvent: hook.event,
          hookName: hook.name ?? null,
        }, err);

        try {
          this.db.prepare(
            "INSERT INTO events (type, payload, task_id) VALUES (?, ?, ?)",
          ).run(
            "hook:error",
            JSON.stringify({
              hook_event: hook.event,
              hook_name: hook.name ?? null,
              error: err instanceof Error ? err.message : String(err),
              started_at: startedAt,
            }),
            taskId,
          );
        } catch { /* best effort audit */ }
      }
    })();
  }

  destroy(): void {
    if (this.taskStateHandler) {
      eventBus.off("task:state_changed", this.taskStateHandler);
      this.taskStateHandler = null;
    }
    if (this.escalationCreatedHandler) {
      eventBus.off("escalation:created", this.escalationCreatedHandler);
      this.escalationCreatedHandler = null;
    }
    if (this.escalationResolvedHandler) {
      eventBus.off("escalation:resolved", this.escalationResolvedHandler);
      this.escalationResolvedHandler = null;
    }
    if (this.needsReviewHandler) {
      eventBus.off("task:needs_review_changed", this.needsReviewHandler);
      this.needsReviewHandler = null;
    }
  }
}
