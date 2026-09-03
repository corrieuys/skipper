import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { saveSlackConfig } from "../config/slack-settings";
import { eventBus } from "../events/bus";
import { SlackPushManager } from "./push";

let db: Database;
let mgr: SlackPushManager;
let origFetch: typeof fetch;
let origArgv: string[];
let posts: Array<{ url: string; body: Record<string, unknown> }>;

/** A task's Slack conversation — the precondition for any push. */
const ORIGIN = { channel: "C-origin", thread_ts: "1700.500", user_id: "U9" };

function seedTeam(slackEnabled: boolean, taskConfig?: Record<string, unknown>): void {
  db.prepare(
    "INSERT INTO local_teams (id, name, skipper_prompt, hooks, phases, agents, team_config) VALUES ('team-1','T','','[]','[]','[]',?)",
  ).run(JSON.stringify({ slackEnabled }));
  db.prepare("INSERT INTO tasks (id, title, team_id, status, task_config) VALUES ('task-1','Add webhook','team-1','active',?)").run(
    JSON.stringify(taskConfig ?? {}),
  );
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  db.exec("PRAGMA foreign_keys=OFF");
  saveSlackConfig(db, { botToken: "xoxb-x", defaultChannel: "C1" });

  origArgv = process.argv;
  process.argv = [...origArgv, "--experimental"];

  posts = [];
  origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true, ts: "1.1", channel: "C1" }), { status: 200 });
  }) as typeof fetch;

  mgr = new SlackPushManager(db);
  mgr.start();
});

afterEach(() => {
  mgr.stop();
  globalThis.fetch = origFetch;
  process.argv = origArgv;
  db.close();
});

function fireEscalation(): void {
  eventBus.emit("escalation:created", {
    escalationId: "e1",
    agentId: "a1",
    taskId: "task-1",
    type: "agent_request",
    question: "Which DB for staging?",
  });
}

describe("SlackPushManager gating", () => {
  it("posts an escalation into the task's origin thread with action buttons", async () => {
    seedTeam(true, { slack_origin: ORIGIN });
    fireEscalation();
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toContain("chat.postMessage");
    expect(posts[0]!.body.channel).toBe("C-origin");
    const blocks = posts[0]!.body.blocks as Array<{ type: string; elements?: Array<{ value: string }> }>;
    const values = blocks.find((b) => b.type === "actions")?.elements?.map((e) => e.value) ?? [];
    expect(values).toContain("esc:respond:e1");
  });

  it("posts into the originating thread when the task carries a Slack origin", async () => {
    seedTeam(true, { slack_origin: { channel: "C-origin", thread_ts: "1700.500", user_id: "U9" } });
    fireEscalation();
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.channel).toBe("C-origin");
    expect(posts[0]!.body.thread_ts).toBe("1700.500");
  });

  it("posts into a thread the agent itself opened (agent_message origin)", async () => {
    seedTeam(true, { slack_origin: { channel: "C-report", thread_ts: "1800.900", source: "agent_message" } });
    fireEscalation();
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.channel).toBe("C-report");
    expect(posts[0]!.body.thread_ts).toBe("1800.900");
  });

  // No default-channel fallback: a task that never touched Slack has no thread to
  // be answered in, so its escalation would land context-free in a shared channel.
  it("does not post when the task has no Slack origin, even with a default channel set", async () => {
    seedTeam(true);
    fireEscalation();
    await flush();
    expect(posts).toHaveLength(0);
  });

  it("does not post when the task's team has Slack disabled", async () => {
    seedTeam(false, { slack_origin: ORIGIN });
    fireEscalation();
    await flush();
    expect(posts).toHaveLength(0);
  });

  it("does not post when there is no bot token configured", async () => {
    seedTeam(true, { slack_origin: ORIGIN });
    saveSlackConfig(db, { botToken: "", defaultChannel: "" });
    // Clear the token set in beforeEach so isSlackConfigured is false.
    db.prepare("DELETE FROM app_settings WHERE key = 'slack_bot_token'").run();
    fireEscalation();
    await flush();
    expect(posts).toHaveLength(0);
  });

  it("posts a phase-review message only when a review opens", async () => {
    seedTeam(true, { slack_origin: ORIGIN });
    eventBus.emit("task:needs_review_changed", { taskId: "task-1", needsReview: false });
    await flush();
    expect(posts).toHaveLength(0);

    eventBus.emit("task:needs_review_changed", { taskId: "task-1", needsReview: true, phaseName: "build", phaseIndex: 1 });
    await flush();
    expect(posts).toHaveLength(1);
    const blocks = posts[0]!.body.blocks as Array<{ type: string; elements?: Array<{ value: string }> }>;
    const values = blocks.find((b) => b.type === "actions")?.elements?.map((e) => e.value) ?? [];
    expect(values).toContain("rev:approve:task-1");
  });

  it("posts a run-completed notice into the origin thread, pointing at the thread-reply input flow", async () => {
    seedTeam(true, { slack_origin: { channel: "C-origin", thread_ts: "1700.500" } });
    eventBus.emit("task:run_completed", { taskId: "task-1", result: null });
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.channel).toBe("C-origin");
    expect(posts[0]!.body.thread_ts).toBe("1700.500");
    expect(String(posts[0]!.body.text)).toContain("finished its run");
    expect(String(posts[0]!.body.text)).toContain("Reply in this thread");
    // The unified model has no Iterate button — the notice is a plain section.
    const blocks = posts[0]!.body.blocks as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
  });

  it("posts a run-failed notice into the origin thread when a run fails", async () => {
    seedTeam(true, { slack_origin: { channel: "C-origin", thread_ts: "1700.500" } });
    eventBus.emit("task:run_failed", { taskId: "task-1", error: "boom" });
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.thread_ts).toBe("1700.500");
    expect(String(posts[0]!.body.text)).toContain("failed");
    expect(String(posts[0]!.body.text)).toContain("Reply in this thread");
  });

  it("does not post a run-completed notice for a task with no Slack thread origin", async () => {
    seedTeam(true); // no slack_origin
    eventBus.emit("task:run_completed", { taskId: "task-1", result: null });
    await flush();
    expect(posts).toHaveLength(0);
  });

  it("posts the run-completed notice with no default channel set (thread-only, daemon default)", async () => {
    seedTeam(true, { slack_origin: { channel: "C-origin", thread_ts: "1700.500" } });
    saveSlackConfig(db, { botToken: "xoxb-x", defaultChannel: "" });
    eventBus.emit("task:run_completed", { taskId: "task-1", result: null });
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.thread_ts).toBe("1700.500");
  });

  it("stops posting after stop()", async () => {
    seedTeam(true, { slack_origin: ORIGIN });
    mgr.stop();
    fireEscalation();
    await flush();
    expect(posts).toHaveLength(0);
  });
});

describe("operator messages", () => {
  function fireMessage(content = "Fixed the signup form. Testing it now."): void {
    eventBus.emit("task:message_posted", {
      messageId: "m1",
      taskId: "task-1",
      agentId: "agent-1",
      content,
    });
  }

  function seedAgent(name: string): void {
    db.prepare("INSERT INTO agents (id, name, type) VALUES ('agent-1', ?, 'claude-code')").run(name);
  }

  it("posts into the origin thread, attributed to the agent, with no buttons", async () => {
    seedTeam(true, { slack_origin: ORIGIN });
    seedAgent("Skipper");
    fireMessage();
    await flush();

    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.channel).toBe("C-origin");
    expect(posts[0]!.body.thread_ts).toBe("1700.500");
    const blocks = posts[0]!.body.blocks as Array<{ type: string; text?: { text: string } }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("section");
    expect(blocks[0]!.text!.text).toBe(":speech_balloon: *Skipper*: Fixed the signup form. Testing it now.");
    // Nothing to act on — an operator message is not a question.
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
    // Fallback text carries the task title for notifications / no-blocks clients.
    expect(posts[0]!.body.text).toContain("Add webhook");
  });

  it("falls back to the agent id when no agent row matches", async () => {
    seedTeam(true, { slack_origin: ORIGIN });
    fireMessage();
    await flush();

    const blocks = posts[0]!.body.blocks as Array<{ text?: { text: string } }>;
    expect(blocks[0]!.text!.text).toContain("*agent-1*");
  });

  it("does not post when the task has no Slack origin", async () => {
    seedTeam(true);
    seedAgent("Skipper");
    fireMessage();
    await flush();
    expect(posts).toHaveLength(0);
  });

  it("does not post when the task's team has Slack disabled", async () => {
    seedTeam(false, { slack_origin: ORIGIN });
    seedAgent("Skipper");
    fireMessage();
    await flush();
    expect(posts).toHaveLength(0);
  });

  it("stops posting after stop()", async () => {
    seedTeam(true, { slack_origin: ORIGIN });
    seedAgent("Skipper");
    mgr.stop();
    fireMessage();
    await flush();
    expect(posts).toHaveLength(0);
  });
});
