import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { ManagerDaemon } from "./manager-daemon";
import { TaskScheduler } from "../tasks/scheduler";
import { TeamManager } from "../teams/manager";
import { AgentManager } from "./manager";
import { clearAgentTypeCache } from "./types";
import { eventBus } from "../events/bus";
import type { AgentExitEvent } from "../events/bus";
import { unlinkSync } from "fs";

const TEST_DB = "test-manager-daemon.db";

let db: Database;
let daemon: ManagerDaemon;
let scheduler: TaskScheduler;
let teamManager: TeamManager;

function setupAgentType(
  name = "test-echo",
  supportsStdin = true,
  supportsResume = false,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO agent_types (name, command, args, supports_stdin, supports_resume)
     VALUES (?, 'bash', '["-c", "sleep 30"]', ?, ?)`,
  ).run(name, supportsStdin ? 1 : 0, supportsResume ? 1 : 0);
}

function createAgent(
  name: string,
  type = "test-echo",
  goal?: string,
): string {
  const id = crypto.randomUUID();
  const config = goal ? JSON.stringify({ goal }) : "{}";
  db.prepare(
    "INSERT INTO agents (id, name, type, config, capabilities) VALUES (?, ?, ?, ?, '[]')",
  ).run(id, name, type, config);
  return id;
}

function createTeamWithEntrypoint(
  agentId: string,
  phases: { name: string; prompt: string }[] = [],
): string {
  const teamId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO teams (id, name, entrypoint_agent_id, phases) VALUES (?, ?, ?, ?)",
  ).run(teamId, "Test Team", agentId, JSON.stringify(phases));

  const taId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO team_agents (id, team_id, agent_id, role) VALUES (?, ?, ?, 'worker')",
  ).run(taId, teamId, agentId);

  return teamId;
}

function createApprovedTask(teamId: string, title = "Test Task", priority = 5): string {
  const taskId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, title, description, team_id, status, priority, approved_at)
     VALUES (?, ?, 'Task description', ?, 'approved', ?, datetime('now'))`,
  ).run(taskId, title, teamId, priority);
  return taskId;
}

function createRunningTask(teamId: string, title = "Running Task"): string {
  const taskId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, title, team_id, status, started_at)
     VALUES (?, ?, ?, 'running', datetime('now'))`,
  ).run(taskId, title, teamId);
  return taskId;
}

beforeEach(() => {
  clearAgentTypeCache();
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  setupAgentType();
  daemon = new ManagerDaemon(db);
  scheduler = new TaskScheduler(db);
  teamManager = new TeamManager(db);
});

afterEach(() => {
  daemon.stop();
  // Kill any running agents
  const agentManager = daemon.getAgentManager();
  for (const [id, agent] of agentManager.getRunningAgents()) {
    if (agent.process) {
      try {
        agentManager.killAgent(id);
      } catch {}
    }
  }
  agentManager.getRunningAgents().clear();
  // Remove all agent:exit listeners to avoid cross-test leaks
  eventBus.removeAllListeners("agent:exit");
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

describe("ManagerDaemon lifecycle", () => {
  it("starts and stops the daemon interval", () => {
    daemon.start();
    // Starting again should be a no-op
    daemon.start();
    daemon.stop();
    // Stopping again should be a no-op
    daemon.stop();
  });

  it("exposes agent manager and task scheduler", () => {
    expect(daemon.getAgentManager()).toBeInstanceOf(AgentManager);
    expect(daemon.getTaskScheduler()).toBeInstanceOf(TaskScheduler);
  });
});

describe("tick", () => {
  it("records daemon run on each tick", async () => {
    await daemon.tick();

    const runs = db
      .prepare("SELECT * FROM manager_runs")
      .all() as { id: number; completed_at: string; tasks_processed: number }[];
    expect(runs.length).toBe(1);
    expect(runs[0].completed_at).toBeTruthy();
    expect(runs[0].tasks_processed).toBe(0);
  });

  it("records errors in daemon run", async () => {
    // Create a scenario that will error — corrupt state
    // We'll spy on processTaskQueue to throw
    const originalProcess = daemon.processTaskQueue.bind(daemon);
    spyOn(daemon, "processTaskQueue").mockImplementation(() => {
      throw new Error("Test error");
    });

    await daemon.tick();

    const runs = db
      .prepare("SELECT * FROM manager_runs")
      .all() as { errors: string }[];
    expect(runs.length).toBe(1);
    const errors = JSON.parse(runs[0].errors);
    expect(errors).toContain("Test error");
  });
});

describe("processTaskQueue", () => {
  it("returns 0 processed when no approved tasks exist", async () => {
    const result = await daemon.processTaskQueue();
    expect(result.processed).toBe(0);
  });

  it("returns 0 processed when a task is already running", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    createRunningTask(teamId);

    // Also create an approved task
    createApprovedTask(teamId);

    const result = await daemon.processTaskQueue();
    expect(result.processed).toBe(0);
  });

  it("fails task with no team assigned", async () => {
    // Create a task with no team
    const taskId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO tasks (id, title, status, approved_at)
       VALUES (?, 'Orphan Task', 'approved', datetime('now'))`,
    ).run(taskId);

    const result = await daemon.processTaskQueue();
    expect(result.processed).toBe(1);

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("failed");
  });

  it("fails task when team has no entrypoint", async () => {
    // Create team without entrypoint
    const agentId = createAgent("Agent", "test-echo");
    const teamId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO teams (id, name) VALUES (?, 'No Entry Team')",
    ).run(teamId);
    const taId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO team_agents (id, team_id, agent_id) VALUES (?, ?, ?)",
    ).run(taId, teamId, agentId);

    createApprovedTask(teamId);

    const result = await daemon.processTaskQueue();
    expect(result.processed).toBe(1);

    // The task should have failed
    const tasks = db
      .prepare("SELECT * FROM tasks WHERE status = 'failed'")
      .all() as { id: string }[];
    expect(tasks.length).toBe(1);
  });

  it("fails task when entrypoint agent is deleted after team setup", async () => {
    // Create agent, set up team, then delete agent from DB
    const agentId = createAgent("Temp Agent", "test-echo");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    // Remove the agent (disable FK temporarily to simulate orphaned reference)
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    db.exec("PRAGMA foreign_keys = ON");

    const result = await daemon.processTaskQueue();
    expect(result.processed).toBe(1);

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("failed");
  });

  it("spawns agent and starts task for approved task", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    const result = await daemon.processTaskQueue();
    expect(result.processed).toBe(1);

    // Task should now be running
    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");

    // Agent should have current_task_id set
    const agentRow = db
      .prepare("SELECT current_task_id FROM agents WHERE id = ?")
      .get(agentId) as { current_task_id: string | null };
    expect(agentRow.current_task_id).toBe(taskId);
  });

  it("handles spawn failure gracefully", async () => {
    // Create agent with bad type that will fail to spawn
    setupAgentType("bad-type");
    db.prepare(
      "UPDATE agent_types SET command = 'nonexistent-binary-12345' WHERE name = 'bad-type'",
    ).run();
    const agentId = createAgent("Bad Agent", "bad-type");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    const result = await daemon.processTaskQueue();
    expect(result.processed).toBe(1);

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("failed");
  });

  it("processes highest priority task first", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);

    const lowPriorityId = createApprovedTask(teamId, "Low Priority", 8);
    const highPriorityId = createApprovedTask(teamId, "High Priority", 1);

    const result = await daemon.processTaskQueue();
    expect(result.processed).toBe(1);

    // High priority task should be running
    const highTask = scheduler.getTask(highPriorityId);
    expect(highTask?.status).toBe("running");

    // Low priority should still be approved
    const lowTask = scheduler.getTask(lowPriorityId);
    expect(lowTask?.status).toBe("approved");
  });

  it("sends prompt with phase info when team has phases", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const phases = [
      { name: "Planning", prompt: "Create a plan" },
      { name: "Implementation", prompt: "Implement the plan" },
    ];
    const teamId = createTeamWithEntrypoint(agentId, phases);
    const taskId = createApprovedTask(teamId);

    // Spy on sendInput
    const agentManager = daemon.getAgentManager();
    let capturedPrompt = "";
    const origSendInput = agentManager.sendInput.bind(agentManager);
    spyOn(agentManager, "sendInput").mockImplementation(
      (id: string, input: string, close?: boolean) => {
        capturedPrompt = input;
        origSendInput(id, input, close);
      },
    );

    await daemon.processTaskQueue();

    expect(capturedPrompt).toContain("CURRENT PHASE (1/2): Planning");
    expect(capturedPrompt).toContain("Create a plan");
  });

  it("closes stdin for non-streaming agents", async () => {
    setupAgentType("exec-agent", false);
    const agentId = createAgent("Exec Agent", "exec-agent");
    const teamId = createTeamWithEntrypoint(agentId);
    createApprovedTask(teamId);

    const agentManager = daemon.getAgentManager();
    let closedStdin = false;
    const origSendInput = agentManager.sendInput.bind(agentManager);
    spyOn(agentManager, "sendInput").mockImplementation(
      (id: string, input: string, close?: boolean) => {
        closedStdin = close ?? false;
        origSendInput(id, input, close);
      },
    );

    await daemon.processTaskQueue();

    expect(closedStdin).toBe(true);
  });
});

describe("handleAgentExit", () => {
  it("completes task on successful exit (code 0, no phases)", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    // Process the task to start it
    await daemon.processTaskQueue();

    // Simulate agent exit with code 0
    const exitEvent: AgentExitEvent = {
      agentId,
      code: 0,
      isRespawn: false,
      hasDelegation: false,
    };

    // Wait for grace period
    eventBus.emit("agent:exit", exitEvent);
    await new Promise((r) => setTimeout(r, 1500));

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("completed");

    // Agent should have task cleared
    const agentRow = db
      .prepare("SELECT current_task_id FROM agents WHERE id = ?")
      .get(agentId) as { current_task_id: string | null };
    expect(agentRow.current_task_id).toBeNull();
  });

  it("fails task on non-zero exit", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    const exitEvent: AgentExitEvent = {
      agentId,
      code: 1,
      isRespawn: false,
      hasDelegation: false,
    };

    eventBus.emit("agent:exit", exitEvent);
    await new Promise((r) => setTimeout(r, 1500));

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("failed");
  });

  it("skips respawn exits", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    const exitEvent: AgentExitEvent = {
      agentId,
      code: 0,
      isRespawn: true,
      hasDelegation: false,
    };

    eventBus.emit("agent:exit", exitEvent);
    await new Promise((r) => setTimeout(r, 1500));

    // Task should still be running (not completed)
    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");
  });

  it("skips delegation exits", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    const exitEvent: AgentExitEvent = {
      agentId,
      code: 0,
      isRespawn: false,
      hasDelegation: true,
    };

    eventBus.emit("agent:exit", exitEvent);
    await new Promise((r) => setTimeout(r, 1500));

    // Task should still be running
    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");
  });

  it("ignores exit for agent with no task", async () => {
    const agentId = createAgent("Idle Agent", "test-echo");

    const exitEvent: AgentExitEvent = {
      agentId,
      code: 0,
      isRespawn: false,
      hasDelegation: false,
    };

    // Should not throw
    eventBus.emit("agent:exit", exitEvent);
    await new Promise((r) => setTimeout(r, 1500));
  });

  it("advances phase on successful exit when more phases remain", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const phases = [
      { name: "Planning", prompt: "Create a plan" },
      { name: "Implementation", prompt: "Implement the plan" },
      { name: "Testing", prompt: "Write tests" },
    ];
    const teamId = createTeamWithEntrypoint(agentId, phases);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    // Verify task is at phase 0
    let task = scheduler.getTask(taskId);
    expect(task?.current_phase).toBe(0);

    const exitEvent: AgentExitEvent = {
      agentId,
      code: 0,
      isRespawn: false,
      hasDelegation: false,
    };

    eventBus.emit("agent:exit", exitEvent);
    await new Promise((r) => setTimeout(r, 1500));

    // Task should have advanced to phase 1 (not completed)
    task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");
    expect(task?.current_phase).toBe(1);
  });

  it("completes task on last phase exit", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const phases = [
      { name: "Planning", prompt: "Plan" },
      { name: "Implementation", prompt: "Implement" },
    ];
    const teamId = createTeamWithEntrypoint(agentId, phases);
    const taskId = createApprovedTask(teamId);

    // Manually set task to last phase
    await daemon.processTaskQueue();
    db.prepare("UPDATE tasks SET current_phase = 1 WHERE id = ?").run(taskId);

    const exitEvent: AgentExitEvent = {
      agentId,
      code: 0,
      isRespawn: false,
      hasDelegation: false,
    };

    eventBus.emit("agent:exit", exitEvent);
    await new Promise((r) => setTimeout(r, 1500));

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("completed");
  });
});

describe("daemon run recording", () => {
  it("records multiple daemon runs", async () => {
    await daemon.tick();
    await daemon.tick();
    await daemon.tick();

    const runs = db
      .prepare("SELECT * FROM manager_runs ORDER BY id")
      .all() as { id: number }[];
    expect(runs.length).toBe(3);
  });

  it("records agents checked count", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    createApprovedTask(teamId);

    // Process task to spawn an agent
    await daemon.processTaskQueue();

    // Now tick to record the count
    await daemon.tick();

    const runs = db
      .prepare("SELECT * FROM manager_runs ORDER BY id DESC LIMIT 1")
      .all() as { agents_checked: number }[];
    expect(runs[0].agents_checked).toBeGreaterThanOrEqual(1);
  });
});
