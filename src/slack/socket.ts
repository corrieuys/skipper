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
      console.warn("[slack] Missing app-level token, not connecting");
      this.running = false;
      this._status = "disabled";
      return;
    }

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
          console.error(`[slack] apps.connections.open auth failed (${data.error}) — reconnect stopped`);
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
      console.log("[slack] Socket Mode open — awaiting hello");
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
        console.log("[slack] Socket Mode connected");
        return;
      case "disconnect":
        // Slack rotates sockets; it asks us to reconnect. Closing triggers the
        // onclose reconnect path with backoff.
        console.log(`[slack] Socket Mode disconnect (${msg.reason ?? "unknown"}) — reconnecting`);
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
      default:
        // events_api and anything else is ignored, but every envelope must be
        // ACK'd so Slack does not retry it.
        if (msg.envelope_id) this.ack(ws, msg.envelope_id);
    }
  }

  private handleInteractiveEnvelope(ws: WebSocket, msg: SocketEnvelope): void {
    const payload = (msg.payload ?? {}) as InteractionPayload;
    let result: { ackPayload?: Record<string, unknown>; run?: () => Promise<void> };
    try {
      result = handleInteraction(
        {
          db: this.db,
          client: new SlackClient(this.db),
          escalationManager: this.escalationManager,
          phaseManager: this.phaseManager,
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
    console.log(
      `[slack] Slash command received: ${payload.command ?? "?"} from ${payload.user_name ?? "?"} (${payload.user_id ?? "?"}) in ${payload.channel_id ?? "?"} text=${JSON.stringify(payload.text ?? "")}`,
    );
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
    console.log(`[slack] Reconnecting in ${delay}ms`);
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
