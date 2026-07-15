import type { Database } from "bun:sqlite";
import { getSlackBotToken } from "../config/slack-settings";

const SLACK_API_BASE = "https://slack.com/api";

/** One message row as returned by conversations.history (subset we surface). */
export interface SlackMessage {
  user: string;
  text: string;
  ts: string;
}

/** Shape of the fields we read off Slack Web API responses. `ok:false` carries `error`. */
interface SlackResponse {
  ok: boolean;
  error?: string;
  // chat.postMessage
  channel?: string | { id: string };
  ts?: string;
  // users.lookupByEmail
  user?: { id: string };
  // auth.test
  team?: string;
  user_id?: string;
  // conversations.history
  messages?: Array<{ user?: string; bot_id?: string; text?: string; ts?: string }>;
}

/**
 * Minimal Slack Web API client. Posts AS the configured Skipper app using the
 * bot token (xoxb-). The token is read lazily from app_settings on every call
 * so config changes take effect without a daemon restart.
 *
 * Follows the outbound-fetch shape used by realtime/transcription.ts:OpenAIAdapter
 * (Bearer auth, res.ok check, error-body surfaced). Slack additionally returns
 * HTTP 200 with `{ok:false,error}` on logical failures, which we also throw on.
 */
export class SlackClient {
  constructor(private db: Database) {}

  private async call(method: string, body: Record<string, unknown>): Promise<SlackResponse> {
    const token = getSlackBotToken(this.db);
    if (!token) throw new Error("Slack bot token not configured");

    const res = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Slack ${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as SlackResponse;
    if (!json.ok) throw new Error(`Slack ${method} failed: ${json.error ?? "unknown_error"}`);
    return json;
  }

  /** Post a message to a channel (ID `C…` or `#name`) or an open DM channel. */
  async postMessage(
    channel: string,
    text: string,
    opts?: { thread_ts?: string },
  ): Promise<{ channel: string; ts: string }> {
    const r = await this.call("chat.postMessage", { channel, text, thread_ts: opts?.thread_ts });
    const ch = typeof r.channel === "string" ? r.channel : r.channel?.id ?? channel;
    return { channel: ch, ts: r.ts ?? "" };
  }

  /** Resolve a user's Slack ID (`U…`) from their email address. */
  async lookupUserByEmail(email: string): Promise<string> {
    const r = await this.call("users.lookupByEmail", { email });
    if (!r.user?.id) throw new Error(`Slack users.lookupByEmail returned no user for ${email}`);
    return r.user.id;
  }

  /** Open (or fetch the existing) DM channel with a user, returning its channel ID. */
  async openDm(userId: string): Promise<string> {
    const r = await this.call("conversations.open", { users: userId });
    const ch = typeof r.channel === "string" ? r.channel : r.channel?.id;
    if (!ch) throw new Error(`Slack conversations.open returned no channel for ${userId}`);
    return ch;
  }

  /**
   * Read recent messages from a channel, newest first. `oldest`/`latest` are
   * Slack ts bounds (Unix epoch seconds, as strings) — pass undefined for open-ended.
   * Requires a channel ID (C…); a `#name` must be resolved to an ID first.
   */
  async readChannel(
    channel: string,
    opts?: { oldest?: string; latest?: string; limit?: number },
  ): Promise<SlackMessage[]> {
    const body: Record<string, unknown> = { channel, limit: opts?.limit ?? 50 };
    if (opts?.oldest) body.oldest = opts.oldest;
    if (opts?.latest) body.latest = opts.latest;
    const r = await this.call("conversations.history", body);
    return (r.messages ?? []).map((m) => ({
      user: m.user ?? m.bot_id ?? "",
      text: m.text ?? "",
      ts: m.ts ?? "",
    }));
  }

  /** Verify the token and return the authenticated bot/workspace identity. */
  async authTest(): Promise<{ team: string; userId: string }> {
    const r = await this.call("auth.test", {});
    return { team: r.team ?? "", userId: r.user_id ?? "" };
  }
}
