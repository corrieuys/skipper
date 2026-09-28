import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { TaskScheduler } from "../tasks/scheduler";
import { GlobalStoreManager } from "../global-store/manager";
import { ArtifactManager } from "../orchestrator/artifact-manager";
import { eventBus } from "../events/bus";
import { DaemonMcpServer } from "./server";
import type { DaemonDeps } from "./tools";

// Session lifetime: a killed agent CLI never sends DELETE /mcp, so the
// daemon has to drop its sessions when the process exits (`agent:exit`).

let db: Database;
let mcp: DaemonMcpServer;
let listenersBefore: number;

const TASK = "task-mcp-sessions";
// Unique ids, so a listener another test file left on the shared bus never matches.
const RUNTIME_A = `rt-a-${crypto.randomUUID()}`;
const RUNTIME_B = `rt-b-${crypto.randomUUID()}`;

function deps(): DaemonDeps {
  return {
    db,
    taskScheduler: new TaskScheduler(db),
    globalStoreManager: new GlobalStoreManager(db),
    artifactManager: new ArtifactManager(db),
    agentManager: {} as DaemonDeps["agentManager"],
    delegationManager: {} as DaemonDeps["delegationManager"],
    phaseManager: {} as DaemonDeps["phaseManager"],
    escalationManager: {} as DaemonDeps["escalationManager"],
  };
}

function request(method: "POST" | "GET", token: string, opts: { sessionId?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: method === "GET" ? "text/event-stream" : "application/json, text/event-stream",
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.sessionId) headers["mcp-session-id"] = opts.sessionId;
  return new Request("http://localhost/mcp", {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

async function openSession(token: string): Promise<string> {
  const res = await mcp.handleRequest(request("POST", token, {
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    },
  }));
  expect(res.status).toBe(200);
  await res.text();
  const sessionId = res.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

/** HTTP status of a tools/list call on an existing session. */
async function listTools(token: string, sessionId: string): Promise<number> {
  const res = await mcp.handleRequest(request("POST", token, {
    sessionId,
    body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  }));
  await res.text();
  return res.status;
}

/** The server's live session ids (private map, read for the leak assertion). */
function sessionIds(): string[] {
  return [...(mcp as unknown as { sessions: Map<string, unknown> }).sessions.keys()];
}

/** True when the stream ends within `ms` (its transport was closed). */
async function streamEnds(body: ReadableStream<Uint8Array>, ms: number): Promise<boolean> {
  const reader = body.getReader();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const timeout = new Promise<"open">((resolve) => setTimeout(() => resolve("open"), Math.max(1, deadline - Date.now())));
    const next = await Promise.race([reader.read(), timeout]);
    if (next === "open") return false;
    if (next.done) return true;
  }
  return false;
}

function exit(agentId: string): void {
  eventBus.emit("agent:exit", {
    agentId,
    code: 143,
    isRespawn: false,
    hasDelegation: false,
    stderrSnippet: "",
    streamsDrained: true,
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  db.prepare("INSERT OR IGNORE INTO agents (id, name, type, model) VALUES ('mcp-test-agent', 'T', 'claude-code', 'default')").run();
  db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, 'mcp sessions', 'active')").run(TASK);
  const instance = db.prepare(
    "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES (?, ?, 'mcp-test-agent', 'running')",
  );
  instance.run(RUNTIME_A, TASK);
  instance.run(RUNTIME_B, TASK);
  listenersBefore = eventBus.listenerCount("agent:exit");
  mcp = new DaemonMcpServer(db, deps());
});

afterEach(() => {
  mcp.close();
  db.close();
});

describe("DaemonMcpServer session eviction on agent exit", () => {
  it("closes and drops every session of a runtime when its process exits", async () => {
    const a1 = await openSession(RUNTIME_A);
    const a2 = await openSession(RUNTIME_A);
    const b1 = await openSession(RUNTIME_B);
    // An open SSE stream on one of A's sessions: it must end, not just be forgotten.
    const sse = await mcp.handleRequest(request("GET", RUNTIME_A, { sessionId: a1 }));
    expect(sse.status).toBe(200);
    expect(sessionIds().sort()).toEqual([a1, a2, b1].sort());

    exit(RUNTIME_A);

    expect(sessionIds()).toEqual([b1]);
    expect(await streamEnds(sse.body!, 1000)).toBe(true);
    // A's session ids are unknown now: a fresh, uninitialized transport answers 400.
    expect(await listTools(RUNTIME_A, a2)).toBe(400);
    // Another runtime's session is untouched.
    expect(await listTools(RUNTIME_B, b1)).toBe(200);
  });

  it("keeps a session opened after the exit (a respawn under the same runtime id)", async () => {
    await openSession(RUNTIME_A);
    exit(RUNTIME_A);

    const respawned = await openSession(RUNTIME_A);
    expect(sessionIds()).toEqual([respawned]);
    expect(await listTools(RUNTIME_A, respawned)).toBe(200);

    // Another runtime's exit leaves it alone; its own process exit ends it.
    exit(RUNTIME_B);
    expect(sessionIds()).toEqual([respawned]);
    expect(await listTools(RUNTIME_A, respawned)).toBe(200);
    exit(RUNTIME_A);
    expect(sessionIds()).toEqual([]);
  });

  it("subscribes once and unsubscribes on close", () => {
    expect(eventBus.listenerCount("agent:exit")).toBe(listenersBefore + 1);
    mcp.close();
    expect(eventBus.listenerCount("agent:exit")).toBe(listenersBefore);
  });
});
