import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { startServer, setWebSocketUpgradeHandlers, setWebSocketHandlers } from "../server";
import { UIWebSocketManager } from "./ui-push";
import type { ManagerDaemon } from "../agents/manager-daemon";
import { eventBus } from "../events/bus";

let server: Server<unknown>;
let manager: UIWebSocketManager;
let db: Database;
let port: number;

const fakeDaemon = {
  listRuntimeSteeringOptions: () => [],
} as unknown as ManagerDaemon;

beforeAll(() => {
  db = new Database(":memory:");
  initializeDatabase(db);

  // One running task with one running agent that has emitted an assistant line.
  db.prepare("INSERT INTO agents (id, name, type, model, config, capabilities) VALUES ('a-tmpl','Claude','codex','default','{}','[]')").run();
  db.prepare("INSERT INTO tasks (id, title, status, started_at) VALUES ('task-1','Fix auth','active',datetime('now'))").run();
  db.prepare("INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('inst-1','task-1','a-tmpl','running')").run();
  db.prepare("INSERT INTO terminal_outputs (agent_id, stream, data, sequence) VALUES (?, 'stdout', ?, 1)").run(
    "inst-1",
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Ran tests, 3 failing" }] } }),
  );
  // A milestone note (create_note) — the milestones pane reads these, not stdout.
  db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content) VALUES ('note-1','task-1','inst-1','Auth refactor plan approved')").run();

  manager = new UIWebSocketManager(db, fakeDaemon);
  setWebSocketUpgradeHandlers([(req, s) => manager.tryUpgrade(req, s as never)]);
  setWebSocketHandlers({ "ui-push": manager.wsHandlers as never });
  server = startServer(0);
  port = server.port;
});

afterAll(() => {
  manager.destroy();
  server.stop(true);
  db.close();
});

function firstMessage(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no snapshot received in time"));
    }, 3000);
    ws.addEventListener("message", (ev) => {
      clearTimeout(timer);
      ws.close();
      resolve(typeof ev.data === "string" ? ev.data : "");
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`ws error: ${String(e)}`));
    });
  });
}

/** Collect JSON frames on a dashboard socket until `done` says stop (or the timeout). */
function collectFrames(url: string, onOpen: () => void, done: (frames: Array<{ resource: string; data: Record<string, unknown> }>) => boolean): Promise<Array<{ resource: string; data: Record<string, unknown> }>> {
  return new Promise((resolve, reject) => {
    const frames: Array<{ resource: string; data: Record<string, unknown> }> = [];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error(`timed out; saw ${frames.map((f) => f.resource).join(",")}`)); }, 3000);
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string" || !ev.data.startsWith("{")) return;
      const frame = JSON.parse(ev.data) as { resource: string; data: Record<string, unknown> };
      frames.push(frame);
      if (frame.resource === "dashboard:snapshot") onOpen();
      if (done(frames)) { clearTimeout(timer); ws.close(); resolve(frames); }
    });
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(new Error(`ws error: ${String(e)}`)); });
  });
}

describe("dashboard lanes on instance liveness", () => {
  it("an instance exit re-pushes the roster AND the header metrics", async () => {
    const frames = await collectFrames(
      `ws://localhost:${port}/ws/ui?format=json&topics=dashboard`,
      () => {
        db.prepare("UPDATE agent_instances SET status = 'completed' WHERE id = 'inst-1'").run();
        eventBus.emit("instance:state_changed", { instanceId: "inst-1", templateAgentId: "a-tmpl", taskId: "task-1", parentInstanceId: null, rootInstanceId: null, status: "completed" });
      },
      (fs) => fs.some((f) => f.resource === "dashboard:instances") && fs.some((f) => f.resource === "dashboard:metrics"),
    );
    const instances = frames.find((f) => f.resource === "dashboard:instances")!;
    const metrics = frames.find((f) => f.resource === "dashboard:metrics")!;
    expect(instances.data.running_instances).toHaveLength(0);
    expect(metrics.data.activeAgentCount).toBe(0);
    // restore for the other tests in this file
    db.prepare("UPDATE agent_instances SET status = 'running' WHERE id = 'inst-1'").run();
  });
});

describe("UI WS JSON snapshot on connect", () => {
  it("pushes a full dashboard snapshot to a json client immediately on open", async () => {
    const raw = await firstMessage(`ws://localhost:${port}/ws/ui?format=json&topics=dashboard`);
    const msg = JSON.parse(raw) as { resource: string; data: { tasks: unknown[]; running_instances: unknown[]; metrics: { running: number }; phase_indicator: unknown; activity: Array<{ kind: string; text: string }> } };

    expect(msg.resource).toBe("dashboard:snapshot");
    expect(msg.data.tasks).toHaveLength(1);
    expect(msg.data.running_instances).toHaveLength(1);
    expect(msg.data.metrics.running).toBe(1);
    // the output feed carries the streaming stdout line AND the note (kind:note)
    expect(msg.data.activity.some((a) => a.text.includes("Ran tests"))).toBe(true);
    expect(msg.data.activity.some((a) => a.kind === "note" && a.text.includes("Auth refactor plan approved"))).toBe(true);
  });
});
