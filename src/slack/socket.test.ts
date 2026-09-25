import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { clearAgentTypeCache } from "../agents/types";
import { setStringSetting } from "../config/app-settings";
import { SETTING_SLACK_ALLOWED_USERS } from "../config/slack-settings";
import { SlackSocketManager } from "./socket";

let db: Database;
let manager: SlackSocketManager;
let inputs: Array<{ taskId: string; text: string; source?: string }>;
let wasExperimental: boolean;

// isExperimental() reads process.argv, and the thread-reply path gates on it.
function setExperimental(on: boolean): void {
  const idx = process.argv.indexOf("--experimental");
  if (on && idx === -1) process.argv.push("--experimental");
  if (!on && idx !== -1) process.argv.splice(idx, 1);
}

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  clearAgentTypeCache();
  db.prepare(
    "INSERT INTO agents (id, name, type, model) VALUES ('default-agent','Default','claude-code','default')",
  ).run();
  db.prepare(
    "INSERT INTO teams (id, name, entrypoint_agent_id) VALUES ('team-1','T','default-agent')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (id, title, team_id, status, task_config) VALUES ('task-1', 'Add webhook', 'team-1', 'active', ?)",
  ).run(JSON.stringify({ slack_origin: { channel: "C1", thread_ts: "1700.5" } }));
  setStringSetting(db, SETTING_SLACK_ALLOWED_USERS, JSON.stringify(["U_ALLOWED"]));

  inputs = [];
  manager = new SlackSocketManager(db, {} as never, {} as never, {} as never, {} as never, async (taskId, text, source) => {
    inputs.push({ taskId, text, source });
    return { delivered: "queued" };
  });
  wasExperimental = process.argv.includes("--experimental");
  setExperimental(true);
});

afterEach(() => {
  setExperimental(wasExperimental);
  db.close();
});

/** A human reply in task-1's origin thread that mentions Skipper. */
function reply(event: Record<string, unknown>): Promise<void> {
  const handler = manager as unknown as { handleThreadReply(e: Record<string, unknown>): Promise<void> };
  return handler.handleThreadReply({
    type: "message",
    channel: "C1",
    thread_ts: "1700.5",
    ts: "1700.9",
    text: "Skipper, use the staging DB",
    ...event,
  });
}

describe("SlackSocketManager thread replies", () => {
  it("delivers a reply from an allowlisted user to the task", async () => {
    await reply({ user: "U_ALLOWED" });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ taskId: "task-1", source: "slack" });
    expect(inputs[0]!.text).toContain("use the staging DB");
  });

  it("does not deliver a reply from a user who is not on the allowlist", async () => {
    await reply({ user: "U_STRANGER" });
    expect(inputs).toHaveLength(0);
  });

  it("does not deliver a reply with no user id (fail closed)", async () => {
    await reply({});
    expect(inputs).toHaveLength(0);
  });

  it("does not deliver any reply while the allowlist is empty", async () => {
    setStringSetting(db, SETTING_SLACK_ALLOWED_USERS, "[]");
    await reply({ user: "U_ALLOWED" });
    expect(inputs).toHaveLength(0);
  });
});
