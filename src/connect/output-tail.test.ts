import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { eventBus } from "../events/bus";
import { OutputTailManager } from "./output-tail";
import type { OutputBatchEntry } from "./protocol";

interface BatchFrame {
  type: "output_batch";
  taskId: string;
  seq: number;
  entries: OutputBatchEntry[];
}

let frames: BatchFrame[];
let manager: OutputTailManager | null;

function capture(frame: string): void {
  frames.push(JSON.parse(frame) as BatchFrame);
}

function seed(): { taskId: string; otherTaskId: string; instanceId: string; otherInstanceId: string } {
  const db = getDb();
  db.prepare("INSERT INTO teams (id, name) VALUES ('team-1', 'Team')").run();
  db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES ('task-1', 'Watched', 'team-1', 'running')").run();
  db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES ('task-2', 'Unwatched', 'team-1', 'running')").run();
  db.prepare("INSERT INTO agents (id, name, type) VALUES ('tmpl-1', 'Tail Agent', 'claude-code')").run();
  db.prepare(
    "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('inst-1', 'task-1', 'tmpl-1', 'running')",
  ).run();
  db.prepare(
    "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('inst-2', 'task-2', 'tmpl-1', 'running')",
  ).run();
  return { taskId: "task-1", otherTaskId: "task-2", instanceId: "inst-1", otherInstanceId: "inst-2" };
}

function emitOutput(agentId: string, data: string): void {
  eventBus.emit("agent:output", { agentId, stream: "stdout", data, sequence: 1 });
}

const busListenerCount = () =>
  eventBus.listenerCount("agent:output") +
  eventBus.listenerCount("agent:exit") +
  eventBus.listenerCount("task:state_changed");

beforeEach(() => {
  resetDb();
  initializeDatabase(getDb(":memory:"));
  frames = [];
  manager = null;
});

afterEach(() => {
  manager?.destroy();
  manager = null;
  resetDb();
});

describe("OutputTailManager", () => {
  it("batches output for subscribed tasks only, with agent names and seq", async () => {
    const { taskId, instanceId, otherInstanceId } = seed();
    manager = new OutputTailManager(getDb(), capture, { flushMs: 10, maxEntries: 50, maxBytes: 32_768 });
    manager.handleSubscribe(taskId);

    emitOutput(instanceId, "line 1");
    emitOutput(otherInstanceId, "other task noise");
    emitOutput(instanceId, "line 2");
    expect(frames).toHaveLength(0);

    await Bun.sleep(30);
    expect(frames).toHaveLength(1);
    expect(frames[0]!).toMatchObject({ type: "output_batch", taskId, seq: 1 });
    expect(frames[0]!.entries.map((e) => e.data)).toEqual(["line 1", "line 2"]);
    expect(frames[0]!.entries[0]!.agentName).toBe("Tail Agent");

    emitOutput(instanceId, "line 3");
    await Bun.sleep(30);
    expect(frames).toHaveLength(2);
    expect(frames[1]!.seq).toBe(2);
  });

  it("flushes early at maxEntries", () => {
    const { taskId, instanceId } = seed();
    manager = new OutputTailManager(getDb(), capture, { flushMs: 60_000, maxEntries: 3, maxBytes: 32_768 });
    manager.handleSubscribe(taskId);

    emitOutput(instanceId, "a");
    emitOutput(instanceId, "b");
    expect(frames).toHaveLength(0);
    emitOutput(instanceId, "c");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.entries).toHaveLength(3);
  });

  it("flushes early at maxBytes", () => {
    const { taskId, instanceId } = seed();
    manager = new OutputTailManager(getDb(), capture, { flushMs: 60_000, maxEntries: 50, maxBytes: 10 });
    manager.handleSubscribe(taskId);

    emitOutput(instanceId, "0123456789abcdef");
    expect(frames).toHaveLength(1);
  });

  it("ignores output from unknown agent instances", async () => {
    const { taskId } = seed();
    manager = new OutputTailManager(getDb(), capture, { flushMs: 10, maxEntries: 50, maxBytes: 32_768 });
    manager.handleSubscribe(taskId);

    emitOutput("ghost-instance", "who dis");
    await Bun.sleep(30);
    expect(frames).toHaveLength(0);
  });

  it("flushes and drops the subscription when the task reaches a terminal state", async () => {
    const { taskId, instanceId } = seed();
    const baseline = busListenerCount();
    manager = new OutputTailManager(getDb(), capture, { flushMs: 60_000, maxEntries: 50, maxBytes: 32_768 });
    manager.handleSubscribe(taskId);

    emitOutput(instanceId, "final words");
    eventBus.emit("task:state_changed", { taskId, previousStatus: "running", newStatus: "completed" });

    expect(frames).toHaveLength(1);
    expect(frames[0]!.entries[0]!.data).toBe("final words");

    // Subscription is gone: further output is ignored and listeners detached.
    emitOutput(instanceId, "after the end");
    await Bun.sleep(30);
    expect(frames).toHaveLength(1);
    expect(busListenerCount()).toBe(baseline);
  });

  it("attaches bus listeners lazily and detaches when the last subscription ends", () => {
    const { taskId } = seed();
    const baseline = busListenerCount();
    manager = new OutputTailManager(getDb(), capture, { flushMs: 10, maxEntries: 50, maxBytes: 32_768 });
    expect(busListenerCount()).toBe(baseline);

    manager.handleSubscribe(taskId);
    expect(busListenerCount()).toBe(baseline + 3);

    manager.handleUnsubscribe(taskId);
    expect(busListenerCount()).toBe(baseline);
  });

  it("reset clears buffers, subscriptions, and listeners", async () => {
    const { taskId, instanceId } = seed();
    const baseline = busListenerCount();
    manager = new OutputTailManager(getDb(), capture, { flushMs: 10, maxEntries: 50, maxBytes: 32_768 });
    manager.handleSubscribe(taskId);
    emitOutput(instanceId, "buffered");

    manager.reset();
    expect(busListenerCount()).toBe(baseline);
    await Bun.sleep(30);
    expect(frames).toHaveLength(0);
  });
});
