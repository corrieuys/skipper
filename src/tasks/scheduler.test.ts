import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { eventBus, type TaskCreatedEvent, type TaskPhaseChangedEvent } from "../events/bus";
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

function startedTask(teamId?: string): string {
  const team = teamId ?? createTeam(db);
  const task = scheduler.createTask({ title: "Started", teamId: team, workingDirectory: "" });
  scheduler.approveTask(task.id);
  scheduler.markStarted(task.id);
  return task.id;
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
  it("creates a draft task with defaults", () => {
    const task = scheduler.createTask({ title: "Test Task", workingDirectory: "" });
    expect(task.id).toBeTruthy();
    expect(task.title).toBe("Test Task");
    expect(task.status).toBe("draft");
    expect(task.mode).toBe("workflow");
    expect(task.paused).toBe(false);
    expect(task.current_phase).toBe(0);
    expect(task.result).toBeNull();
    expect(task.orchestration_state).toEqual({});
    expect(task.wake_requested_at).toBeNull();
    expect(task.settled_at).toBeNull();
  });

  it("creates a conversational task", () => {
    const task = scheduler.createTask({ title: "Chat", workingDirectory: "", mode: "conversational" });
    expect(task.mode).toBe("conversational");
  });

  it("creates a task with all fields", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({
      title: "Full Task",
      description: "A detailed description",
      teamId,
      workingDirectory: "",
    });
    expect(task.description).toBe("A detailed description");
    expect(task.team_id).toBe(teamId);
  });
});

describe("updateTitle", () => {
  it("updates the title and emits a same-status task:state_changed", () => {
    const task = scheduler.createTask({ title: "", workingDirectory: "" });
    const events: Array<{ taskId: string; previousStatus: string; newStatus: string }> = [];
    const handler = (e: { taskId: string; previousStatus: string; newStatus: string }) => events.push(e);
    eventBus.on("task:state_changed", handler);
    try {
      scheduler.updateTitle(task.id, "Generated title");
    } finally {
      eventBus.off("task:state_changed", handler);
    }
    expect(scheduler.getTask(task.id)!.title).toBe("Generated title");
    const evt = events.find((e) => e.taskId === task.id);
    expect(evt).toBeTruthy();
    expect(evt!.previousStatus).toBe("draft");
    expect(evt!.newStatus).toBe("draft");
  });

  it("no-ops on an unknown task id", () => {
    expect(() => scheduler.updateTitle("nope", "x")).not.toThrow();
  });
});

describe("deleteTask", () => {
  it("deletes a task with no live agents", () => {
    const task = scheduler.createTask({ title: "Task to delete", workingDirectory: "" });
    const deleted = scheduler.deleteTask(task.id);
    expect(deleted).toBe(true);
    expect(scheduler.getTask(task.id)).toBeNull();
  });

  it("throws when the task has live agent instances", () => {
    const id = startedTask();
    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('live-inst', ?, 'default-agent', 'running')",
    ).run(id);
    expect(() => scheduler.deleteTask(id)).toThrow("Cannot delete a task with live agents");
  });

  it("removes non-cascading dependent rows tied to the task", () => {
    const agentId = createAgent(db);
    const task = scheduler.createTask({ title: "Task with deps", workingDirectory: "" });

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
  it("approves a draft task with team into active with a pending wake", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId, workingDirectory: "" });
    const approved = scheduler.approveTask(task.id);
    expect(approved.status).toBe("active");
    expect(approved.approved_at).toBeTruthy();
    expect(approved.wake_requested_at).toBeTruthy();
  });

  it("throws when a workflow task has no team", () => {
    const task = scheduler.createTask({ title: "No Team", workingDirectory: "" });
    expect(() => scheduler.approveTask(task.id)).toThrow(
      "Task must have a team assigned",
    );
  });

  it("approves a conversational draft task without team assignment", () => {
    const task = scheduler.createTask({ title: "Chat No Team", workingDirectory: "", mode: "conversational" });
    const approved = scheduler.approveTask(task.id);
    expect(approved.status).toBe("active");
  });

  it("throws when task is not draft", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId, workingDirectory: "" });
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
  it("moves an unstarted active task back to draft", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId, workingDirectory: "" });
    scheduler.approveTask(task.id);
    const unapproved = scheduler.unapproveTask(task.id);
    expect(unapproved.status).toBe("draft");
    expect(unapproved.approved_at).toBeNull();
    expect(unapproved.wake_requested_at).toBeNull();
  });

  it("throws once the task has started", () => {
    const id = startedTask();
    expect(() => scheduler.unapproveTask(id)).toThrow(
      "Cannot unapprove a task that has already started",
    );
  });

  it("allows re-approval after unapprove", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId, workingDirectory: "" });
    scheduler.approveTask(task.id);
    scheduler.unapproveTask(task.id);
    const reapproved = scheduler.approveTask(task.id);
    expect(reapproved.status).toBe("active");
  });
});

describe("markStarted", () => {
  it("stamps started_at and consumes the wake marker", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId, workingDirectory: "" });
    scheduler.approveTask(task.id);
    const started = scheduler.markStarted(task.id);
    expect(started.status).toBe("active");
    expect(started.started_at).toBeTruthy();
    expect(started.wake_requested_at).toBeNull();
  });

  it("keeps the original started_at on later wakes", () => {
    const id = startedTask();
    const first = scheduler.getTask(id)!.started_at;
    scheduler.requestWake(id);
    scheduler.markStarted(id);
    expect(scheduler.getTask(id)!.started_at).toBe(first);
  });

  it("throws for a draft task", () => {
    const task = scheduler.createTask({ title: "Task", workingDirectory: "" });
    expect(() => scheduler.markStarted(task.id)).toThrow("Can only start active tasks");
  });
});

describe("pauseTask / resumeFromPause", () => {
  it("flips the paused flag on and off; status stays active", () => {
    const id = startedTask();
    const paused = scheduler.pauseTask(id);
    expect(paused.status).toBe("active");
    expect(paused.paused).toBe(true);
    const resumed = scheduler.resumeFromPause(id);
    expect(resumed.paused).toBe(false);
  });

  it("rejects pausing a draft task", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Draft", teamId, workingDirectory: "" });
    expect(() => scheduler.pauseTask(task.id)).toThrow("Can only pause an active task");
  });

  it("rejects double pause and resuming an unpaused task", () => {
    const id = startedTask();
    expect(() => scheduler.resumeFromPause(id)).toThrow("Task is not paused");
    scheduler.pauseTask(id);
    expect(() => scheduler.pauseTask(id)).toThrow("Task is already paused");
  });

  it("reconciles open delegations to a terminal state on pause", () => {
    const id = startedTask();
    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('inst-root', ?, 'default-agent', 'running')",
    ).run(id);
    db.prepare(
      "INSERT INTO delegation_groups (id, task_id, parent_instance_id, status, expected_count) VALUES ('dg-1', ?, 'inst-root', 'running', 1)",
    ).run(id);
    db.prepare(
      "INSERT INTO delegations (id, parent_agent_id, child_agent_id, task_id, delegation_group_id, prompt, status) VALUES ('d-1', 'default-agent', 'default-agent', ?, 'dg-1', 'do work', 'running')",
    ).run(id);

    scheduler.pauseTask(id);

    const del = db.prepare("SELECT status FROM delegations WHERE id = 'd-1'").get() as { status: string };
    const grp = db.prepare("SELECT status FROM delegation_groups WHERE id = 'dg-1'").get() as { status: string };
    expect(del.status).toBe("failed");
    expect(grp.status).toBe("completed");
  });

  it("excludes paused tasks from the startable queue", () => {
    const pausedId = startedTask();
    scheduler.requestWake(pausedId);
    scheduler.pauseTask(pausedId);
    const teamId = createTeam(db, "team-2");
    const queued = scheduler.createTask({ title: "Next", teamId, workingDirectory: "" });
    scheduler.approveTask(queued.id);

    const next = scheduler.getNextStartableTask();
    expect(next?.id).toBe(queued.id);
  });
});

describe("completeRun", () => {
  it("settles the run into the resting state (presents as Completed)", () => {
    const id = startedTask();
    const events: string[] = [];
    const onRun = () => events.push("run_completed");
    eventBus.on("task:run_completed", onRun);
    try {
      const completed = scheduler.completeRun(id, { output: "done" });
      expect(completed.status).toBe("settled");
      expect(completed.completed_at).toBeTruthy();
      expect(completed.result).toEqual({ output: "done" });
      expect(completed.settled_at).toBeTruthy();
    } finally {
      eventBus.off("task:run_completed", onRun);
    }
    expect(events).toEqual(["run_completed"]);
  });

  it("completes without result", () => {
    const id = startedTask();
    const completed = scheduler.completeRun(id);
    expect(completed.status).toBe("settled");
    expect(completed.result).toBeNull();
  });

  it("throws when task is not active", () => {
    const task = scheduler.createTask({ title: "Task", workingDirectory: "" });
    expect(() => scheduler.completeRun(task.id)).toThrow(
      "Can only complete a run on active tasks",
    );
  });

  it("auto-resolves open escalations for the task", () => {
    const id = startedTask();
    const agentId = createAgent(db);
    db.prepare(
      "INSERT INTO escalations (id, agent_id, task_id, type, question) VALUES (?, ?, ?, 'agent_request', 'Need help')",
    ).run("esc-1", agentId, id);

    scheduler.completeRun(id);

    const escalation = db.prepare("SELECT status, response FROM escalations WHERE id = 'esc-1'").get() as { status: string; response: string | null };
    expect(escalation.status).toBe("resolved");
    expect(escalation.response).toContain("run completed");
  });
});

describe("settling with undelivered input (regression: stuck 'queued for agent')", () => {
  function addUnfedInput(taskId: string, content: string): void {
    db.prepare(
      "INSERT INTO realtime_timeline (id, task_id, entry_type, content, priority) VALUES (?, ?, 'text', ?, 'high')",
    ).run(crypto.randomUUID(), taskId, content);
  }

  it("completeRun keeps the task active with a pending wake when input is unfed", () => {
    const id = startedTask();
    addUnfedInput(id, "just end the task");

    const wakes: string[] = [];
    const onWake = (e: { taskId: string }) => wakes.push(e.taskId);
    eventBus.on("task:wake_requested", onWake);
    try {
      const settled = scheduler.completeRun(id, { output: "done" });
      expect(settled.status).toBe("active");
      expect(settled.wake_requested_at).toBeTruthy();
      expect(settled.result).toEqual({ output: "done" });
    } finally {
      eventBus.off("task:wake_requested", onWake);
    }
    expect(wakes).toEqual([id]);
    // The queue can pick it up and the next run will carry the INPUT_FEED.
    expect(scheduler.getNextStartableTask()!.id).toBe(id);
  });

  it("failRun keeps the task active with a pending wake when input is unfed", () => {
    const id = startedTask();
    addUnfedInput(id, "try again with flag X");
    const settled = scheduler.failRun(id, "boom");
    expect(settled.status).toBe("active");
    expect(settled.wake_requested_at).toBeTruthy();
  });

  it("completeRun archives normally once all input was delivered", () => {
    const id = startedTask();
    db.prepare(
      "INSERT INTO realtime_timeline (id, task_id, entry_type, content, fed_to_skipper) VALUES (?, ?, 'text', 'seen', 1)",
    ).run(crypto.randomUUID(), id);
    const settled = scheduler.completeRun(id);
    expect(settled.status).toBe("settled");
  });
});

describe("failRun", () => {
  it("records the error, settles the task, and stays revivable via unarchive+wake", () => {
    const id = startedTask();
    const events: string[] = [];
    const onRun = () => events.push("run_failed");
    eventBus.on("task:run_failed", onRun);
    try {
      const failed = scheduler.failRun(id, "Something went wrong");
      expect(failed.status).toBe("settled");
      expect(failed.result).toEqual({ error: "Something went wrong" });
    } finally {
      eventBus.off("task:run_failed", onRun);
    }
    expect(events).toEqual(["run_failed"]);

    // Still revivable: input auto-unarchives + wakes (daemon.inputTask path).
    scheduler.reviveTask(id);
    const woken = scheduler.requestWake(id);
    expect(woken.wake_requested_at).toBeTruthy();
  });

  it("writes a system note describing the failure", () => {
    const id = startedTask();
    scheduler.failRun(id, "boom");
    const notes = db.prepare("SELECT content, source FROM task_notes WHERE task_id = ?").all(id) as Array<{ content: string; source: string }>;
    const sys = notes.find((n) => n.content.includes("Run failed: boom"));
    expect(sys).toBeTruthy();
    expect(sys!.source).toBe("system");
  });
});

describe("settleTask / reviveTask", () => {
  it("archives an active task", () => {
    const id = startedTask();
    const archived = scheduler.settleTask(id, { result: { output: "final" } });
    expect(archived.status).toBe("settled");
    expect(archived.settled_at).toBeTruthy();
    expect(archived.result).toEqual({ output: "final" });
  });

  it("archives with a cancel-style error result", () => {
    const id = startedTask();
    const archived = scheduler.settleTask(id, { error: "Cancelled by user" });
    expect(archived.status).toBe("settled");
    expect(archived.result).toEqual({ error: "Cancelled by user" });
  });

  it("preserves the prior result when archiving without one", () => {
    const id = startedTask();
    db.prepare("UPDATE tasks SET result = ? WHERE id = ?").run(JSON.stringify({ output: "kept" }), id);
    const archived = scheduler.settleTask(id);
    expect(archived.result).toEqual({ output: "kept" });
  });

  it("rejects settling a draft task", () => {
    const task = scheduler.createTask({ title: "Draft", workingDirectory: "" });
    expect(() => scheduler.settleTask(task.id)).toThrow("Can only settle active tasks");
  });

  it("unarchives back to active", () => {
    const id = startedTask();
    scheduler.settleTask(id);
    const unarchived = scheduler.reviveTask(id);
    expect(unarchived.status).toBe("active");
    expect(unarchived.settled_at).toBeNull();
  });

  it("auto-resolves open escalations on archive", () => {
    const id = startedTask();
    const agentId = createAgent(db);
    db.prepare(
      "INSERT INTO escalations (id, agent_id, task_id, type, question) VALUES ('esc-a', ?, ?, 'agent_request', 'q')",
    ).run(agentId, id);
    scheduler.settleTask(id);
    const esc = db.prepare("SELECT status FROM escalations WHERE id = 'esc-a'").get() as { status: string };
    expect(esc.status).toBe("resolved");
  });
});

describe("requestWake / getNextStartableTask", () => {
  it("returns null when nothing is startable", () => {
    expect(scheduler.getNextStartableTask()).toBeNull();
  });

  it("returns the earliest approved (never-started) task", () => {
    const teamId = createTeam(db);
    const first = scheduler.createTask({ title: "First Task", teamId, workingDirectory: "" });
    const second = scheduler.createTask({ title: "Second Task", teamId, workingDirectory: "" });
    scheduler.approveTask(first.id);
    scheduler.approveTask(second.id);

    const next = scheduler.getNextStartableTask();
    expect(next!.id).toBe(first.id);
  });

  it("does not return an idle started task without a wake", () => {
    const id = startedTask();
    expect(scheduler.getNextStartableTask()).toBeNull();
    scheduler.requestWake(id);
    expect(scheduler.getNextStartableTask()!.id).toBe(id);
  });

  it("emits task:wake_requested", () => {
    const id = startedTask();
    const seen: string[] = [];
    const onWake = (e: { taskId: string }) => seen.push(e.taskId);
    eventBus.on("task:wake_requested", onWake);
    try {
      scheduler.requestWake(id);
    } finally {
      eventBus.off("task:wake_requested", onWake);
    }
    expect(seen).toEqual([id]);
  });

  it("skips tasks with live instances", () => {
    const id = startedTask();
    scheduler.requestWake(id);
    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('busy-inst', ?, 'default-agent', 'running')",
    ).run(id);
    expect(scheduler.getNextStartableTask()).toBeNull();
  });

  it("skips tasks awaiting review", () => {
    const id = startedTask();
    scheduler.requestWake(id);
    scheduler.setNeedsReview(id, true);
    expect(scheduler.getNextStartableTask()).toBeNull();
  });

  it("rejects waking a draft or archived task", () => {
    const draft = scheduler.createTask({ title: "Draft", workingDirectory: "" });
    expect(() => scheduler.requestWake(draft.id)).toThrow("Can only wake active tasks");
    const id = startedTask();
    scheduler.settleTask(id);
    expect(() => scheduler.requestWake(id)).toThrow("Can only wake active tasks");
  });
});

describe("getRuntimeState", () => {
  it("derives queued then idle then working", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Task", teamId, workingDirectory: "" });
    scheduler.approveTask(task.id);
    expect(scheduler.getRuntimeState(task.id)).toBe("queued");

    scheduler.markStarted(task.id);
    expect(scheduler.getRuntimeState(task.id)).toBe("idle");

    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('rs-inst', ?, 'default-agent', 'running')",
    ).run(task.id);
    expect(scheduler.getRuntimeState(task.id)).toBe("working");
  });

  it("derives paused, review, and blocked", () => {
    const id = startedTask();
    scheduler.setNeedsReview(id, true);
    expect(scheduler.getRuntimeState(id)).toBe("review");
    scheduler.setNeedsReview(id, false);

    const agentId = createAgent(db, "rs-agent");
    db.prepare(
      "INSERT INTO escalations (id, agent_id, task_id, type, question) VALUES ('rs-esc', ?, ?, 'agent_request', 'q')",
    ).run(agentId, id);
    expect(scheduler.getRuntimeState(id)).toBe("blocked");
    db.prepare("UPDATE escalations SET status = 'resolved' WHERE id = 'rs-esc'").run();

    scheduler.pauseTask(id);
    expect(scheduler.getRuntimeState(id)).toBe("paused");
  });
});

describe("advancePhase", () => {
  it("increments current phase", () => {
    const id = startedTask();
    const advanced = scheduler.advancePhase(id);
    expect(advanced.current_phase).toBe(1);
  });

  it("throws when task is not active", () => {
    const task = scheduler.createTask({ title: "Task", workingDirectory: "" });
    expect(() => scheduler.advancePhase(task.id)).toThrow(
      "Can only advance phase on active tasks",
    );
  });

  it("throws when already at last phase of team config", () => {
    const teamId = "team-phases";
    db.prepare(
      "INSERT INTO teams (id, name, phases) VALUES (?, ?, ?)",
    ).run(teamId, "Phase Team", JSON.stringify([
      { name: "Phase 1", prompt: "p1" },
      { name: "Phase 2", prompt: "p2" },
    ]));

    const task = scheduler.createTask({ title: "Task", teamId, workingDirectory: "" });
    scheduler.approveTask(task.id);
    scheduler.markStarted(task.id);

    db.prepare("UPDATE tasks SET current_phase = 1 WHERE id = ?").run(task.id);

    expect(() => scheduler.advancePhase(task.id)).toThrow(
      "Cannot advance phase: already at last phase",
    );
  });

  it("does not restrict advancement for teams with empty phases", () => {
    const teamId = "team-no-phases";
    db.prepare(
      "INSERT INTO teams (id, name, phases) VALUES (?, ?, '[]')",
    ).run(teamId, "No Phase Team");

    const task = scheduler.createTask({ title: "Task", teamId, workingDirectory: "" });
    scheduler.approveTask(task.id);
    scheduler.markStarted(task.id);

    const advanced = scheduler.advancePhase(task.id);
    expect(advanced.current_phase).toBe(1);
  });
});

describe("regressPhase", () => {
  it("regresses to target phase", () => {
    const id = startedTask();
    scheduler.advancePhase(id);
    scheduler.advancePhase(id);
    const regressed = scheduler.regressPhase(id, 0);
    expect(regressed.current_phase).toBe(0);
    expect(regressed.regression_count).toBe(1);
  });

  it("throws for invalid target phase", () => {
    const id = startedTask();
    expect(() => scheduler.regressPhase(id, 0)).toThrow(
      "Invalid target phase",
    );
  });
});

describe("updateOrchestrationState", () => {
  it("sets and merges orchestration state", () => {
    const task = scheduler.createTask({ title: "Task", workingDirectory: "" });
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
  it("leaves active tasks untouched (running-with-no-agents is legal now)", () => {
    const id = startedTask();
    scheduler.cleanupStaleState();
    const cleaned = scheduler.getTask(id)!;
    expect(cleaned.status).toBe("active");
    expect(cleaned.result).toBeNull();
  });

  it("sweeps live instance rows to failed", () => {
    const id = startedTask();
    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, status, process_pid) VALUES ('stale-inst', ?, 'default-agent', 'running', 999999)",
    ).run(id);

    scheduler.cleanupStaleState();

    const inst = db.prepare("SELECT status, process_pid FROM agent_instances WHERE id = 'stale-inst'").get() as { status: string; process_pid: number | null };
    expect(inst.status).toBe("failed");
    expect(inst.process_pid).toBeNull();
  });

  it("auto-resolves escalations only on archived tasks", () => {
    const activeId = startedTask();
    const agentId = createAgent(db, "cs-agent");
    db.prepare(
      "INSERT INTO escalations (id, agent_id, task_id, type, question) VALUES ('cs-open', ?, ?, 'agent_request', 'q')",
    ).run(agentId, activeId);

    const teamId = createTeam(db, "team-arch");
    const archTask = scheduler.createTask({ title: "Arch", teamId, workingDirectory: "" });
    scheduler.approveTask(archTask.id);
    scheduler.markStarted(archTask.id);
    db.prepare(
      "INSERT INTO escalations (id, agent_id, task_id, type, question) VALUES ('cs-arch', ?, ?, 'agent_request', 'q')",
    ).run(agentId, archTask.id);
    scheduler.settleTask(archTask.id);
    // Re-open it to simulate a stale open escalation on an archived task.
    db.prepare("UPDATE escalations SET status = 'open', response = NULL WHERE id = 'cs-arch'").run();

    scheduler.cleanupStaleState();

    const open = db.prepare("SELECT status FROM escalations WHERE id = 'cs-open'").get() as { status: string };
    const arch = db.prepare("SELECT status FROM escalations WHERE id = 'cs-arch'").get() as { status: string };
    expect(open.status).toBe("open"); // survives restarts on active tasks
    expect(arch.status).toBe("resolved");
  });
});

describe("full lifecycle", () => {
  it("draft → active (queued → working) → settled (Completed)", () => {
    const teamId = createTeam(db);
    const task = scheduler.createTask({ title: "Full Lifecycle", teamId, workingDirectory: "" });
    expect(task.status).toBe("draft");

    const approved = scheduler.approveTask(task.id);
    expect(approved.status).toBe("active");
    expect(scheduler.getRuntimeState(task.id)).toBe("queued");

    scheduler.markStarted(task.id);
    const settled = scheduler.completeRun(task.id, { success: true });
    expect(settled.status).toBe("settled");
    expect(settled.settled_at).toBeTruthy();
  });

  it("failed run stays revivable: fail → unarchive + wake → start → complete", () => {
    const id = startedTask();
    scheduler.failRun(id, "oops");
    scheduler.reviveTask(id);
    scheduler.requestWake(id);
    expect(scheduler.getNextStartableTask()!.id).toBe(id);
    scheduler.markStarted(id);
    const done = scheduler.completeRun(id, { fixed: true });
    expect(done.status).toBe("settled");
    expect(done.result).toEqual({ fixed: true });
  });
});

describe("bus events", () => {
  it("emits task:created on createTask", () => {
    const seen: TaskCreatedEvent[] = [];
    const listener = (e: TaskCreatedEvent) => seen.push(e);
    eventBus.on("task:created", listener);
    try {
      const task = scheduler.createTask({ title: "Event Task", workingDirectory: "" });
      expect(seen).toEqual([{ taskId: task.id }]);
    } finally {
      eventBus.off("task:created", listener);
    }
  });

  it("emits task:phase_changed with advance direction on advancePhase", () => {
    const seen: TaskPhaseChangedEvent[] = [];
    const listener = (e: TaskPhaseChangedEvent) => seen.push(e);
    eventBus.on("task:phase_changed", listener);
    try {
      const id = startedTask();
      scheduler.advancePhase(id);
      expect(seen).toEqual([
        { taskId: id, previousPhase: 0, newPhase: 1, direction: "advance" },
      ]);
    } finally {
      eventBus.off("task:phase_changed", listener);
    }
  });

  it("emits task:phase_changed with regress direction on regressPhase", () => {
    const seen: TaskPhaseChangedEvent[] = [];
    const listener = (e: TaskPhaseChangedEvent) => seen.push(e);
    eventBus.on("task:phase_changed", listener);
    try {
      const id = startedTask();
      scheduler.advancePhase(id);
      scheduler.advancePhase(id);
      seen.length = 0;
      scheduler.regressPhase(id, 0);
      expect(seen).toEqual([
        { taskId: id, previousPhase: 2, newPhase: 0, direction: "regress" },
      ]);
    } finally {
      eventBus.off("task:phase_changed", listener);
    }
  });
});
