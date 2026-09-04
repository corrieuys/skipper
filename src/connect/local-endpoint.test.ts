import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { eventBus } from "../events/bus";
import type { WSData } from "../ws/types";
import type { ResourceDeps } from "./resources";
import { createConnectLocalEndpoint, isLoopbackAddress, type ConnectLocalEndpoint } from "./local-endpoint";

let endpoint: ConnectLocalEndpoint;
let server: Server<WSData> | null = null;

function startTestServer(): Server<WSData> {
  return Bun.serve<WSData>({
    port: 0,
    fetch(req, srv) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (endpoint.tryUpgrade(req, srv as unknown as Server<WSData>)) {
          return undefined as unknown as Response;
        }
      }
      return endpoint.routeHandler();
    },
    websocket: {
      open(ws) {
        endpoint.wsHandlers.open(ws as ServerWebSocket<WSData>);
      },
      message(ws, msg) {
        endpoint.wsHandlers.message(ws as ServerWebSocket<WSData>, msg as string | Buffer);
      },
      close(ws) {
        endpoint.wsHandlers.close(ws as ServerWebSocket<WSData>);
      },
    },
  });
}

/** Collects frames off a client socket and lets tests await a matching one. */
class FrameCollector {
  readonly frames: Record<string, unknown>[] = [];
  constructor(ws: WebSocket) {
    ws.onmessage = (ev: MessageEvent) => {
      try {
        this.frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    };
  }
  find(pred: (f: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
    return this.frames.find(pred);
  }
  async waitFor(pred: (f: Record<string, unknown>) => boolean, timeoutMs = 2_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.find(pred);
      if (hit) return hit;
      await Bun.sleep(10);
    }
    throw new Error(`timed out waiting for frame; saw: ${this.frames.map((f) => String(f.type)).join(",")}`);
  }
}

async function openClient(): Promise<{ ws: WebSocket; frames: FrameCollector }> {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/connect/local`);
  const frames = new FrameCollector(ws);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("client socket error"));
  });
  return { ws, frames };
}

function seed(): { taskId: string; instanceId: string } {
  const db = getDb();
  db.prepare("INSERT INTO teams (id, name) VALUES ('team-1', 'Team')").run();
  db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES ('task-1', 'Local Task', 'team-1', 'active')").run();
  db.prepare("INSERT INTO agents (id, name, type) VALUES ('tmpl-1', 'Tail Agent', 'claude-code')").run();
  db.prepare(
    "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('inst-1', 'task-1', 'tmpl-1', 'running')",
  ).run();
  return { taskId: "task-1", instanceId: "inst-1" };
}

function insertTerminalRow(instanceId: string, data: string, sequence: number): void {
  getDb()
    .prepare("INSERT INTO terminal_outputs (agent_id, session_id, stream, data, sequence) VALUES (?, NULL, 'stdout', ?, ?)")
    .run(instanceId, data, sequence);
}

const busListenerCount = () =>
  eventBus.listenerCount("agent:output") + eventBus.listenerCount("task:state_changed");

beforeEach(() => {
  resetDb();
  initializeDatabase(getDb(":memory:"));
  endpoint = createConnectLocalEndpoint({} as unknown as ResourceDeps);
  server = startTestServer();
});

afterEach(() => {
  endpoint.destroy();
  server?.stop(true);
  server = null;
  resetDb();
});

describe("isLoopbackAddress", () => {
  it("accepts loopback forms only", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.1.2.3")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.10")).toBe(false);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });
});

describe("connect local endpoint", () => {
  it("refuses to upgrade a non-loopback peer", () => {
    let upgraded = false;
    const fakeServer = {
      requestIP: () => ({ address: "192.168.1.44", family: "IPv4", port: 51234 }),
      upgrade: () => {
        upgraded = true;
        return true;
      },
    } as unknown as Server<WSData>;
    const req = new Request("http://10.0.0.2:5005/connect/local", { headers: { upgrade: "websocket" } });
    expect(endpoint.tryUpgrade(req, fakeServer)).toBe(false);
    expect(upgraded).toBe(false);
  });

  it("answers a non-upgraded GET with 403", async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/connect/local`);
    expect(res.status).toBe(403);
  });

  it("sends auth_ok then capabilities on open", async () => {
    const { ws, frames } = await openClient();
    await frames.waitFor((f) => f.type === "auth_ok");
    const caps = await frames.waitFor((f) => f.type === "event" && f.event === "connect:capabilities");
    expect(frames.frames[0]!.type).toBe("auth_ok");
    const payload = caps.payload as { protocolVersion: number; features: string[] };
    expect(payload.protocolVersion).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(payload.features)).toBe(true);
    ws.close();
  });

  it("round trips a tasks/list request", async () => {
    seed();
    const { ws, frames } = await openClient();
    await frames.waitFor((f) => f.type === "auth_ok");
    ws.send(JSON.stringify({ type: "request", id: "r1", resource: "tasks", action: "list", params: {} }));
    const res = await frames.waitFor((f) => f.type === "response" && f.id === "r1");
    expect(res.ok).toBe(true);
    const tasks = res.data as Array<{ id: string }>;
    expect(tasks.some((t) => t.id === "task-1")).toBe(true);
    ws.close();
  });

  it("answers ping with pong", async () => {
    const { ws, frames } = await openClient();
    await frames.waitFor((f) => f.type === "auth_ok");
    ws.send(JSON.stringify({ type: "ping" }));
    await frames.waitFor((f) => f.type === "pong");
    ws.close();
  });

  it("subscribes to outputs: ack, backfill, then a live frame; unsubscribe stops frames", async () => {
    const { taskId, instanceId } = seed();
    insertTerminalRow(instanceId, "history line", 1);

    const { ws, frames } = await openClient();
    await frames.waitFor((f) => f.type === "auth_ok");

    ws.send(JSON.stringify({ type: "subscribe", channel: "outputs", taskId }));
    const ack = await frames.waitFor((f) => f.type === "subscribed");
    expect(ack.taskId).toBe(taskId);

    const backfill = await frames.waitFor((f) => f.type === "output_batch" && f.backfill === true);
    const backfillEntries = backfill.entries as Array<{ data: string }>;
    expect(backfillEntries.some((e) => e.data.includes("history line"))).toBe(true);

    eventBus.emit("agent:output", { agentId: instanceId, stream: "stdout", data: "live line", sequence: 2 });
    const live = await frames.waitFor(
      (f) => f.type === "output_batch" && !f.backfill && (f.entries as Array<{ data: string }>).some((e) => e.data.includes("live line")),
    );
    expect(live.taskId).toBe(taskId);

    ws.send(JSON.stringify({ type: "unsubscribe", channel: "outputs", taskId }));
    await frames.waitFor((f) => f.type === "unsubscribed");

    const before = frames.frames.length;
    eventBus.emit("agent:output", { agentId: instanceId, stream: "stdout", data: "after unsubscribe", sequence: 3 });
    await Bun.sleep(200);
    const after = frames.frames.slice(before);
    expect(after.some((f) => f.type === "output_batch")).toBe(false);

    ws.close();
  });

  it("rejects a subscribe with no taskId", async () => {
    const { ws, frames } = await openClient();
    await frames.waitFor((f) => f.type === "auth_ok");
    ws.send(JSON.stringify({ type: "subscribe", channel: "outputs", taskId: "" }));
    const err = await frames.waitFor((f) => f.type === "sub_error");
    expect(String(err.error)).toContain("taskId");
    ws.close();
  });

  it("detaches session, tail and bus listeners on close", async () => {
    const { taskId } = seed();
    const baseline = busListenerCount();

    const { ws, frames } = await openClient();
    await frames.waitFor((f) => f.type === "auth_ok");
    ws.send(JSON.stringify({ type: "subscribe", channel: "outputs", taskId }));
    await frames.waitFor((f) => f.type === "subscribed");
    expect(endpoint.socketCount()).toBe(1);
    expect(busListenerCount()).toBeGreaterThan(baseline);

    ws.close();
    const deadline = Date.now() + 2_000;
    while (endpoint.socketCount() !== 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(endpoint.socketCount()).toBe(0);
    expect(busListenerCount()).toBe(baseline);
  });
});
