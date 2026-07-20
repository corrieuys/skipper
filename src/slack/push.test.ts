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

function seedTeam(slackEnabled: boolean): void {
  db.prepare(
    "INSERT INTO local_teams (id, name, skipper_prompt, hooks, phases, agents, team_config) VALUES ('team-1','T','','[]','[]','[]',?)",
  ).run(JSON.stringify({ slackEnabled }));
  db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES ('task-1','Add webhook','team-1','running')").run();
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  db.exec("PRAGMA foreign_keys=OFF");
  saveSlackConfig(db, { botToken: "xoxb-x", defaultChannel: "C1", pushEnabled: true });

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
  it("posts an escalation to the default channel when the team has Slack enabled", async () => {
    seedTeam(true);
    fireEscalation();
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toContain("chat.postMessage");
    expect(posts[0]!.body.channel).toBe("C1");
    const blocks = posts[0]!.body.blocks as Array<{ type: string; elements?: Array<{ value: string }> }>;
    const values = blocks.find((b) => b.type === "actions")?.elements?.map((e) => e.value) ?? [];
    expect(values).toContain("esc:respond:e1");
  });

  it("does not post when the task's team has Slack disabled", async () => {
    seedTeam(false);
    fireEscalation();
    await flush();
    expect(posts).toHaveLength(0);
  });

  it("does not post when push is disabled", async () => {
    seedTeam(true);
    saveSlackConfig(db, { botToken: "xoxb-x", defaultChannel: "C1", pushEnabled: false });
    fireEscalation();
    await flush();
    expect(posts).toHaveLength(0);
  });

  it("posts a phase-review message only when a review opens", async () => {
    seedTeam(true);
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

  it("stops posting after stop()", async () => {
    seedTeam(true);
    mgr.stop();
    fireEscalation();
    await flush();
    expect(posts).toHaveLength(0);
  });
});
