import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { eventBus } from "../events/bus";
import { subscribeConnectEvents } from "./events";

interface Frame {
  type: string;
  event: string;
  payload: Record<string, unknown>;
  ts: string;
  source: string;
}

let frames: Frame[];
let cleanup: (() => void) | null;

function capture(frame: string): void {
  frames.push(JSON.parse(frame) as Frame);
}

function seedTask(): string {
  const db = getDb();
  db.prepare("INSERT INTO teams (id, name, phases) VALUES ('team-1', 'Team', ?)").run(
    JSON.stringify([{ name: "Build", prompt: "b" }, { name: "Review", prompt: "r" }]),
  );
  db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES ('task-1', 'Fat Task', 'team-1', 'running')").run();
  return "task-1";
}

beforeEach(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);
  frames = [];
  cleanup = null;
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  resetDb();
});

describe("subscribeConnectEvents", () => {
  it("announces capabilities immediately on subscribe", () => {
    cleanup = subscribeConnectEvents(capture);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe("connect:capabilities");
    expect(frames[0]!.payload).toEqual({
      protocolVersion: 2,
      features: ["snapshot", "fat_events", "output_tail"],
    });
  });

  it("attaches a task projection to task-shaped events without heavy fields", () => {
    const taskId = seedTask();
    cleanup = subscribeConnectEvents(capture);
    frames.length = 0;

    eventBus.emit("task:state_changed", { taskId, previousStatus: "approved", newStatus: "running" });

    expect(frames).toHaveLength(1);
    const payload = frames[0]!.payload;
    expect(payload.previousStatus).toBe("approved");
    const task = payload.task as Record<string, unknown>;
    expect(task).toMatchObject({
      id: taskId,
      title: "Fat Task",
      status: "running",
      team_name: "Team",
      current_phase: 0,
      phase_count: 2,
      needs_review: false,
    });
    expect(task).not.toContainKeys(["result", "orchestration_state", "description", "task_config"]);
  });

  it("attaches projections for phase change, note, escalation, and artifact events", () => {
    const taskId = seedTask();
    const db = getDb();
    db.prepare("INSERT INTO agents (id, name, type) VALUES ('agent-1', 'Agent One', 'claude-code')").run();
    db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content) VALUES ('note-1', 'task-1', 'agent-1', 'hello')").run();
    db.prepare(
      "INSERT INTO escalations (id, agent_id, task_id, type, question, status) VALUES ('esc-1', 'agent-1', 'task-1', 'question', 'stuck?', 'open')",
    ).run();
    db.prepare(
      "INSERT INTO task_artifacts (id, task_id, name, version, kind, body) VALUES ('art-1', 'task-1', 'doc', 1, 'plan', 'body')",
    ).run();
    cleanup = subscribeConnectEvents(capture);
    frames.length = 0;

    eventBus.emit("task:phase_changed", { taskId, previousPhase: 0, newPhase: 1, direction: "advance" });
    eventBus.emit("task:note_added", { noteId: "note-1", taskId, agentId: "agent-1", content: "hello" });
    eventBus.emit("escalation:created", { escalationId: "esc-1", agentId: "agent-1", taskId, type: "question", question: "stuck?" });
    eventBus.emit("artifact:created", { artifactId: "art-1", taskId, name: "doc", version: 1, kind: "plan" });

    expect(frames).toHaveLength(4);
    expect((frames[0]!.payload.task as Record<string, unknown>).id).toBe(taskId);
    expect(frames[1]!.payload.note).toMatchObject({ id: "note-1", taskId, agentName: "Agent One", content: "hello" });
    expect(frames[2]!.payload.escalation).toMatchObject({
      id: "esc-1",
      taskId,
      agentName: "Agent One",
      status: "open",
      question: "stuck?",
    });
    expect(frames[3]!.payload.artifact).toMatchObject({ id: "art-1", taskId, name: "doc", version: 1, kind: "plan", publishedAt: null });
    const artifact = frames[3]!.payload.artifact as Record<string, unknown>;
    expect(artifact).not.toContainKey("body");
  });

  it("ships the raw payload when the entity is missing", () => {
    cleanup = subscribeConnectEvents(capture);
    frames.length = 0;

    eventBus.emit("task:state_changed", { taskId: "ghost", previousStatus: "running", newStatus: "deleted" });

    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload).toEqual({ taskId: "ghost", previousStatus: "running", newStatus: "deleted" });
  });

  it("coalesces delegation_group:progress bursts and flushes terminal states instantly", async () => {
    cleanup = subscribeConnectEvents(capture, { delegationFlushMs: 10 });
    frames.length = 0;

    const progress = (settledCount: number, status: string) => ({
      groupId: "grp-1",
      taskId: "task-1",
      parentInstanceId: "parent-1",
      settledCount,
      expectedCount: 5,
      failedCount: 0,
      status,
    });

    eventBus.emit("delegation_group:progress", progress(1, "running"));
    eventBus.emit("delegation_group:progress", progress(2, "running"));
    eventBus.emit("delegation_group:progress", progress(3, "running"));
    expect(frames).toHaveLength(0);

    await Bun.sleep(30);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.settledCount).toBe(3);

    eventBus.emit("delegation_group:progress", progress(4, "running"));
    eventBus.emit("delegation_group:progress", progress(5, "completed"));
    // Terminal status flushes immediately and supersedes the pending timer.
    expect(frames).toHaveLength(2);
    expect(frames[1]!.payload.status).toBe("completed");
    await Bun.sleep(30);
    expect(frames).toHaveLength(2);
  });

  it("cleanup detaches all listeners and pending timers", async () => {
    const taskId = seedTask();
    cleanup = subscribeConnectEvents(capture, { delegationFlushMs: 10 });
    frames.length = 0;

    eventBus.emit("delegation_group:progress", {
      groupId: "grp-1",
      taskId,
      parentInstanceId: "p",
      settledCount: 1,
      expectedCount: 2,
      failedCount: 0,
      status: "running",
    });
    cleanup();
    cleanup = null;

    eventBus.emit("task:state_changed", { taskId, previousStatus: "approved", newStatus: "running" });
    await Bun.sleep(30);
    expect(frames).toHaveLength(0);
  });
});
