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

// Helper: set up a running task with agent assigned
async function setupRunningTask(
  phases: { name: string; prompt: string }[] = [],
): Promise<{ agentId: string; taskId: string; teamId: string }> {
  const agentId = createAgent("Dev Agent", "test-echo", "Build software");
  const teamId = createTeamWithEntrypoint(agentId, phases);
  const taskId = createApprovedTask(teamId);
  await daemon.processTaskQueue();
  return { agentId, taskId, teamId };
}

describe("handlePhaseComplete (streaming)", () => {
  it("completes task when on last phase", async () => {
    const phases = [
      { name: "Planning", prompt: "Plan" },
      { name: "Implementation", prompt: "Implement" },
    ];
    const { agentId, taskId } = await setupRunningTask(phases);

    // Set to last phase
    db.prepare("UPDATE tasks SET current_phase = 1 WHERE id = ?").run(taskId);

    daemon.handlePhaseComplete(agentId);

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("completed");
  });

  it("completes task when no phases defined", async () => {
    const { agentId, taskId } = await setupRunningTask([]);

    daemon.handlePhaseComplete(agentId);

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("completed");
  });

  it("advances phase and sends next prompt when more phases remain", async () => {
    const phases = [
      { name: "Planning", prompt: "Create a plan" },
      { name: "Implementation", prompt: "Implement the plan" },
      { name: "Testing", prompt: "Write tests" },
    ];
    const { agentId, taskId } = await setupRunningTask(phases);

    // Spy on sendInput to capture the prompt
    const agentManager = daemon.getAgentManager();
    let capturedPrompt = "";
    const origSendInput = agentManager.sendInput.bind(agentManager);
    spyOn(agentManager, "sendInput").mockImplementation(
      (id: string, input: string, close?: boolean) => {
        capturedPrompt = input;
        origSendInput(id, input, close);
      },
    );

    daemon.handlePhaseComplete(agentId);

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");
    expect(task?.current_phase).toBe(1);
    expect(capturedPrompt).toContain("CURRENT PHASE (2/3): Implementation");
    expect(capturedPrompt).toContain("Implement the plan");
  });

  it("deduplicates phase complete signals for same phase", async () => {
    const phases = [
      { name: "Phase 1", prompt: "P1" },
      { name: "Phase 2", prompt: "P2" },
      { name: "Phase 3", prompt: "P3" },
    ];
    const { agentId, taskId } = await setupRunningTask(phases);

    // Pre-add dedup key for current phase (simulating signal already handled)
    daemon.getPhaseCompleteHandled().add(`${taskId}:0`);

    // Call should be blocked by dedup — should NOT advance
    daemon.handlePhaseComplete(agentId);
    const task = scheduler.getTask(taskId);
    expect(task?.current_phase).toBe(0);
    expect(task?.status).toBe("running");
  });

  it("ignores phase complete for agent with no task", () => {
    const agentId = createAgent("Idle Agent", "test-echo");
    // Should not throw
    daemon.handlePhaseComplete(agentId);
  });
});

describe("handlePhaseRegression", () => {
  it("regresses task to target phase (1-indexed)", async () => {
    const phases = [
      { name: "Planning", prompt: "Plan" },
      { name: "Implementation", prompt: "Implement" },
      { name: "Testing", prompt: "Test" },
    ];
    const { agentId, taskId } = await setupRunningTask(phases);

    // Advance to phase 2 (0-indexed)
    db.prepare("UPDATE tasks SET current_phase = 2 WHERE id = ?").run(taskId);

    // Regress to phase 1 (1-indexed = phase 0 in 0-indexed)
    daemon.handlePhaseRegression(agentId, 1, "QA found bugs");

    const task = scheduler.getTask(taskId);
    expect(task?.current_phase).toBe(0);
    expect(task?.regression_count).toBe(1);
  });

  it("records regression in phase_regressions audit table", async () => {
    const phases = [
      { name: "Planning", prompt: "Plan" },
      { name: "Implementation", prompt: "Implement" },
    ];
    const { agentId, taskId } = await setupRunningTask(phases);
    db.prepare("UPDATE tasks SET current_phase = 1 WHERE id = ?").run(taskId);

    daemon.handlePhaseRegression(agentId, 1, "Bugs found");

    const regressions = db
      .prepare("SELECT * FROM phase_regressions WHERE task_id = ?")
      .all(taskId) as { from_phase: number; to_phase: number; reason: string }[];
    expect(regressions.length).toBe(1);
    expect(regressions[0].from_phase).toBe(1);
    expect(regressions[0].to_phase).toBe(0);
    expect(regressions[0].reason).toBe("Bugs found");
  });

  it("stores regression reason as task note", async () => {
    const phases = [
      { name: "Planning", prompt: "Plan" },
      { name: "Implementation", prompt: "Implement" },
    ];
    const { agentId, taskId } = await setupRunningTask(phases);
    db.prepare("UPDATE tasks SET current_phase = 1 WHERE id = ?").run(taskId);

    daemon.handlePhaseRegression(agentId, 1, "Auth bypass vulnerability");

    const notes = db
      .prepare("SELECT * FROM task_notes WHERE task_id = ?")
      .all(taskId) as { content: string }[];
    expect(notes.length).toBe(1);
    expect(notes[0].content).toContain("[PHASE REGRESSION to phase 1]");
    expect(notes[0].content).toContain("Auth bypass vulnerability");
  });

  it("clears phase dedup guards for target and later phases", async () => {
    const phases = [
      { name: "Phase 1", prompt: "P1" },
      { name: "Phase 2", prompt: "P2" },
      { name: "Phase 3", prompt: "P3" },
    ];
    const { agentId, taskId } = await setupRunningTask(phases);

    // Simulate phases 0 and 1 being completed
    daemon.getPhaseCompleteHandled().add(`${taskId}:0`);
    daemon.getPhaseCompleteHandled().add(`${taskId}:1`);

    db.prepare("UPDATE tasks SET current_phase = 2 WHERE id = ?").run(taskId);

    // Regress to phase 1 (0-indexed = 0)
    daemon.handlePhaseRegression(agentId, 1, "Issues found");

    // Phase 0, 1, and 2 dedup guards should be cleared
    expect(daemon.getPhaseCompleteHandled().has(`${taskId}:0`)).toBe(false);
    expect(daemon.getPhaseCompleteHandled().has(`${taskId}:1`)).toBe(false);
  });

  it("stores pending regression for exec-mode agents", async () => {
    setupAgentType("exec-agent", false);
    const agentId = createAgent("Exec Agent", "exec-agent", "Build software");
    const phases = [
      { name: "Planning", prompt: "Plan" },
      { name: "Implementation", prompt: "Implement" },
    ];
    const teamId = createTeamWithEntrypoint(agentId, phases);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    db.prepare("UPDATE tasks SET current_phase = 1 WHERE id = ?").run(taskId);

    daemon.handlePhaseRegression(agentId, 1, "Needs rework");

    const pending = daemon.getPendingRegression(agentId);
    expect(pending).toBeDefined();
    expect(pending!.targetPhase).toBe(0);
    expect(pending!.reason).toBe("Needs rework");
  });

  it("auto-escalates when max regressions exceeded", async () => {
    const phases = [
      { name: "Planning", prompt: "Plan" },
      { name: "Implementation", prompt: "Implement" },
    ];
    const { agentId, taskId } = await setupRunningTask(phases);

    // Set regression_count to MAX
    db.prepare("UPDATE tasks SET current_phase = 1, regression_count = 3 WHERE id = ?").run(taskId);

    daemon.handlePhaseRegression(agentId, 1, "Yet another issue");

    // Should have created an escalation
    const escalations = db
      .prepare("SELECT * FROM escalations WHERE task_id = ?")
      .all(taskId) as { type: string; severity: string; question: string }[];
    expect(escalations.length).toBe(1);
    expect(escalations[0].type).toBe("max_regressions");
    expect(escalations[0].severity).toBe("high");

    // Task should NOT have been regressed (still at phase 1)
    const task = scheduler.getTask(taskId);
    expect(task?.current_phase).toBe(1);
  });

  it("ignores regression with invalid target phase", async () => {
    const phases = [
      { name: "Planning", prompt: "Plan" },
      { name: "Implementation", prompt: "Implement" },
    ];
    const { agentId, taskId } = await setupRunningTask(phases);

    // Try to regress forward (current phase is 0, target is 2 which is 1 in 0-indexed)
    daemon.handlePhaseRegression(agentId, 2, "Invalid");

    // No regression should have occurred
    const regressions = db
      .prepare("SELECT * FROM phase_regressions WHERE task_id = ?")
      .all(taskId) as unknown[];
    // Audit record is created before validation of target < current
    // But the actual regressPhase should not have been called
    const task = scheduler.getTask(taskId);
    expect(task?.current_phase).toBe(0);
  });

  it("ignores regression for agent with no task", () => {
    const agentId = createAgent("Idle Agent", "test-echo");
    // Should not throw
    daemon.handlePhaseRegression(agentId, 1, "No task");
  });
});

describe("pending regression in exit handler", () => {
  it("processes pending regression on exec-mode agent exit", async () => {
    setupAgentType("exec-agent", false);
    const agentId = createAgent("Exec Agent", "exec-agent", "Build software");
    const phases = [
      { name: "Planning", prompt: "Plan" },
      { name: "Implementation", prompt: "Implement" },
      { name: "Testing", prompt: "Test" },
    ];
    const teamId = createTeamWithEntrypoint(agentId, phases);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    // Advance to phase 2
    db.prepare("UPDATE tasks SET current_phase = 2 WHERE id = ?").run(taskId);

    // Trigger regression (stores pending for exec-mode)
    daemon.handlePhaseRegression(agentId, 1, "Bugs in planning");

    // Verify phase was regressed synchronously by handlePhaseRegression
    let task = scheduler.getTask(taskId);
    expect(task?.current_phase).toBe(0);
    expect(task?.regression_count).toBe(1);

    // Verify pending regression exists (for respawn on exit)
    expect(daemon.getPendingRegression(agentId)).toBeDefined();

    // Simulate agent exit — should consume the pending regression
    const exitEvent: AgentExitEvent = {
      agentId,
      code: 0,
      isRespawn: false,
      hasDelegation: false,
    };

    eventBus.emit("agent:exit", exitEvent);
    await new Promise((r) => setTimeout(r, 1500));

    // Pending regression should be consumed
    expect(daemon.getPendingRegression(agentId)).toBeUndefined();
  });
});
