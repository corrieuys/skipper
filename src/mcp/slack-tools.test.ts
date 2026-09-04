import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { registerDaemonTools, type DaemonDeps } from "./tools";
import type { InternalAgentIdentity } from "./auth";
import { GlobalStoreManager } from "../global-store/manager";
import { createLocalTeam } from "../teams/local-teams";
import { setStringSetting } from "../config/app-settings";
import { SETTING_SLACK_BOT_TOKEN } from "../config/slack-settings";
import { readTaskSlackOrigin } from "../slack/slash-command";
import { SLACK_ESCALATION_SOFT_LIMIT } from "../slack/blocks";

// Registration (which tool exists for whom) is covered by
// `tools-registration.test.ts`. This file exercises what the Slack tools DO when
// invoked: the origin capture, which is the whole mechanism by which a task that
// nobody started from Slack acquires a thread for its escalations to land in.
// `stampTaskSlackOrigin` is unit-tested in `slack/slack-origin.test.ts`; what is
// tested here is the wiring, mainly which timestamp each send hands it.

let db: Database;
const TEST_DB = "test-mcp-slack-tools.db";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function makeFakeMcpServer(): { handlers: Map<string, ToolHandler>; server: unknown } {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, ...rest: unknown[]): void => {
      const handler = rest[rest.length - 1];
      if (typeof handler === "function") handlers.set(name, handler as ToolHandler);
    },
  };
  return { handlers, server };
}

/** Escalation manager stub: `escalate` only needs an id + status back. */
const escalationManagerStub = {
  handleEscalation: (_runtimeId: string, _q: string) => ({ id: "esc-1", status: "open" }),
} as unknown as DaemonDeps["escalationManager"];

function makeDeps(): DaemonDeps {
  return {
    db,
    agentManager: {} as DaemonDeps["agentManager"],
    delegationManager: {} as DaemonDeps["delegationManager"],
    phaseManager: {} as DaemonDeps["phaseManager"],
    taskScheduler: {} as DaemonDeps["taskScheduler"],
    escalationManager: escalationManagerStub,
    artifactManager: {} as DaemonDeps["artifactManager"],
    globalStoreManager: new GlobalStoreManager(db),
  };
}

const IDENTITY: InternalAgentIdentity = {
  type: "internal",
  runtimeId: "rt-1",
  templateAgentId: "skipper",
  taskId: "task-1",
};

/** Slack Web API calls this run made, in order, as `[method, body]`. */
let calls: Array<[string, Record<string, unknown>]>;
/** `chat.postMessage` timestamps handed out, oldest first. */
let postTimestamps: string[];
const realFetch = globalThis.fetch;

function stubSlackApi(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push([method, body]);
    const payload: Record<string, unknown> = { ok: true };
    if (method === "chat.postMessage") {
      payload.channel = body.channel;
      payload.ts = postTimestamps.shift() ?? "1700.999";
    }
    if (method === "conversations.open") payload.channel = { id: "D-dm" };
    if (method === "users.lookupByEmail") payload.user = { id: "U-email" };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

/** Register the tools for a Slack-enabled team + task and hand back the handlers. */
function registerTools(): Map<string, ToolHandler> {
  const team = createLocalTeam(db, {
    name: "T",
    phases: [{ name: "build", prompt: "", review: false }],
    config: { slackEnabled: true },
  });
  db.prepare("INSERT INTO tasks (id, title, team_id) VALUES (?, ?, ?)").run("task-1", "T1", team.id);
  const { server, handlers } = makeFakeMcpServer();
  registerDaemonTools(server as never, makeDeps(), () => IDENTITY);
  return handlers;
}

async function call(handlers: Map<string, ToolHandler>, name: string, args: Record<string, unknown>) {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`tool not registered: ${name}`);
  const res = await handler(args);
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  process.argv.push("--experimental");
  setStringSetting(db, SETTING_SLACK_BOT_TOKEN, "xoxb-abc");
  calls = [];
  postTimestamps = [];
  stubSlackApi();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  const i = process.argv.indexOf("--experimental");
  if (i !== -1) process.argv.splice(i, 1);
  db.close();
  try { require("fs").unlinkSync(TEST_DB); } catch {}
});

describe("slack_send_message — origin capture", () => {
  // A top-level post has no parent, so the message becomes the head of its own
  // thread: later pushes reply under it rather than spraying the channel.
  it("adopts the posted message's own ts as the thread when not replying", async () => {
    const handlers = registerTools();
    postTimestamps = ["1700.100"];

    const out = await call(handlers, "slack_send_message", { channel: "C-report", text: "nightly summary" });

    expect(readTaskSlackOrigin(db, "task-1")).toEqual({
      channel: "C-report",
      thread_ts: "1700.100",
      user_id: undefined,
      source: "agent_message",
    });
    expect(out.thread_ts).toBe("1700.100");
    expect(out.note).toContain("Slack home");
  });

  // Replying into someone else's thread joins THAT conversation; anchoring on the
  // reply's own ts would start a dead-end thread nobody is reading.
  it("adopts the parent thread when the send is a reply", async () => {
    const handlers = registerTools();
    postTimestamps = ["1700.200"];

    const out = await call(handlers, "slack_send_message", {
      channel: "C-report",
      text: "on it",
      thread_ts: "1699.000",
    });

    expect(readTaskSlackOrigin(db, "task-1")?.thread_ts).toBe("1699.000");
    // The reply's own ts is still reported, it just isn't the anchor.
    expect(out.ts).toBe("1700.200");
    expect(out.thread_ts).toBe("1699.000");
  });

  it("leaves the origin alone on later sends and drops the note", async () => {
    const handlers = registerTools();
    postTimestamps = ["1700.100", "1700.300"];

    await call(handlers, "slack_send_message", { channel: "C-first", text: "one" });
    const out = await call(handlers, "slack_send_message", { channel: "C-second", text: "two" });

    expect(readTaskSlackOrigin(db, "task-1")?.channel).toBe("C-first");
    // The note explains what capturing means, so it belongs only to the send that captured.
    expect(out.note).toBeUndefined();
    expect(out.channel).toBe("C-second");
  });

  it("keeps a slash-command origin when the agent posts elsewhere", async () => {
    const handlers = registerTools();
    db.prepare("UPDATE tasks SET task_config = ? WHERE id = 'task-1'").run(
      JSON.stringify({ slack_origin: { channel: "C-human", thread_ts: "1600.000", source: "slash_command" } }),
    );
    postTimestamps = ["1700.400"];

    const out = await call(handlers, "slack_send_message", { channel: "C-other", text: "fyi" });

    expect(readTaskSlackOrigin(db, "task-1")?.channel).toBe("C-human");
    expect(out.note).toBeUndefined();
  });
});

describe("slack_send_dm — origin capture", () => {
  // A DM is a conversation like any other, so the task's escalations follow the
  // person the agent chose to talk to.
  it("anchors on the DM channel and records who it is with", async () => {
    const handlers = registerTools();
    postTimestamps = ["1700.500"];

    const out = await call(handlers, "slack_send_dm", { user: "U-someone", text: "heads up" });

    expect(readTaskSlackOrigin(db, "task-1")).toEqual({
      channel: "D-dm",
      thread_ts: "1700.500",
      user_id: "U-someone",
      source: "agent_message",
    });
    expect(out.channel).toBe("D-dm");
    expect(out.note).toContain("Slack home");
  });

  it("resolves an email to a user id before opening the DM", async () => {
    const handlers = registerTools();
    postTimestamps = ["1700.600"];

    await call(handlers, "slack_send_dm", { user: "someone@example.com", text: "hi" });

    expect(calls.map(([m]) => m)).toEqual(["users.lookupByEmail", "conversations.open", "chat.postMessage"]);
    expect(readTaskSlackOrigin(db, "task-1")?.user_id).toBe("U-email");
  });
});

describe("escalate — Slack length warning", () => {
  const LONG = "x".repeat(SLACK_ESCALATION_SOFT_LIMIT + 1);

  it("warns when the question is too long for a task that reports to Slack", async () => {
    const handlers = registerTools();
    postTimestamps = ["1700.700"];
    await call(handlers, "slack_send_message", { channel: "C-report", text: "hello" });

    const out = await call(handlers, "escalate", { question: LONG });

    expect(out.escalation_id).toBe("esc-1");
    expect(String(out.slack_warning)).toContain(`~${SLACK_ESCALATION_SOFT_LIMIT} characters`);
  });

  // The limit is a property of the destination, not of the agent. A task with no
  // Slack thread has nothing to be truncated by, and the web UI shows it in full.
  it("stays quiet when the task has no Slack origin", async () => {
    const handlers = registerTools();

    const out = await call(handlers, "escalate", { question: LONG });

    expect(out.escalation_id).toBe("esc-1");
    expect(out.slack_warning).toBeUndefined();
  });

  it("stays quiet for a question that fits", async () => {
    const handlers = registerTools();
    postTimestamps = ["1700.800"];
    await call(handlers, "slack_send_message", { channel: "C-report", text: "hello" });

    const out = await call(handlers, "escalate", { question: "short question?" });

    expect(out.slack_warning).toBeUndefined();
  });
});
