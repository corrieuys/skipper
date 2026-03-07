import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { TaskScheduler } from "./scheduler";
import { unlinkSync } from "fs";

const TEST_DB = "test-task-scheduler.db";

let db: Database;
let scheduler: TaskScheduler;

function createTeam(database: Database, id = "team-1"): string {
  database
    .prepare("INSERT INTO teams (id, name) VALUES (?, ?)")
    .run(id, "Test Team");
  return id;
}

function createAgent(database: Database, id = "agent-1"): string {
  database
    .prepare("INSERT INTO agents (id, name, type, config, capabilities) VALUES (?, ?, 'claude-code', '{}', '[]')")
    .run(id, `Agent ${id}`);
  return id;
}

beforeEach(() => {
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  scheduler = new TaskScheduler(db);
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

describe("createTask", () => {
  it("creates a task with required fields", () => {
    const task = scheduler.createTask({ title: "Test Task" });
    expect(task.id).toBeTruthy();
    expect(task.title).toBe("Test Task");
    expect(task.status).toBe("draft");
    expect(task.current_phase).toBe(0);
    expect(task.priority).toBe(5);
    expect(task.result).toBeNull();
    expect(task.orchestration_state).toEqual({});
  });

  it("creates a task with all fields", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({
      title: "Full Task",
      description: "A detailed description",
      teamId,
      priority: 2,
    });
    expect(task.description).toBe("A detailed description");
    expect(task.team_id).toBe(teamId);
    expect(task.priority).toBe(2);
  });

  it("throws for invalid priority", () => {
    expect(() =>
      scheduler.createTask({ title: "Bad", priority: 0 }),
    ).toThrow("Priority must be between 1 and 10");
    expect(() =>
      scheduler.createTask({ title: "Bad", priority: 11 }),
    ).toThrow("Priority must be between 1 and 10");
  });
});

describe("deleteTask", () => {
  it("deletes a non-running task", () => {
    const task = scheduler.createTask({ title: "Task to delete" });
    const deleted = scheduler.deleteTask(task.id);
    expect(deleted).toBe(true);
    expect(scheduler.getTask(task.id)).toBeNull();
  });

  it("throws when deleting a running task", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Running task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    expect(() => scheduler.deleteTask(task.id)).toThrow("Cannot delete a running task");
  });

  it("removes non-cascading dependent rows tied to the task", () => {
    const agentId = createAgent(db);
    const task = scheduler.createTask({ title: "Task with deps" });

    db.prepare(
      "INSERT INTO escalations (id, agent_id, task_id, type, question) VALUES (?, ?, ?, 'agent_request', 'help')",
    ).run("esc-del", agentId, task.id);
    db.prepare(
      "INSERT INTO messages (id, from_agent_id, to_agent_id, task_id, type, content) VALUES (?, ?, ?, ?, 'agent', 'msg')",
    ).run("msg-del", agentId, agentId, task.id);
    db.prepare(
      "INSERT INTO events (type, payload, task_id) VALUES ('task:state_changed', '{}', ?)",
    ).run(task.id);

    scheduler.deleteTask(task.id);

    const escalationCount = db.prepare("SELECT COUNT(*) AS c FROM escalations WHERE task_id = ?").get(task.id) as { c: number };
    const messageCount = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE task_id = ?").get(task.id) as { c: number };
    const eventCount = db.prepare("SELECT COUNT(*) AS c FROM events WHERE task_id = ?").get(task.id) as { c: number };
    expect(escalationCount.c).toBe(0);
    expect(messageCount.c).toBe(0);
    expect(eventCount.c).toBe(0);
  });
});

describe("approveTask", () => {
  it("approves a draft task with team", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    const approved = scheduler.approveTask(task.id);
    expect(approved.status).toBe("approved");
    expect(approved.approved_at).toBeTruthy();
  });

  it("throws when task has no team", () => {
    const task = scheduler.createTask({ title: "No Team" });
    expect(() => scheduler.approveTask(task.id)).toThrow(
      "Task must have a team assigned",
    );
  });

  it("throws when task is not draft", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    expect(() => scheduler.approveTask(task.id)).toThrow(
      "Can only approve draft tasks",
    );
  });

  it("throws for nonexistent task", () => {
    expect(() => scheduler.approveTask("nonexistent")).toThrow("Task not found");
  });
});

describe("startTask", () => {
  it("starts an approved task", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    const started = scheduler.startTask(task.id);
    expect(started.status).toBe("running");
    expect(started.started_at).toBeTruthy();
  });

  it("throws when task is not approved", () => {
    const task = scheduler.createTask({ title: "Task" });
    expect(() => scheduler.startTask(task.id)).toThrow(
      "Can only start approved tasks",
    );
  });
});

describe("completeTask", () => {
  it("completes a running task", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    const completed = scheduler.completeTask(task.id, { output: "done" });
    expect(completed.status).toBe("completed");
    expect(completed.completed_at).toBeTruthy();
    expect(completed.result).toEqual({ output: "done" });
  });

  it("completes without result", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    const completed = scheduler.completeTask(task.id);
    expect(completed.status).toBe("completed");
    expect(completed.result).toBeNull();
  });

  it("throws when task is not running", () => {
    const task = scheduler.createTask({ title: "Task" });
    expect(() => scheduler.completeTask(task.id)).toThrow(
      "Can only complete running tasks",
    );
  });

  it("auto-resolves open escalations for the task", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    const agentId = createAgent(db);
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);

    db.prepare(
      "INSERT INTO escalations (id, agent_id, task_id, type, question) VALUES (?, ?, ?, 'agent_request', 'Need help')",
    ).run("esc-1", agentId, task.id);

    scheduler.completeTask(task.id);

    const escalation = db.prepare("SELECT status, response FROM escalations WHERE id = 'esc-1'").get() as { status: string; response: string | null };
    expect(escalation.status).toBe("resolved");
    expect(escalation.response).toContain("task completed");
  });
});

describe("failTask", () => {
  it("fails a running task", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    const failed = scheduler.failTask(task.id, "Something went wrong");
    expect(failed.status).toBe("failed");
    expect(failed.result).toEqual({ error: "Something went wrong" });
  });

  it("fails without error message", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    const failed = scheduler.failTask(task.id);
    expect(failed.status).toBe("failed");
    expect(failed.result).toBeNull();
  });
});

describe("retryTask", () => {
  it("retries a failed task back to draft", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    scheduler.failTask(task.id, "error");
    const retried = scheduler.retryTask(task.id);
    expect(retried.status).toBe("draft");
    expect(retried.current_phase).toBe(0);
    expect(retried.result).toBeNull();
    expect(retried.regression_count).toBe(0);
    expect(retried.started_at).toBeNull();
    expect(retried.completed_at).toBeNull();
    expect(retried.approved_at).toBeNull();
  });

  it("throws when task is not failed", () => {
    const task = scheduler.createTask({ title: "Task" });
    expect(() => scheduler.retryTask(task.id)).toThrow(
      "Can only retry failed tasks",
    );
  });
});

describe("cancelTask", () => {
  it("cancels a draft task", () => {
    const task = scheduler.createTask({ title: "Task" });
    const cancelled = scheduler.cancelTask(task.id);
    expect(cancelled.status).toBe("failed");
    expect(cancelled.result).toEqual({ error: "Cancelled by user" });
  });

  it("cancels a running task", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    const cancelled = scheduler.cancelTask(task.id);
    expect(cancelled.status).toBe("failed");
  });

  it("throws when cancelling completed task", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    scheduler.completeTask(task.id);
    expect(() => scheduler.cancelTask(task.id)).toThrow(
      "Cannot cancel a completed task",
    );
  });

  it("throws when cancelling failed task", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    scheduler.failTask(task.id);
    expect(() => scheduler.cancelTask(task.id)).toThrow(
      "Cannot cancel a failed task",
    );
  });
});

describe("getNextApprovedTask", () => {
  it("returns null when no approved tasks", () => {
    expect(scheduler.getNextApprovedTask()).toBeNull();
  });

  it("returns highest priority task (lowest number)", () => {
    const teamId = createTeam(db);
    scheduler.createTask({ title: "Low priority", teamId, priority: 8 });
    const approved1 = scheduler.createTask({ title: "Low priority", teamId, priority: 8 });
    const high = scheduler.createTask({ title: "High priority", teamId, priority: 2 });
    scheduler.approveTask(approved1.id);
    scheduler.approveTask(high.id);

    const next = scheduler.getNextApprovedTask();
    expect(next!.id).toBe(high.id);
  });

  it("skips non-approved tasks", () => {
    const teamId = createTeam(db);
    scheduler.createTask({ title: "Draft", teamId });
    const approved = scheduler.createTask({ title: "Approved", teamId });
    scheduler.approveTask(approved.id);

    const next = scheduler.getNextApprovedTask();
    expect(next!.id).toBe(approved.id);
  });
});

describe("advancePhase", () => {
  it("increments current phase", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    const advanced = scheduler.advancePhase(task.id);
    expect(advanced.current_phase).toBe(1);
  });

  it("throws when task is not running", () => {
    const task = scheduler.createTask({ title: "Task" });
    expect(() => scheduler.advancePhase(task.id)).toThrow(
      "Can only advance phase on running tasks",
    );
  });

  it("throws when already at last phase of team config", () => {
    // Create a team with 2 phases
    const teamId = "team-phases";
    db.prepare(
      "INSERT INTO teams (id, name, phases) VALUES (?, ?, ?)",
    ).run(teamId, "Phase Team", JSON.stringify([
      { name: "Phase 1", prompt: "p1" },
      { name: "Phase 2", prompt: "p2" },
    ]));

    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);

    // Advance to phase 1 (index 1, last phase for a 2-phase team)
    db.prepare("UPDATE tasks SET current_phase = 1 WHERE id = ?").run(task.id);

    expect(() => scheduler.advancePhase(task.id)).toThrow(
      "Cannot advance phase: already at last phase",
    );
  });

  it("allows advancing when not yet at last phase", () => {
    const teamId = "team-multi";
    db.prepare(
      "INSERT INTO teams (id, name, phases) VALUES (?, ?, ?)",
    ).run(teamId, "Multi Phase Team", JSON.stringify([
      { name: "Phase 1", prompt: "p1" },
      { name: "Phase 2", prompt: "p2" },
      { name: "Phase 3", prompt: "p3" },
    ]));

    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);

    // Should succeed: phase 0 → 1
    const advanced = scheduler.advancePhase(task.id);
    expect(advanced.current_phase).toBe(1);
  });

  it("does not restrict advancement for tasks without a team", () => {
    const task = scheduler.createTask({ title: "No Team Task" });
    // Manually set to running since startTask requires approved
    db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);

    const advanced = scheduler.advancePhase(task.id);
    expect(advanced.current_phase).toBe(1);
  });

  it("does not restrict advancement for teams with empty phases", () => {
    const teamId = "team-no-phases";
    db.prepare(
      "INSERT INTO teams (id, name, phases) VALUES (?, ?, '[]')",
    ).run(teamId, "No Phase Team");

    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);

    // No restriction on empty phases array
    const advanced = scheduler.advancePhase(task.id);
    expect(advanced.current_phase).toBe(1);
  });
});

describe("regressPhase", () => {
  it("regresses to target phase", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    scheduler.advancePhase(task.id);
    scheduler.advancePhase(task.id);
    const regressed = scheduler.regressPhase(task.id, 0);
    expect(regressed.current_phase).toBe(0);
    expect(regressed.regression_count).toBe(1);
  });

  it("throws for invalid target phase", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    expect(() => scheduler.regressPhase(task.id, 0)).toThrow(
      "Invalid target phase",
    );
  });
});

describe("updateOrchestrationState", () => {
  it("sets and merges orchestration state", () => {
    const task = scheduler.createTask({ title: "Task" });
    scheduler.updateOrchestrationState(task.id, "session_id", "abc123");
    scheduler.updateOrchestrationState(task.id, "attempts", 1);

    const updated = scheduler.getTask(task.id)!;
    expect(updated.orchestration_state).toEqual({
      session_id: "abc123",
      attempts: 1,
    });
  });
});

describe("cleanupStaleState", () => {
  it("fails any running tasks", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);

    scheduler.cleanupStaleState();

    const cleaned = scheduler.getTask(task.id)!;
    expect(cleaned.status).toBe("failed");
    expect(cleaned.result).toEqual({ error: "Server restart - task was running" });
  });

  it("does not affect non-running tasks", () => {
    const task = scheduler.createTask({ title: "Draft Task" });
    scheduler.cleanupStaleState();
    const unchanged = scheduler.getTask(task.id)!;
    expect(unchanged.status).toBe("draft");
  });
});

describe("full lifecycle", () => {
  it("draft → approved → running → completed", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Full Lifecycle", teamId });
    expect(task.status).toBe("draft");

    const approved = scheduler.approveTask(task.id);
    expect(approved.status).toBe("approved");

    const running = scheduler.startTask(task.id);
    expect(running.status).toBe("running");

    const completed = scheduler.completeTask(task.id, { success: true });
    expect(completed.status).toBe("completed");
  });

  it("draft → approved → running → failed → retry → draft", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Retry Lifecycle", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    scheduler.failTask(task.id, "oops");
    const retried = scheduler.retryTask(task.id);
    expect(retried.status).toBe("draft");
  });
});
