import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SlackClient } from "./client";
import { setStringSetting } from "../config/app-settings";
import { SETTING_SLACK_BOT_TOKEN } from "../config/slack-settings";

let db: Database;
const realFetch = globalThis.fetch;

// Captured request + canned response for the stubbed fetch.
interface Call { url: string; init: RequestInit }
let calls: Call[];
let nextResponse: unknown;
let nextOk = true; // HTTP-level ok (res.ok)
// Per-Slack-method responses keyed by the last URL segment (e.g. "conversations.list").
let responseFor: Record<string, unknown>;

function stubFetch(): void {
  calls = [];
  responseFor = {};
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const method = u.split("/").pop() ?? "";
    const body = method in responseFor ? responseFor[method] : nextResponse;
    return {
      ok: nextOk,
      status: nextOk ? 200 : 500,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
}

describe("SlackClient", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, value_type TEXT NOT NULL DEFAULT 'string', updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    setStringSetting(db, SETTING_SLACK_BOT_TOKEN, "xoxb-test-token");
    stubFetch();
    nextOk = true;
  });

  afterEach(() => {
    db.close();
    globalThis.fetch = realFetch;
  });

  it("postMessage to a channel ID posts directly (no resolution) with Bearer auth", async () => {
    nextResponse = { ok: true, channel: "C123", ts: "1700000000.000100" };
    const client = new SlackClient(db);
    const r = await client.postMessage("C123", "hello", { thread_ts: "t1" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxb-test-token");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ channel: "C123", text: "hello", thread_ts: "t1" });
    expect(r).toEqual({ channel: "C123", ts: "1700000000.000100" });
  });

  it("postMessage resolves #name to an id via conversations.list, then posts to the id", async () => {
    responseFor["conversations.list"] = { ok: true, channels: [{ id: "C777", name: "capstone-ghas-reports" }] };
    responseFor["chat.postMessage"] = { ok: true, channel: "C777", ts: "1.2" };
    const client = new SlackClient(db);
    const r = await client.postMessage("#capstone-ghas-reports", "hi");

    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["conversations.list", "chat.postMessage"]);
    expect(JSON.parse(String(calls[1]!.init.body)).channel).toBe("C777");
    expect(r.channel).toBe("C777");
  });

  it("postMessage throws channel_not_found when the #name is not visible to the app", async () => {
    responseFor["conversations.list"] = { ok: true, channels: [{ id: "C1", name: "other" }], response_metadata: { next_cursor: "" } };
    const client = new SlackClient(db);
    await expect(client.postMessage("#missing", "hi")).rejects.toThrow(/channel_not_found/);
  });

  it("lookupUserByEmail returns the resolved user id", async () => {
    nextResponse = { ok: true, user: { id: "U999" } };
    const client = new SlackClient(db);
    const id = await client.lookupUserByEmail("a@b.com");
    expect(calls[0]!.url).toBe("https://slack.com/api/users.lookupByEmail");
    expect(id).toBe("U999");
  });

  it("openDm returns the DM channel id", async () => {
    nextResponse = { ok: true, channel: { id: "D555" } };
    const client = new SlackClient(db);
    const dm = await client.openDm("U999");
    expect(calls[0]!.url).toBe("https://slack.com/api/conversations.open");
    expect(dm).toBe("D555");
  });

  it("readChannel hits conversations.history with window bounds and maps messages", async () => {
    nextResponse = { ok: true, messages: [
      { user: "U1", text: "hi", ts: "1700000002.0" },
      { bot_id: "B2", text: "beep", ts: "1700000001.0" },
    ] };
    const client = new SlackClient(db);
    const msgs = await client.readChannel("C123", { oldest: "1700000000", latest: "1700000005", limit: 10 });
    expect(calls[0]!.url).toBe("https://slack.com/api/conversations.history");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ channel: "C123", limit: 10, oldest: "1700000000", latest: "1700000005" });
    expect(msgs).toEqual([
      { user: "U1", text: "hi", ts: "1700000002.0" },
      { user: "B2", text: "beep", ts: "1700000001.0" },
    ]);
  });

  it("throws the Slack error string on ok:false", async () => {
    nextResponse = { ok: false, error: "channel_not_found" };
    const client = new SlackClient(db);
    await expect(client.postMessage("#nope", "hi")).rejects.toThrow("channel_not_found");
  });

  it("throws when no bot token is configured", async () => {
    db.exec("DELETE FROM app_settings");
    const client = new SlackClient(db);
    await expect(client.authTest()).rejects.toThrow("not configured");
  });
});
