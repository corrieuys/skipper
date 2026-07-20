import type { Database } from "bun:sqlite";
import type { TaskScheduler, RealtimeTaskConfig } from "../tasks/scheduler";
import type { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import { isSlackUserAllowed, isSlackConfigured } from "../config/slack-settings";
import { findTeamBySlashCommand } from "../teams/local-teams";
import { logError } from "../logging";
import type { SlackClient } from "./client";
import type { SlackOrigin } from "./slash-command";

/**
 * Minimal shape of a Slack slash-command payload (Socket Mode `slash_commands`
 * envelope). Only the fields the dispatcher needs.
 */
export interface SlackSlashCommandPayload {
  command: string;
  text?: string;
  user_id?: string;
  user_name?: string;
  channel_id?: string;
  team_id?: string;
  /** Short-lived URL (30 min) for delivering the user-facing reply. */
  response_url?: string;
}

export interface SlackCommandReply {
  text: string;
  /**
   * True when a public channel message (the anchor) was already posted, so the
   * caller should NOT also send an ephemeral reply — avoids a double message.
   */
  posted?: boolean;
}

const MAX_TITLE = 80;

/**
 * Map an inbound Slack slash command to a Skipper action and return the ephemeral
 * reply text. Async because it posts an anchor message (to thread later replies)
 * and stamps the Slack origin onto the run so the agent can reply via
 * `slack_send_message`. Never throws: any error becomes the reply text.
 *
 * Routing:
 *  1. authorize the invoking Slack user against the allowlist (fail closed);
 *  2. a command bound to a scheduled task → run it now (arg text = run input);
 *  3. a command bound to a team → create + auto-approve a task (arg text =
 *     description, working dir = the daemon's cwd);
 *  4. otherwise → unbound.
 */
export async function handleSlashCommand(
  db: Database,
  taskScheduler: TaskScheduler,
  scheduledScheduler: ScheduledTaskScheduler,
  payload: SlackSlashCommandPayload,
  client?: SlackClient,
): Promise<SlackCommandReply> {
  const command = (payload.command ?? "").trim();
  const text = (payload.text ?? "").trim();
  const userId = payload.user_id ?? "";

  if (!isSlackUserAllowed(db, userId)) {
    return { text: "Not authorized to trigger Skipper actions." };
  }

  try {
    const scheduled = scheduledScheduler.findScheduledTaskBySlashCommand(command);
    if (scheduled) {
      if (scheduled.status !== "approved") {
        return { text: `Scheduled task "${scheduled.title}" is not approved, so it can't be run.` };
      }
      const anchor = `:arrow_forward: Started *${scheduled.title}*${mention(userId)}`;
      const { origin, anchored } = await captureOrigin(db, client, payload, anchor);
      const run = scheduledScheduler.runTaskNow(scheduled.id, taskScheduler, text || undefined, { slackOrigin: origin ?? undefined });
      // The anchor is the single "started" message; only send an ephemeral when
      // we couldn't post it publicly (no channel / post failed / Slack off).
      return anchored ? { text: anchor, posted: true } : { text: `▶️ Started "${scheduled.title}" — task ${run.id}` };
    }

    const team = findTeamBySlashCommand(db, command);
    if (team) {
      if (!text) {
        return { text: `Add a description, e.g. \`${command} "add a webhook feature"\`` };
      }
      const anchor = `:rocket: Started a *${team.name}* task${mention(userId)}`;
      const { origin, anchored } = await captureOrigin(db, client, payload, anchor);
      const task = taskScheduler.createTask({
        title: text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1)}…` : text,
        description: text,
        teamId: team.id,
        workingDirectory: process.cwd(),
        taskConfig: origin ? ({ slack_origin: origin } as unknown as RealtimeTaskConfig) : undefined,
      });
      taskScheduler.approveTask(task.id);
      return anchored ? { text: anchor, posted: true } : { text: `✅ Started task ${task.id} on ${team.name}` };
    }

    return { text: `No Skipper action is bound to ${command}.` };
  } catch (err) {
    logError(db, "slack_slash_command", { command, userId }, err);
    return { text: `Failed to run ${command}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Capture where the command came from so the run can reply. Posts an anchor
 * message to the invoking channel (best-effort) to create a thread; falls back to
 * a channel-only origin if the post fails or Slack is unconfigured. Returns null
 * only when there is no channel at all.
 */
async function captureOrigin(
  db: Database,
  client: SlackClient | undefined,
  payload: SlackSlashCommandPayload,
  anchorText: string,
): Promise<{ origin: SlackOrigin | null; anchored: boolean }> {
  const channel = payload.channel_id?.trim();
  if (!channel) return { origin: null, anchored: false };
  const base: SlackOrigin = { channel, ...(payload.user_id ? { user_id: payload.user_id } : {}) };
  if (!client || !isSlackConfigured(db)) return { origin: base, anchored: false };
  try {
    const { ts } = await client.postMessage(channel, anchorText);
    return { origin: ts ? { ...base, thread_ts: ts } : base, anchored: true };
  } catch (err) {
    logError(db, "slack_slash_anchor", { channel }, err);
    return { origin: base, anchored: false };
  }
}

function mention(userId: string): string {
  return userId ? ` for <@${userId}>` : "";
}
