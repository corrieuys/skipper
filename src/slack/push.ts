import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { logError } from "../logging";
import { eventBus } from "../events/bus";
import type { EscalationCreatedEvent, TaskNeedsReviewChangedEvent } from "../events/bus";
import {
  isExperimental,
} from "../config/feature-flags";
import {
  isSlackConfigured,
  isSlackPushEnabled,
  getSlackDefaultChannel,
} from "../config/slack-settings";
import { isSlackEnabledForTeam } from "../teams/local-teams";
import { SlackClient } from "./client";
import { escalationMessageBlocks, reviewMessageBlocks } from "./blocks";

interface TaskRow {
  team_id: string | null;
  title: string;
}

/**
 * Outbound Slack push: posts new escalations + phase reviews (with action
 * buttons) to the default channel. Stateless — the buttons carry their own
 * correlation, so a resolution made in the web UI simply leaves stale buttons
 * that no-op / self-heal when clicked (see src/slack/interactions.ts).
 *
 * Gating is re-checked live per event, so toggling push in /config takes effect
 * with no restart: experimental + bot token + push enabled + a default channel +
 * the task's team has Slack enabled.
 */
export class SlackPushManager {
  private db: Database;
  private cleanup: Array<() => void> = [];

  constructor(db: Database) {
    this.db = db;
  }

  start(): void {
    if (this.cleanup.length > 0) return;
    const onEscalation = (e: EscalationCreatedEvent) => this.onEscalationCreated(e);
    const onReview = (e: TaskNeedsReviewChangedEvent) => this.onNeedsReviewChanged(e);
    eventBus.on("escalation:created", onEscalation);
    eventBus.on("task:needs_review_changed", onReview);
    this.cleanup.push(() => eventBus.off("escalation:created", onEscalation));
    this.cleanup.push(() => eventBus.off("task:needs_review_changed", onReview));
  }

  stop(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
  }

  /** The target channel, or null when push should not fire for this task. */
  private targetChannel(taskId: string): { channel: string; task: TaskRow } | null {
    if (!isExperimental() || !isSlackConfigured(this.db) || !isSlackPushEnabled(this.db)) return null;
    const channel = getSlackDefaultChannel(this.db);
    if (!channel) return null;
    const task = this.db
      .prepare("SELECT team_id, title FROM tasks WHERE id = ?")
      .get(taskId) as TaskRow | null;
    if (!task || !task.team_id || !isSlackEnabledForTeam(this.db, task.team_id)) return null;
    return { channel, task };
  }

  private onEscalationCreated(e: EscalationCreatedEvent): void {
    const target = this.targetChannel(e.taskId);
    if (!target) return;
    const blocks = escalationMessageBlocks(e.escalationId, target.task.title, e.question);
    void this.post(target.channel, `Escalation on "${target.task.title}": ${e.question}`, blocks, "escalation");
  }

  private onNeedsReviewChanged(e: TaskNeedsReviewChangedEvent): void {
    if (!e.needsReview) return; // only post when a review opens; closes self-heal
    const target = this.targetChannel(e.taskId);
    if (!target) return;
    const phaseLabel = e.phaseName ?? (typeof e.phaseIndex === "number" ? `phase ${e.phaseIndex + 1}` : "current phase");
    const blocks = reviewMessageBlocks(e.taskId, target.task.title, phaseLabel);
    void this.post(target.channel, `Phase review required on "${target.task.title}" (${phaseLabel})`, blocks, "review");
  }

  private async post(channel: string, text: string, blocks: unknown[], kind: string): Promise<void> {
    try {
      await new SlackClient(this.db).postMessage(channel, text, { blocks });
    } catch (err) {
      logError(this.db, "slack_push", { kind, channel }, err);
    }
  }
}

let _slackPush: SlackPushManager | null = null;

export function initSlackPush(db?: Database): SlackPushManager {
  _slackPush = new SlackPushManager(db ?? getDb());
  return _slackPush;
}

export function getSlackPush(): SlackPushManager | null {
  return _slackPush;
}
