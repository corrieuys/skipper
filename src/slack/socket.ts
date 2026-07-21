import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { logError } from "../logging";
import { getSlackAppToken } from "../config/slack-settings";
import type { TaskScheduler } from "../tasks/scheduler";
import type { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import type { EscalationManager } from "../escalations/manager";
import type { PhaseManager } from "../orchestrator/phase-manager";
import { handleSlashCommand, type SlackSlashCommandPayload } from "./commands";
import { handleInteraction, type InteractionPayload } from "./interactions";
import { SlackClient } from "./client";
import { slackLog } from "./log";
import { findRunningTaskByThread, findCompletedTaskByThread } from "./slash-command";
import { isExperimental } from "../config/feature-flags";

const SLACK_API_BASE = "https://slack.com/api";
const MAX_BACKOFF_MS = 60_000;

export type SlackSocketStatus = "disabled" | "connecting" | "connected" | "auth_failed" | "error";

interface ConnectionsOpenResponse {
  ok: boolean;
  url?: string;
  error?: string;
}

interface SocketEnvelope {
  type?: string;
  envelope_id?: string;
  reason?: string;
  payload?: unknown;
}

/** Subset of a Slack `message` event delivered over the Events API. */
interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  channel?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

// Auth errors from apps.connections.open that no amount of reconnecting fixes —
// stop trying until the operator fixes the token.
const FATAL_AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "no_permission"]);

/**
 * Slack Socket Mode client: a long-lived outbound WebSocket that receives slash
 * commands and dispatches them to Skipper actions. Mirrors ConnectClient's
 * connect/reconnect/backoff shape. Hand-rolled (no Slack SDK), consistent with
 * the rest of the Slack integration.
 *
 * Flow: POST apps.connections.open (Bearer = app-level token, xapp-) → wss URL →
 * open the socket → Slack sends `hello`, then `slash_commands` envelopes that
 * must be ACK'd within 3s. Each command is handled by handleSlashCommand and the
 * result is returned as the ephemeral ACK payload.
 */
export class SlackSocketManager {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;
  private running = false;
  private _status: SlackSocketStatus = "disabled";

  private db: Database;
  private taskScheduler: TaskScheduler;
  private scheduledScheduler: ScheduledTaskScheduler;
  private escalationManager: EscalationManager;
  private phaseManager: PhaseManager;

  constructor(
    db: Database,
    taskScheduler: TaskScheduler,
    scheduledScheduler: ScheduledTaskScheduler,
    escalationManager: EscalationManager,
    phaseManager: PhaseManager,
  ) {
    this.db = db;
    this.taskScheduler = taskScheduler;
    this.scheduledScheduler = scheduledScheduler;
    this.escalationManager = escalationManager;
    this.phaseManager = phaseManager;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.backoffMs = 1_000;
    this._status = "connecting";
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this._status = "disabled";
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  getStatus(): SlackSocketStatus {
    return this._status;
  }

  private async connect(): Promise<void> {
    if (!this.running) return;

    const appToken = getSlackAppToken(this.db);
    if (!appToken) {
      slackLog("socket.skip", { reason: "no_app_token" });
      this.running = false;
      this._status = "disabled";
      return;
    }
    slackLog("socket.connecting");

    let url: string;
    try {
      const res = await fetch(`${SLACK_API_BASE}/apps.connections.open`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${appToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      const data = (await res.json()) as ConnectionsOpenResponse;
      if (!data.ok || !data.url) {
        if (data.error && FATAL_AUTH_ERRORS.has(data.error)) {
          this._status = "auth_failed";
          this.running = false;
          slackLog("socket.auth_failed", { error: data.error, note: "reconnect stopped" });
          return;
        }
        throw new Error(data.error ?? "apps.connections.open returned no url");
      }
      url = data.url;
    } catch (err) {
      this._status = "error";
      logError(this.db, "slack_socket_open", {}, err);
      this.scheduleReconnect();
      return;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this._status = "error";
      logError(this.db, "slack_socket_connect", {}, err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 1_000;
      slackLog("socket.open", { note: "awaiting hello" });
    };

    ws.onmessage = (event: MessageEvent) => {
      let msg: SocketEnvelope;
      try {
        msg = JSON.parse(String(event.data)) as SocketEnvelope;
      } catch {
        return;
      }
      this.handleFrame(ws, msg);
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.running) {
        this._status = "error";
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose fires next; no-op here to suppress the unhandled error.
    };
  }

  private handleFrame(ws: WebSocket, msg: SocketEnvelope): void {
    switch (msg.type) {
      case "hello":
        this._status = "connected";
        slackLog("socket.connected");
        return;
      case "disconnect":
        // Slack rotates sockets; it asks us to reconnect. Closing triggers the
        // onclose reconnect path with backoff.
        slackLog("socket.disconnect", { reason: msg.reason ?? "unknown", note: "reconnecting" });
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        return;
      case "slash_commands":
        this.handleSlashEnvelope(ws, msg);
        return;
      case "interactive":
        this.handleInteractiveEnvelope(ws, msg);
        return;
      case "events_api":
        this.handleEventEnvelope(ws, msg);
        return;
      default:
        // Anything else (keep-alives etc.) is ignored, but every envelope must be
        // ACK'd so Slack does not retry it.
        if (msg.envelope_id) this.ack(ws, msg.envelope_id);
    }
  }

  /**
   * Events API envelope (Socket Mode). We only care about `message` events: a
   * human reply inside a task's originating thread becomes a note on that task.
   * ACK first (3s budget), then do the lookup + note out of band.
   */
  private handleEventEnvelope(ws: WebSocket, msg: SocketEnvelope): void {
    if (msg.envelope_id) this.ack(ws, msg.envelope_id);
    const payload = (msg.payload ?? {}) as { event?: SlackMessageEvent };
    const event = payload.event;
    // Log EVERY events_api arrival so we can tell whether Slack is even
    // delivering message events (vs the app not being subscribed to
    // message.channels/message.groups). Diagnostic — cheap, low volume.
    slackLog("in.event", {
      type: event?.type ?? "?",
      subtype: event?.subtype,
      thread: event?.thread_ts ? "y" : "n",
      bot: event?.bot_id ? "y" : "n",
    });
    if (!event || event.type !== "message") return;
    void this.handleThreadReply(event);
  }

  private async handleThreadReply(event: SlackMessageEvent): Promise<void> {
    // Only plain human replies inside a thread. Bot posts carry `bot_id` (so our
    // own anchors / escalations / agent replies are excluded) and edits / deletes
    // / joins carry a `subtype` — skip both. Must be threaded (`thread_ts`).
    // Each skip logs its reason so a dropped reply is never silent.
    if (event.bot_id) { slackLog("in.thread_reply.skip", { reason: "bot_message" }); return; }
    if (event.subtype) { slackLog("in.thread_reply.skip", { reason: `subtype:${event.subtype}` }); return; }
    const channel = event.channel?.trim();
    const threadTs = event.thread_ts?.trim();
    const text = (event.text ?? "").trim();
    if (!channel || !threadTs || !text) {
      slackLog("in.thread_reply.skip", { reason: "not_a_thread_reply", channel: channel ? "y" : "n", thread: threadTs ? "y" : "n", text: text ? "y" : "n" });
      return;
    }
    if (!isExperimental()) { slackLog("in.thread_reply.skip", { reason: "not_experimental" }); return; }
    try {
      const taskId = findRunningTaskByThread(this.db, channel, threadTs);
      if (!taskId) {
        // Not a live task. If the thread belongs to a COMPLETED task, a reply is a
        // request to keep going — but we never auto-iterate (a full multi-agent
        // re-run is too expensive/surprising to trigger on a stray reply). Nudge the
        // operator to the Iterate button on the completion notice instead.
        const completedTaskId = findCompletedTaskByThread(this.db, channel, threadTs);
        if (completedTaskId) {
          slackLog("in.thread_reply.completed", { taskId: completedTaskId, channel, threadTs });
          try {
            await new SlackClient(this.db).postMessage(
              channel,
              ":checkered_flag: This task has finished. To run another pass, click *Iterate* on the completion message above and enter your instructions there.",
              { thread_ts: threadTs },
            );
          } catch (err) {
            logError(this.db, "slack_thread_reply_completed", { channel, threadTs }, err);
          }
          return;
        }
        slackLog("in.thread_reply.no_task", { channel, threadTs });
        return;
      }
      const attribution = event.user ? `Slack reply from <@${event.user}>` : "Slack reply";
      const noteId = this.taskScheduler.addExternalNote(taskId, `${attribution}: ${text}`, "user");
      slackLog("in.thread_reply.noted", { taskId, channel, threadTs, noteId: noteId ?? "none" });
      if (noteId) {
        // Confirm back in-thread. The ack is a bot message (carries bot_id) so the
        // next events_api frame for it is filtered out above — no capture loop.
        try {
          await new SlackClient(this.db).postMessage(channel, ":memo: Added to this task's notes.", { thread_ts: threadTs });
        } catch (err) {
          logError(this.db, "slack_thread_reply_ack", { channel, threadTs }, err);
        }
      }
    } catch (err) {
      logError(this.db, "slack_thread_reply", { channel, threadTs }, err);
    }
  }

  private handleInteractiveEnvelope(ws: WebSocket, msg: SocketEnvelope): void {
    const payload = (msg.payload ?? {}) as InteractionPayload;
    const p = payload as { type?: string; user?: { id?: string }; actions?: Array<{ action_id?: string; value?: string }> };
    slackLog("in.interaction", {
      type: p.type ?? "?",
      user: p.user?.id,
      action: p.actions?.[0]?.action_id ?? p.actions?.[0]?.value,
    });
    let result: { ackPayload?: Record<string, unknown>; run?: () => Promise<void> };
    try {
      result = handleInteraction(
        {
          db: this.db,
          client: new SlackClient(this.db),
          escalationManager: this.escalationManager,
          phaseManager: this.phaseManager,
          taskScheduler: this.taskScheduler,
        },
        payload,
      );
    } catch (err) {
      logError(this.db, "slack_interactive", { type: payload.type }, err);
      result = {};
    }
    // ACK first (view_submission may carry a response_action payload), then run
    // the deferred work — approve/reject can respawn agents past the 3s window.
    if (msg.envelope_id) this.ack(ws, msg.envelope_id, result.ackPayload);
    if (result.run) void result.run();
  }

  private handleSlashEnvelope(ws: WebSocket, msg: SocketEnvelope): void {
    // ACK the envelope immediately, then do the work: the dispatch posts an
    // anchor message + may spawn a task, which can exceed the 3s ACK window. The
    // user-facing reply is delivered out-of-band via the command's response_url.
    if (msg.envelope_id) this.ack(ws, msg.envelope_id);
    const payload = (msg.payload ?? {}) as SlackSlashCommandPayload;
    slackLog("in.slash", {
      command: payload.command ?? "?",
      user: `${payload.user_name ?? "?"}/${payload.user_id ?? "?"}`,
      channel: payload.channel_id ?? "?",
      text: payload.text ?? "",
    });
    void this.runSlash(payload);
  }

  private async runSlash(payload: SlackSlashCommandPayload): Promise<void> {
    try {
      const reply = await handleSlashCommand(
        this.db,
        this.taskScheduler,
        this.scheduledScheduler,
        payload,
        new SlackClient(this.db),
      );
      // If a public anchor message was already posted, don't also send an
      // ephemeral reply — a single "started" message is enough.
      slackLog("in.slash.replied", { command: payload.command ?? "?", posted: reply.posted ?? false });
      if (!reply.posted) await postToResponseUrl(payload.response_url, reply.text);
    } catch (err) {
      logError(this.db, "slack_slash_envelope", { command: payload.command }, err);
      await postToResponseUrl(payload.response_url, "Skipper failed to handle that command.");
    }
  }

  private ack(ws: WebSocket, envelopeId: string, payload?: Record<string, unknown>): void {
    const frame = payload ? { envelope_id: envelopeId, payload } : { envelope_id: envelopeId };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    slackLog("socket.reconnect", { delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

/** Deliver a slash-command reply as an ephemeral message via its response_url. */
async function postToResponseUrl(url: string | undefined, text: string): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text }),
    });
  } catch {
    /* best-effort: the action already ran even if the reply post fails */
  }
}

let _slackSocket: SlackSocketManager | null = null;

export function initSlackSocket(
  taskScheduler: TaskScheduler,
  scheduledScheduler: ScheduledTaskScheduler,
  escalationManager: EscalationManager,
  phaseManager: PhaseManager,
): SlackSocketManager {
  _slackSocket = new SlackSocketManager(getDb(), taskScheduler, scheduledScheduler, escalationManager, phaseManager);
  return _slackSocket;
}

export function getSlackSocket(): SlackSocketManager | null {
  return _slackSocket;
}
