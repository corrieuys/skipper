import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { logError } from "../logging";
import { eventBus } from "../events/bus";
import type { EscalationCreatedEvent, TaskNeedsReviewChangedEvent, TaskStateChangedEvent } from "../events/bus";
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
import { readTaskSlackOrigin } from "./slash-command";
import { slackLog } from "./log";

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
    const onState = (e: TaskStateChangedEvent) => this.onTaskStateChanged(e);
    eventBus.on("escalation:created", onEscalation);
    eventBus.on("task:needs_review_changed", onReview);
    eventBus.on("task:state_changed", onState);
    this.cleanup.push(() => eventBus.off("escalation:created", onEscalation));
    this.cleanup.push(() => eventBus.off("task:needs_review_changed", onReview));
    this.cleanup.push(() => eventBus.off("task:state_changed", onState));
    slackLog("push.subscribed", { events: "escalation:created,task:needs_review_changed,task:state_changed" });
  }

  stop(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
  }

  /**
   * The target for this task's push, or null when it should not fire. Every
   * negative path logs the exact gate that blocked — this used to be five silent
   * `return null`s, which is why a misconfigured push looks like "nothing happened".
   *
   * Routing: when the task carries a Slack origin (it was started from a slash
   * command), post into that thread so the whole task stays scoped to the
   * originating conversation — same channel + `thread_ts` the agent replies into.
   * Otherwise fall back to the default channel. `kind` is only for the log line.
   */
  private targetChannel(
    taskId: string,
    kind: string,
  ): { channel: string; threadTs?: string; task: TaskRow } | null {
    if (!isExperimental()) {
      slackLog("push.skip", { kind, taskId, reason: "not_experimental" });
      return null;
    }
    if (!isSlackConfigured(this.db)) {
      slackLog("push.skip", { kind, taskId, reason: "no_bot_token" });
      return null;
    }
    if (!isSlackPushEnabled(this.db)) {
      slackLog("push.skip", { kind, taskId, reason: "push_disabled" });
      return null;
    }
    const task = this.db
      .prepare("SELECT team_id, title FROM tasks WHERE id = ?")
      .get(taskId) as TaskRow | null;
    if (!task) {
      slackLog("push.skip", { kind, taskId, reason: "task_not_found" });
      return null;
    }
    if (!task.team_id) {
      slackLog("push.skip", { kind, taskId, reason: "task_has_no_team" });
      return null;
    }
    if (!isSlackEnabledForTeam(this.db, task.team_id)) {
      slackLog("push.skip", { kind, taskId, teamId: task.team_id, reason: "team_slack_disabled" });
      return null;
    }
    // Prefer the originating thread; fall back to the default channel.
    const origin = readTaskSlackOrigin(this.db, taskId);
    const channel = origin?.channel || getSlackDefaultChannel(this.db);
    if (!channel) {
      slackLog("push.skip", { kind, taskId, reason: "no_target_channel" });
      return null;
    }
    return { channel, threadTs: origin?.thread_ts, task };
  }

  private onEscalationCreated(e: EscalationCreatedEvent): void {
    slackLog("push.event", { kind: "escalation", taskId: e.taskId, escalationId: e.escalationId });
    const target = this.targetChannel(e.taskId, "escalation");
    if (!target) return;
    const blocks = escalationMessageBlocks(e.escalationId, target.task.title, e.question);
    void this.post(target.channel, `Escalation on "${target.task.title}": ${e.question}`, blocks, "escalation", target.threadTs);
  }

  private onNeedsReviewChanged(e: TaskNeedsReviewChangedEvent): void {
    if (!e.needsReview) return; // only post when a review opens; closes self-heal
    slackLog("push.event", { kind: "review", taskId: e.taskId });
    const target = this.targetChannel(e.taskId, "review");
    if (!target) return;
    const phaseLabel = e.phaseName ?? (typeof e.phaseIndex === "number" ? `phase ${e.phaseIndex + 1}` : "current phase");
    const blocks = reviewMessageBlocks(e.taskId, target.task.title, phaseLabel);
    void this.post(target.channel, `Phase review required on "${target.task.title}" (${phaseLabel})`, blocks, "review", target.threadTs);
  }

  /**
   * Daemon default: when a task that was started from a Slack thread finishes
   * (completed or failed), post a system notice back into that thread so the
   * conversation is closed off where it began. Independent of the push toggle —
   * this is a direct courtesy reply to a user-initiated slash command, not the
   * chatty escalation/review stream — but still gated by experimental + bot token
   * + the team's Slack opt-in. Only fires when the origin has a real thread.
   */
  private onTaskStateChanged(e: TaskStateChangedEvent): void {
    if (e.newStatus !== "completed" && e.newStatus !== "failed") return;
    const target = this.completionTarget(e.taskId, e.newStatus);
    if (!target) return;
    const done = e.newStatus === "completed";
    const text = done
      ? `:white_check_mark: Task *${target.task.title}* finished running.`
      : `:x: Task *${target.task.title}* stopped — it failed before finishing.`;
    void this.post(target.channel, text, undefined, `task_${e.newStatus}`, target.threadTs);
  }

  /**
   * Gate + target for a task-completion notice. Unlike `targetChannel` this does
   * not require the push toggle and always posts into the origin thread (never the
   * default channel), so non-Slack tasks are silently skipped.
   */
  private completionTarget(
    taskId: string,
    status: string,
  ): { channel: string; threadTs: string; task: TaskRow } | null {
    if (!isExperimental() || !isSlackConfigured(this.db)) return null;
    const task = this.db
      .prepare("SELECT team_id, title FROM tasks WHERE id = ?")
      .get(taskId) as TaskRow | null;
    if (!task || !task.team_id || !isSlackEnabledForTeam(this.db, task.team_id)) return null;
    const origin = readTaskSlackOrigin(this.db, taskId);
    if (!origin?.thread_ts) return null; // completion notice only makes sense in a thread
    slackLog("push.event", { kind: `task_${status}`, taskId });
    return { channel: origin.channel, threadTs: origin.thread_ts, task };
  }

  private async post(channel: string, text: string, blocks: unknown[] | undefined, kind: string, threadTs?: string): Promise<void> {
    try {
      const { ts } = await new SlackClient(this.db).postMessage(channel, text, { blocks, thread_ts: threadTs });
      slackLog("push.posted", { kind, channel, threadTs, ts });
    } catch (err) {
      slackLog("push.failed", { kind, channel, threadTs, error: err instanceof Error ? err.message : String(err) });
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
