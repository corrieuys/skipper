import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { HookManager } from "./manager";
import { eventBus } from "../events/bus";
import { unlinkSync } from "fs";

const TEST_DB = "test-hook-manager.db";

let db: Database;
let hookManager: HookManager;

function createTestTask(taskId: string, hooks: unknown[]): void {
  db.prepare(
    "INSERT INTO teams (id, name) VALUES (?, ?)",
  ).run("team-1", "Test Team");

  db.prepare(
    `INSERT INTO tasks (id, title, team_id, status, task_config, working_directory)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(taskId, "Test Task", "team-1", "approved", JSON.stringify({ hooks }), "/tmp");
}

beforeEach(() => {
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  hookManager = new HookManager(db);
});

afterEach(() => {
  hookManager.destroy();
  db.close();
  try { unlinkSync(TEST_DB); } catch { }
});

describe("HookManager", () => {
  it("fires hook on task.started event", async () => {
    const taskId = "task-start-1";
    createTestTask(taskId, [
      { event: "task.started", type: "curl", template: "echo hook_fired_{{event.task_id}}" },
    ]);

    eventBus.emit("task:state_changed", {
      taskId,
      previousStatus: "approved",
      newStatus: "running",
    });

    // Wait for async hook execution
    await new Promise((r) => setTimeout(r, 500));

    const events = db.prepare(
      "SELECT * FROM events WHERE task_id = ? AND type LIKE 'hook:%'",
    ).all(taskId) as Array<{ type: string; payload: string }>;

    expect(events.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.hook_event).toBe("task.started");
    expect(payload.exit_code).toBe(0);
  });

  it("fires hook on task.completed event", async () => {
    const taskId = "task-complete-1";
    createTestTask(taskId, [
      { event: "task.completed", type: "curl", template: "echo completed_{{event.status}}" },
    ]);
    db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(taskId);

    eventBus.emit("task:state_changed", {
      taskId,
      previousStatus: "running",
      newStatus: "completed",
    });

    await new Promise((r) => setTimeout(r, 500));

    const events = db.prepare(
      "SELECT * FROM events WHERE task_id = ? AND type = 'hook:executed'",
    ).all(taskId) as Array<{ payload: string }>;

    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.hook_event).toBe("task.completed");
  });

  it("skips disabled hooks", async () => {
    const taskId = "task-disabled-1";
    createTestTask(taskId, [
      { event: "task.started", type: "curl", template: "echo should_not_fire", disabled: true },
    ]);

    eventBus.emit("task:state_changed", {
      taskId,
      previousStatus: "approved",
      newStatus: "running",
    });

    await new Promise((r) => setTimeout(r, 300));

    const events = db.prepare(
      "SELECT * FROM events WHERE task_id = ? AND type LIKE 'hook:%'",
    ).all(taskId) as unknown[];

    expect(events.length).toBe(0);
  });

  it("does not fire hooks for wrong event", async () => {
    const taskId = "task-wrong-1";
    createTestTask(taskId, [
      { event: "task.completed", type: "curl", template: "echo wrong" },
    ]);

    eventBus.emit("task:state_changed", {
      taskId,
      previousStatus: "approved",
      newStatus: "running",
    });

    await new Promise((r) => setTimeout(r, 300));

    const events = db.prepare(
      "SELECT * FROM events WHERE task_id = ? AND type LIKE 'hook:%'",
    ).all(taskId) as unknown[];

    expect(events.length).toBe(0);
  });

  it("fires escalation.created hook", async () => {
    const taskId = "task-esc-1";
    createTestTask(taskId, [
      { event: "escalation.created", type: "curl", template: "echo esc_{{event.body}}" },
    ]);

    eventBus.emit("escalation:created", {
      escalationId: "esc-1",
      agentId: "agent-1",
      taskId,
      type: "agent_request",
      question: "Need help",
    });

    await new Promise((r) => setTimeout(r, 500));

    const events = db.prepare(
      "SELECT * FROM events WHERE task_id = ? AND type = 'hook:executed'",
    ).all(taskId) as Array<{ payload: string }>;

    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.hook_event).toBe("escalation.created");
  });

  it("fires phase.review_pending hook", async () => {
    const taskId = "task-review-1";
    createTestTask(taskId, [
      { event: "phase.review_pending", type: "curl", template: "echo review_{{event.phase_name}}" },
    ]);

    eventBus.emit("task:needs_review_changed", {
      taskId,
      needsReview: true,
      phaseName: "QA",
      phaseIndex: 1,
    });

    await new Promise((r) => setTimeout(r, 500));

    const events = db.prepare(
      "SELECT * FROM events WHERE task_id = ? AND type = 'hook:executed'",
    ).all(taskId) as Array<{ payload: string }>;

    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.hook_event).toBe("phase.review_pending");
  });

  it("does not fire phase.review_pending when needsReview is false", async () => {
    const taskId = "task-review-off-1";
    createTestTask(taskId, [
      { event: "phase.review_pending", type: "curl", template: "echo should_not_fire" },
    ]);

    eventBus.emit("task:needs_review_changed", {
      taskId,
      needsReview: false,
    });

    await new Promise((r) => setTimeout(r, 300));

    const events = db.prepare(
      "SELECT * FROM events WHERE task_id = ? AND type LIKE 'hook:%'",
    ).all(taskId) as unknown[];

    expect(events.length).toBe(0);
  });

  it("handles task with no hooks gracefully", async () => {
    db.prepare(
      "INSERT INTO teams (id, name) VALUES (?, ?)",
    ).run("team-no-hooks", "Team No Hooks");

    db.prepare(
      `INSERT INTO tasks (id, title, team_id, status, task_config, working_directory)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("task-no-hooks", "No Hooks Task", "team-no-hooks", "approved", "{}", "/tmp");

    eventBus.emit("task:state_changed", {
      taskId: "task-no-hooks",
      previousStatus: "approved",
      newStatus: "running",
    });

    await new Promise((r) => setTimeout(r, 200));

    const events = db.prepare(
      "SELECT * FROM events WHERE task_id = 'task-no-hooks' AND type LIKE 'hook:%'",
    ).all() as unknown[];

    expect(events.length).toBe(0);
  });

  it("logs hook:failed for non-zero exit code", async () => {
    const taskId = "task-fail-hook-1";
    createTestTask(taskId, [
      { event: "task.started", type: "curl", template: "exit 1" },
    ]);

    eventBus.emit("task:state_changed", {
      taskId,
      previousStatus: "approved",
      newStatus: "running",
    });

    await new Promise((r) => setTimeout(r, 500));

    const events = db.prepare(
      "SELECT * FROM events WHERE task_id = ? AND type = 'hook:failed'",
    ).all(taskId) as Array<{ payload: string }>;

    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.exit_code).not.toBe(0);
  });
});
