import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { TaskScheduler } from "./scheduler";
import { unlinkSync } from "fs";

const TEST_DB = "test-task-scheduler.db";

let db: Database;
let scheduler: TaskScheduler;

function createTeam(database: Database, id = "team-1"): string {
  // Seed a default agent to use as entrypoint
  database
    .prepare("INSERT OR IGNORE INTO agents (id, name, type, model) VALUES ('default-agent', 'Default Agent', 'claude-code', 'default')")
    .run();
  database
    .prepare("INSERT INTO teams (id, name, entrypoint_agent_id) VALUES (?, ?, 'default-agent')")
    .run(id, "Test Team");
  database
    .prepare("INSERT OR IGNORE INTO team_agents (id, team_id, agent_id, role, level) VALUES (?, ?, 'default-agent', 'lead', 0)")
    .run(`ta-${id}`, id);
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
    expect(task.result).toBeNull();
    expect(task.orchestration_state).toEqual({});
  });

  it("creates a task with all fields", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({
      title: "Full Task",
      description: "A detailed description",
      teamId,
    });
    expect(task.description).toBe("A detailed description");
    expect(task.team_id).toBe(teamId);
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
      "INSERT INTO events (type, payload, task_id) VALUES ('task:state_changed', '{}', ?)",
    ).run(task.id);

    scheduler.deleteTask(task.id);

    const escalationCount = db.prepare("SELECT COUNT(*) AS c FROM escalations WHERE task_id = ?").get(task.id) as { c: number };
    const eventCount = db.prepare("SELECT COUNT(*) AS c FROM events WHERE task_id = ?").get(task.id) as { c: number };
    expect(escalationCount.c).toBe(0);
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

  it("approves a real-time draft task without team assignment", () => {
    const task = scheduler.createTask({ title: "RT No Team", taskType: "real_time" });
    const approved = scheduler.approveTask(task.id);
    expect(approved.status).toBe("approved");
    expect(approved.approved_at).toBeTruthy();
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

describe("unapproveTask", () => {
  it("moves an approved task back to draft", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    const unapproved = scheduler.unapproveTask(task.id);
    expect(unapproved.status).toBe("draft");
    expect(unapproved.approved_at).toBeNull();
  });

  it("throws when task is not approved", () => {
    const task = scheduler.createTask({ title: "Task" });
    expect(() => scheduler.unapproveTask(task.id)).toThrow(
      "Can only unapprove approved tasks",
    );
  });

  it("allows re-approval after unapprove", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.unapproveTask(task.id);
    const reapproved = scheduler.approveTask(task.id);
    expect(reapproved.status).toBe("approved");
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

  it("starts an approved real-time task without team assignment", () => {
    const task = scheduler.createTask({ title: "RT Task", taskType: "real_time" });
    scheduler.approveTask(task.id);
    const started = scheduler.startTask(task.id);
    expect(started.status).toBe("running");
    expect(started.started_at).toBeTruthy();
    expect(started.task_type).toBe("real_time");
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

  it("kills and clears stale agent runtime state before resetting", () => {
    const teamId = createTeam(db);
    const agentId = createAgent(db, "retry-agent");
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    scheduler.failTask(task.id, "failed");

    db.prepare("UPDATE agents SET current_task_id = ?, process_pid = 999999, status = 'busy' WHERE id = ?").run(task.id, agentId);
    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, status, process_pid, attempt)
       VALUES (?, ?, ?, 'running', 999999, 1)`,
    ).run("retry-inst", task.id, agentId);

    scheduler.retryTask(task.id);

    const agent = db.prepare("SELECT current_task_id, process_pid, status FROM agents WHERE id = ?").get(agentId) as {
      current_task_id: string | null;
      process_pid: number | null;
      status: string;
    };
    const instance = db.prepare("SELECT status, process_pid FROM agent_instances WHERE id = ?").get("retry-inst") as {
      status: string;
      process_pid: number | null;
    };

    expect(agent.current_task_id).toBeNull();
    expect(agent.process_pid).toBeNull();
    expect(agent.status).toBe("idle");
    // History preserved for restart-resume; status flipped, pid cleared.
    expect(instance.status).toBe("failed");
    expect(instance.process_pid).toBeNull();
  });

  it("preserves delegations and agent_instances history across retry for resume", () => {
    const teamId = createTeam(db);
    const parentAgentId = createAgent(db, "parent-agent");
    const childAgentId = createAgent(db, "child-agent");
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    scheduler.failTask(task.id, "failed");

    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, parent_instance_id, root_instance_id, status, session_id, attempt)
       VALUES (?, ?, ?, NULL, ?, 'failed', 'parent-sess', 1)`,
    ).run("parent-inst", task.id, parentAgentId, "parent-inst");
    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, parent_instance_id, root_instance_id, status, session_id, attempt)
       VALUES (?, ?, ?, ?, ?, 'completed', 'child-sess', 1)`,
    ).run("child-inst", task.id, childAgentId, "parent-inst", "parent-inst");
    db.prepare(
      `INSERT INTO delegations (id, parent_agent_id, child_agent_id, parent_instance_id, child_instance_id, task_id, prompt, status)
       VALUES (?, ?, ?, ?, ?, ?, '', 'completed')`,
    ).run("del-1", parentAgentId, childAgentId, "parent-inst", "child-inst", task.id);

    scheduler.retryTask(task.id);

    const delegations = db.prepare("SELECT COUNT(*) as c FROM delegations WHERE task_id = ?").get(task.id) as { c: number };
    const parentInstance = db.prepare("SELECT session_id FROM agent_instances WHERE id = ?").get("parent-inst") as { session_id: string | null };
    const childInstance = db.prepare("SELECT session_id FROM agent_instances WHERE id = ?").get("child-inst") as { session_id: string | null };

    expect(delegations.c).toBe(1);
    expect(parentInstance.session_id).toBe("parent-sess");
    expect(childInstance.session_id).toBe("child-sess");
  });
});

describe("resumeTask", () => {
  it("resumes a failed task to approved while preserving phase", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    scheduler.advancePhase(task.id);
    scheduler.failTask(task.id, "error");

    const resumed = scheduler.resumeTask(task.id);
    expect(resumed.status).toBe("approved");
    expect(resumed.current_phase).toBe(1);
    expect(resumed.result).toBeNull();
    expect(resumed.started_at).toBeNull();
    expect(resumed.completed_at).toBeNull();
    expect(resumed.approved_at).not.toBeNull();
  });

  it("throws when task is not failed", () => {
    const task = scheduler.createTask({ title: "Task" });
    expect(() => scheduler.resumeTask(task.id)).toThrow(
      "Can only resume failed tasks",
    );
  });

  it("clears stale runtime state before resuming but preserves agent_instances history", () => {
    const teamId = createTeam(db);
    const agentId = createAgent(db, "resume-agent");
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    scheduler.failTask(task.id, "failed");

    db.prepare("UPDATE agents SET current_task_id = ?, process_pid = 999999, status = 'busy' WHERE id = ?").run(task.id, agentId);
    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, status, process_pid, session_id, attempt)
       VALUES (?, ?, ?, 'waiting_delegation', 999999, 'sess-resume', 1)`,
    ).run("resume-inst", task.id, agentId);

    scheduler.resumeTask(task.id);

    const agent = db.prepare("SELECT current_task_id, process_pid, status FROM agents WHERE id = ?").get(agentId) as {
      current_task_id: string | null;
      process_pid: number | null;
      status: string;
    };
    const instance = db.prepare("SELECT status, process_pid, session_id FROM agent_instances WHERE id = ?").get("resume-inst") as {
      status: string;
      process_pid: number | null;
      session_id: string | null;
    };

    expect(agent.current_task_id).toBeNull();
    expect(agent.process_pid).toBeNull();
    expect(agent.status).toBe("idle");
    // History preserved with session_id intact so restart can resume.
    expect(instance.status).toBe("failed");
    expect(instance.process_pid).toBeNull();
    expect(instance.session_id).toBe("sess-resume");
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

  it("returns earliest created approved task", () => {
    const teamId = createTeam(db);
    const first = scheduler.createTask({ title: "First Task", teamId });
    const second = scheduler.createTask({ title: "Second Task", teamId });
    scheduler.approveTask(first.id);
    scheduler.approveTask(second.id);

    const next = scheduler.getNextApprovedTask();
    expect(next!.id).toBe(first.id);
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

describe("iterateTask", () => {
  function completeTaskHelper(taskId: string) {
    const teamId = createTeam(db, `team-${taskId}`);
    db.prepare("UPDATE tasks SET team_id = ? WHERE id = ?").run(teamId, taskId);
    scheduler.approveTask(taskId);
    scheduler.startTask(taskId);
    scheduler.completeTask(taskId, { output: "done" });
  }

  it("iterates a completed task back to approved", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Iter Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    scheduler.completeTask(task.id, { output: "v1" });

    const iterated = scheduler.iterateTask(task.id, "fix the formatting");
    expect(iterated.status).toBe("approved");
    expect(iterated.iteration_count).toBe(1);
    expect(iterated.current_phase).toBe(0);
    expect(iterated.result).toBeNull();
    expect(iterated.regression_count).toBe(0);
    expect(iterated.started_at).toBeNull();
    expect(iterated.completed_at).toBeNull();
    expect(iterated.approved_at).toBeTruthy();
    expect(iterated.description).toContain("fix the formatting");
    expect(iterated.description).toContain("ITERATION 1");
  });

  it("preserves existing notes across iteration", () => {
    const teamId = createTeam(db);
    const agentId = createAgent(db, "note-agent");
    const task = scheduler.createTask({ title: "Note Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);

    db.prepare(
      "INSERT INTO task_notes (id, task_id, agent_id, content) VALUES (?, ?, ?, ?)",
    ).run("note-1", task.id, agentId, "Important finding");

    scheduler.completeTask(task.id, { output: "v1" });
    scheduler.iterateTask(task.id, "do more");

    const notes = db.prepare("SELECT * FROM task_notes WHERE task_id = ?").all(task.id) as { id: string; content: string }[];
    const userNote = notes.find((n) => n.id === "note-1");
    expect(userNote).toBeTruthy();
    expect(userNote!.content).toBe("Important finding");
  });

  it("saves previous result as a task note", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Result Note Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    scheduler.completeTask(task.id, { output: "my-result" });

    scheduler.iterateTask(task.id, "improve it");

    const notes = db.prepare("SELECT content FROM task_notes WHERE task_id = ? ORDER BY created_at").all(task.id) as { content: string }[];
    const resultNote = notes.find((n) => n.content.includes("[Iteration 0 result]"));
    expect(resultNote).toBeTruthy();
    expect(resultNote!.content).toContain("my-result");
  });

  it("clears checkpoints on iteration", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Checkpoint Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);

    db.prepare(
      "INSERT INTO task_checkpoints (task_id, sequence, checkpoint_type, context_snapshot) VALUES (?, 1, 'PHASE_START', '{}')",
    ).run(task.id);

    scheduler.completeTask(task.id);
    scheduler.iterateTask(task.id, "redo");

    const cpCount = db.prepare("SELECT COUNT(*) as c FROM task_checkpoints WHERE task_id = ?").get(task.id) as { c: number };
    expect(cpCount.c).toBe(0);
  });

  it("rejects iteration on non-completed tasks", () => {
    const task = scheduler.createTask({ title: "Draft Task" });
    expect(() => scheduler.iterateTask(task.id, "input")).toThrow("Can only iterate completed tasks, current status: draft");

    const teamId = createTeam(db);
    const task2 = scheduler.createTask({ title: "Running Task", teamId });
    scheduler.approveTask(task2.id);
    scheduler.startTask(task2.id);
    expect(() => scheduler.iterateTask(task2.id, "input")).toThrow("Can only iterate completed tasks, current status: running");

    scheduler.failTask(task2.id, "err");
    expect(() => scheduler.iterateTask(task2.id, "input")).toThrow("Can only iterate completed tasks, current status: failed");
  });

  it("rejects empty additional input", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    scheduler.completeTask(task.id);
    expect(() => scheduler.iterateTask(task.id, "")).toThrow("Additional input is required");
    expect(() => scheduler.iterateTask(task.id, "   ")).toThrow("Additional input is required");
  });

  it("rejects double iteration (second call sees approved, not completed)", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    scheduler.completeTask(task.id);

    scheduler.iterateTask(task.id, "first iteration");
    expect(() => scheduler.iterateTask(task.id, "second iteration")).toThrow("Can only iterate completed tasks, current status: approved");
  });

  it("supports multiple iterations with accumulating description", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Multi Iter", description: "Original desc", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    scheduler.completeTask(task.id, { v: 1 });

    const iter1 = scheduler.iterateTask(task.id, "change A");
    expect(iter1.iteration_count).toBe(1);
    expect(iter1.description).toContain("Original desc");
    expect(iter1.description).toContain("ITERATION 1");
    expect(iter1.description).toContain("change A");

    // Simulate second run completing
    scheduler.startTask(task.id);
    scheduler.completeTask(task.id, { v: 2 });

    const iter2 = scheduler.iterateTask(task.id, "change B");
    expect(iter2.iteration_count).toBe(2);
    expect(iter2.description).toContain("ITERATION 1");
    expect(iter2.description).toContain("change A");
    expect(iter2.description).toContain("ITERATION 2");
    expect(iter2.description).toContain("change B");
  });

  it("clears agent assignments on iteration", () => {
    const teamId = createTeam(db);
    const agentId = createAgent(db, "iter-agent");
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);

    db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(task.id, agentId);

    scheduler.completeTask(task.id, { done: true });
    scheduler.iterateTask(task.id, "improve");

    const agent = db.prepare("SELECT current_task_id FROM agents WHERE id = ?").get(agentId) as { current_task_id: string | null };
    expect(agent.current_task_id).toBeNull();
  });

  it("resets orchestration_state on iteration", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId });
    scheduler.approveTask(task.id);
    scheduler.startTask(task.id);
    scheduler.updateOrchestrationState(task.id, "session_id", "old-session");
    scheduler.completeTask(task.id);

    const iterated = scheduler.iterateTask(task.id, "redo");
    expect(iterated.orchestration_state).toEqual({});
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
