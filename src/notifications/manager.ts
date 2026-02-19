import type { Database } from "bun:sqlite";
import { eventBus } from "../events/bus";
import { isEnabled } from "./store";
import { NOTIFICATION_EVENTS, SOUND_URL_PREFIX, type NotificationEventKey } from "./types";
import type { UIWebSocketManager } from "../ws/ui-push";

export class NotificationManager {
  private offs: Array<() => void> = [];

  constructor(private db: Database, private uiPush: UIWebSocketManager) {
    this.subscribe();
  }

  private fire(key: NotificationEventKey): void {
    if (!isEnabled(this.db, key)) return;
    const meta = NOTIFICATION_EVENTS.find((m) => m.key === key);
    if (!meta) return;
    this.uiPush.broadcastNotification(SOUND_URL_PREFIX + meta.soundFile);
  }

  private subscribe(): void {
    const onTaskState = (e: { previousStatus: string; newStatus: string }) => {
      if (e.previousStatus === "approved" && e.newStatus === "running") this.fire("task.started");
      else if (e.newStatus === "completed") this.fire("task.completed");
      else if (e.newStatus === "failed") this.fire("task.failed");
    };
    const onEscCreated = () => this.fire("escalation.created");
    const onEscResolved = () => this.fire("escalation.resolved");
    const onReview = (e: { needsReview: boolean }) => {
      if (e.needsReview) this.fire("phase.review_pending");
    };

    eventBus.on("task:state_changed", onTaskState);
    eventBus.on("escalation:created", onEscCreated);
    eventBus.on("escalation:resolved", onEscResolved);
    eventBus.on("task:needs_review_changed", onReview);

    this.offs.push(
      () => eventBus.off("task:state_changed", onTaskState),
      () => eventBus.off("escalation:created", onEscCreated),
      () => eventBus.off("escalation:resolved", onEscResolved),
      () => eventBus.off("task:needs_review_changed", onReview),
    );
  }

  destroy(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }
}
