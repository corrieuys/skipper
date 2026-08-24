import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { logError } from "../logging";
import { eventBus } from "../events/bus";
import type {
  EscalationCreatedEvent,
  TaskMessagePostedEvent,
  TaskNeedsReviewChangedEvent,
  TaskStateChangedEvent,
} from "../events/bus";
import {
  isExperimental,
} from "../config/feature-flags";
import { isSlackConfigured } from "../config/slack-settings";
import { isSlackEnabledForTeam } from "../teams/local-teams";
import { isSingleAgentId, isSlackEnabledForSingleAgent } from "../single-agents/store";
import { SlackClient } from "./client";
import {
  escalationMessageBlocks,
  reviewMessageBlocks,
  completionMessageBlocks,
  operatorMessageBlocks,
  ESCALATION_TEXT_LIMIT,
} from "./blocks";
import { readTaskSlackOrigin } from "./slash-command";
import { htmlToMrkdwn } from "./html-to-mrkdwn";
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
 * Gating is re-checked live per event, so changing Slack config in /config takes
 * effect with no restart: experimental + bot token + a target channel (the task's
 * origin thread, else the default channel) + the task's team has Slack enabled.
 * There is no separate push toggle — the per-team Slack opt-in is the switch.
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
    const onMessage = (e: TaskMessagePostedEvent) => this.onMessagePosted(e);
    eventBus.on("escalation:created", onEscalation);
    eventBus.on("task:needs_review_changed", onReview);
    eventBus.on("task:state_changed", onState);
    eventBus.on("task:message_posted", onMessage);
    this.cleanup.push(() => eventBus.off("escalation:created", onEscalation));
    this.cleanup.push(() => eventBus.off("task:needs_review_changed", onReview));
    this.cleanup.push(() => eventBus.off("task:state_changed", onState));
    this.cleanup.push(() => eventBus.off("task:message_posted", onMessage));
    slackLog("push.subscribed", { events: "escalation:created,task:needs_review_changed,task:state_changed,task:message_posted" });
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
   * Routing is origin-only: a task pushes to Slack when it *has* a Slack
   * conversation — started from a slash command, or its agent posted/DM'd via the
   * Slack tools (see `stampTaskSlackOrigin`). There is deliberately no
   * default-channel fallback: a task that never touched Slack has no thread to be
   * answered in, so dumping its escalation in a shared channel just detaches the
   * question from its context. `kind` is only for the log line.
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
    if (!this.slackEnabledForTask(task.team_id)) {
      slackLog("push.skip", { kind, taskId, teamId: task.team_id, reason: "team_slack_disabled" });
      return null;
    }
    const origin = readTaskSlackOrigin(this.db, taskId);
    if (!origin) {
      slackLog("push.skip", { kind, taskId, reason: "no_slack_origin" });
      return null;
    }
    return { channel: origin.channel, threadTs: origin.thread_ts, task };
  }

  /**
   * Whether a task's assignment has opted into Slack. A single-agent-backed task
   * carries a projected `sa:<id>` team id whose opt-in lives on the single_agents
   * record; every other task keys off its team's local_teams config.
   */
  private slackEnabledForTask(teamId: string): boolean {
    return isSingleAgentId(teamId)
      ? isSlackEnabledForSingleAgent(this.db, teamId)
      : isSlackEnabledForTeam(this.db, teamId);
  }

  private onEscalationCreated(e: EscalationCreatedEvent): void {
    slackLog("push.event", { kind: "escalation", taskId: e.taskId, escalationId: e.escalationId });
    const target = this.targetChannel(e.taskId, "escalation");
    if (!target) return;
    // `escalationMessageBlocks` clips at Slack's section cap. Say so in the log —
    // otherwise "the operator answered half my question" has no visible cause.
    // The heading prefix (`:warning: *Escalation* — `) sits between the two, so
    // count it; this is an estimate either way, since the question is HTML that
    // changes length on its way to mrkdwn.
    const ESCALATION_HEADING_CHARS = 26;
    if (e.question.length + target.task.title.length + ESCALATION_HEADING_CHARS > ESCALATION_TEXT_LIMIT) {
      slackLog("push.truncated", { kind: "escalation", taskId: e.taskId, escalationId: e.escalationId, chars: e.question.length });
    }
    const blocks = escalationMessageBlocks(e.escalationId, target.task.title, e.question);
    // The notification/fallback text is agent HTML too — flatten it so it doesn't
    // show tag soup in notifications / no-blocks clients.
    const fallback = `Escalation on "${target.task.title}": ${htmlToMrkdwn(e.question)}`;
    void this.post(target.channel, fallback, blocks, "escalation", target.threadTs);
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
   * An agent posted an operator message (src/messages). Same routing and gates as
   * an escalation — a task that has a Slack conversation gets its progress updates
   * there too, so an operator following the run from Slack sees what happened
   * between the questions and the sign-off, not just the endpoints.
   */
  private onMessagePosted(e: TaskMessagePostedEvent): void {
    slackLog("push.event", { kind: "message", taskId: e.taskId, messageId: e.messageId });
    const target = this.targetChannel(e.taskId, "message");
    if (!target) return;
    const agentName = this.agentDisplayName(e.agentId);
    const blocks = operatorMessageBlocks(agentName, e.content);
    void this.post(target.channel, `${agentName} on "${target.task.title}": ${e.content}`, blocks, "message", target.threadTs);
  }

  /** Posting agent's display name, falling back to its id — as the web column does. */
  private agentDisplayName(agentId: string): string {
    const row = this.db
      .prepare("SELECT name FROM agents WHERE id = ?")
      .get(agentId) as { name: string } | null;
    return row?.name || agentId;
  }

  /**
   * Daemon default: when a task with a Slack thread finishes (completed or
   * failed), post a system notice back into that thread so the conversation is
   * closed off where it happened. Gated by experimental + bot token + the team's
   * Slack opt-in, and only fires when the origin has a real thread.
   *
   * This covers agent-captured origins too, so a recurring run that reports into
   * Slack now signs off with a notice carrying an Iterate button — the run stays
   * actionable from the thread it was read in, without a trip to the web UI.
   */
  private onTaskStateChanged(e: TaskStateChangedEvent): void {
    if (e.newStatus !== "completed" && e.newStatus !== "failed") return;
    const target = this.completionTarget(e.taskId, e.newStatus);
    if (!target) return;
    const done = e.newStatus === "completed";
    const text = done
      ? `:white_check_mark: Task *${target.task.title}* finished running.`
      : `:x: Task *${target.task.title}* stopped — it failed before finishing.`;
    // A completed task can be iterated, so its notice carries an Iterate button
    // (opens a modal for the next iteration's prompt). A failed task cannot be
    // iterated — it posts the plain notice only.
    const blocks = done ? completionMessageBlocks(e.taskId, target.task.title) : undefined;
    void this.post(target.channel, text, blocks, `task_${e.newStatus}`, target.threadTs);
  }

  /**
   * Gate + target for a task-completion notice. Unlike `targetChannel` this always
   * posts into the origin thread (never the default channel), so non-Slack tasks
   * are silently skipped.
   */
  private completionTarget(
    taskId: string,
    status: string,
  ): { channel: string; threadTs: string; task: TaskRow } | null {
    if (!isExperimental() || !isSlackConfigured(this.db)) return null;
    const task = this.db
      .prepare("SELECT team_id, title FROM tasks WHERE id = ?")
      .get(taskId) as TaskRow | null;
    if (!task || !task.team_id || !this.slackEnabledForTask(task.team_id)) return null;
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
