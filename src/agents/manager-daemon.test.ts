import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { ManagerDaemon } from "./manager-daemon";
import { TaskScheduler } from "../tasks/scheduler";
import { TeamManager } from "../teams/manager";
import { AgentManager } from "./manager";
import { clearAgentTypeCache } from "./types";
import { setBoolSetting, SETTING_PARALLEL_TASKS } from "../config/app-settings";
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
  instruction?: string,
): string {
  const id = crypto.randomUUID();
  const config = instruction ? JSON.stringify({ instruction }) : "{}";
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
    "INSERT INTO teams (id, name, entrypoint_agent_id, phases) VALUES (?, ?, 'skipper', ?)",
  ).run(teamId, "Test Team", JSON.stringify(phases));

  // Add Skipper at level 0
  const skipperTaId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES (?, ?, 'skipper', 'lead', 0)",
  ).run(skipperTaId, teamId);

  // Add the worker agent at level 1
  if (agentId !== "skipper") {
    const taId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES (?, ?, ?, 'worker', 1)",
    ).run(taId, teamId, agentId);
  }

  return teamId;
}

function addAgentToTeam(teamId: string, agentId: string): void {
  if (agentId === "skipper") return; // Already added
  const taId = crypto.randomUUID();
  db.prepare(
    "INSERT OR IGNORE INTO team_agents (id, team_id, agent_id, role, level) VALUES (?, ?, ?, 'worker', 1)",
  ).run(taId, teamId, agentId);
}

function createApprovedTask(teamId: string, title = "Test Task"): string {
  const taskId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, title, description, team_id, status, approved_at)
     VALUES (?, ?, 'Task description', ?, 'approved', datetime('now'))`,
  ).run(taskId, title, teamId);
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
  db.prepare("INSERT OR IGNORE INTO agents (id, name, type, model) VALUES ('skipper', 'Skipper', 'claude-code', 'default')").run();
  setupAgentType();
  // Update Skipper to use the test-echo agent type so it can be spawned in tests
  db.prepare("UPDATE agents SET type = 'test-echo' WHERE id = 'skipper'").run();
  daemon = new ManagerDaemon(db);
  scheduler = new TaskScheduler(db);
  teamManager = new TeamManager(db);
});

afterEach(() => {
  daemon.stop();
  daemon.getAgentManager().close();
  // Remove all event listeners to avoid cross-test leaks
  eventBus.removeAllListeners();
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch { }
});

describe("ManagerDaemon lifecycle", () => {
  it("starts and stops the daemon interval", async () => {
    await daemon.start();
    // Starting again should be a no-op
    await daemon.start();
    daemon.stop();
    // Stopping again should be a no-op
    daemon.stop();
  });

  it("exposes agent manager and task scheduler", () => {
    expect(daemon.getAgentManager()).toBeInstanceOf(AgentManager);
    expect(daemon.getTaskScheduler()).toBeInstanceOf(TaskScheduler);
  });

  it("pause stops processing and persists state", async () => {
    await daemon.start();
    expect(daemon.getStatus().state).toBe("running");

    await daemon.pause();
    expect(daemon.getStatus().state).toBe("paused");

    // Check paused state persisted to daemon_state table
    const row = db
      .prepare("SELECT value FROM daemon_state WHERE key = 'paused'")
      .get() as { value: string } | null;
    expect(row?.value).toBe("true");
  });

  it("resume restarts the daemon after pause", async () => {
    await daemon.start();
    await daemon.pause();
    expect(daemon.getStatus().state).toBe("paused");

    daemon.resume();
    expect(daemon.getStatus().state).toBe("running");

    // Paused state should be cleared
    const row = db
      .prepare("SELECT value FROM daemon_state WHERE key = 'paused'")
      .get() as { value: string } | null;
    expect(row).toBeNull();

    daemon.stop();
  });

  it("stays paused on start if daemon_state has paused=true", async () => {
    db.prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES ('paused', 'true')").run();
    await daemon.start();
    expect(daemon.getStatus().state).toBe("paused");

    // Clean up
    daemon.resume();
    daemon.stop();
  });

  it("tick only runs health checks when paused", async () => {
    await daemon.pause();

    // Tick should still work but skip task processing
    await daemon.tick();

    // Should still record a daemon run
    const runs = db
      .prepare("SELECT * FROM manager_runs")
      .all() as { tasks_processed: number }[];
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[runs.length - 1].tasks_processed).toBe(0);
  });
});

describe("runtime steering", () => {
  it("steers a running resumable runtime and logs the synthetic marker", async () => {
    setupAgentType("resumable-agent", true, true);
    db.prepare("UPDATE agent_types SET resume_flag = '--resume' WHERE name = 'resumable-agent'").run();
    const agentId = createAgent("Steerable", "resumable-agent");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId, "Steer Task");
    const runtimeId = "runtime-steer-1";

    await daemon.getAgentManager().spawnAgentInstance(agentId, runtimeId, {
      workingDir: process.cwd(),
      taskId,
      parentInstanceId: null,
      rootInstanceId: runtimeId,
      attempt: 1,
    });
    const runningBefore = daemon.getAgentManager().getRunningAgent(runtimeId);
    expect(runningBefore).toBeDefined();
    runningBefore!.sessionId = "sess-steer-123";
    const appendSpy = spyOn(daemon.getAgentManager(), "appendSyntheticOutput");

    await daemon.steerRuntime(agentId, runtimeId, "Use the updated approach");

    const runningAfter = daemon.getAgentManager().getRunningAgent(runtimeId);
    expect(runningAfter).toBeDefined();
    expect(runningAfter!.sessionId).toBe("sess-steer-123");
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith(
      runtimeId,
      `[SKIPPER] Operator steer injected for runtime ${runtimeId}: Use the updated approach`,
    );

    daemon.getAgentManager().killAgent(runtimeId);
    await daemon.getAgentManager().waitForExit(runtimeId, 2000);
  });

  it("rejects steering when no resumable session exists", async () => {
    setupAgentType("resumable-no-session", true, true);
    db.prepare("UPDATE agent_types SET resume_flag = '--resume' WHERE name = 'resumable-no-session'").run();
    const agentId = createAgent("No Session", "resumable-no-session");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId, "No Session Task");
    const runtimeId = "runtime-nosess-1";

    await daemon.getAgentManager().spawnAgentInstance(agentId, runtimeId, {
      workingDir: process.cwd(),
      taskId,
      parentInstanceId: null,
      rootInstanceId: runtimeId,
      attempt: 1,
    });

    await expect(daemon.steerRuntime(agentId, runtimeId, "Help")).rejects.toThrow(
      "Runtime has no resumable session yet.",
    );

    daemon.getAgentManager().killAgent(runtimeId);
    await daemon.getAgentManager().waitForExit(runtimeId, 2000);
  });

  it("rejects steering for non-resumable agent types", async () => {
    const agentId = createAgent("Not Resumable");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId, "Non Resumable Task");
    const runtimeId = "runtime-noresume-1";

    await daemon.getAgentManager().spawnAgentInstance(agentId, runtimeId, {
      workingDir: process.cwd(),
      taskId,
      parentInstanceId: null,
      rootInstanceId: runtimeId,
      attempt: 1,
    });

    await expect(daemon.steerRuntime(agentId, runtimeId, "Help")).rejects.toThrow(
      "Agent type does not support resume.",
    );

    daemon.getAgentManager().killAgent(runtimeId);
    await daemon.getAgentManager().waitForExit(runtimeId, 2000);
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
    // We'll spy on the internal taskRunner's processTaskQueue to throw
    const taskRunner = daemon.getTaskRunner();
    spyOn(taskRunner, "processTaskQueue").mockImplementation(() => {
      throw new Error("Test error");
    });

    await daemon.tick();

    const runs = db
      .prepare("SELECT * FROM manager_runs")
      .all() as { errors: string }[];
    expect(runs.length).toBe(1);
    const errors = JSON.parse(runs[0].errors);
    expect(errors.some((e: string) => e.includes("Test error"))).toBe(true);
  });
});

describe("processTaskQueue", () => {
  it("returns 0 processed when no approved tasks exist", async () => {
    const result = await daemon.processTaskQueue();
    expect(result.processed).toBe(0);
  });

  it("in sequential mode, returns 0 processed when a task is already running", async () => {
    setBoolSetting(db, SETTING_PARALLEL_TASKS, false);
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    createRunningTask(teamId);

    // Also create an approved task
    createApprovedTask(teamId);

    const result = await daemon.processTaskQueue();
    expect(result.processed).toBe(0);
  });

  it("in parallel mode, dispatches an approved task while another is running", async () => {
    setBoolSetting(db, SETTING_PARALLEL_TASKS, true);
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    createRunningTask(teamId);

    const approvedId = createApprovedTask(teamId);

    const result = await daemon.processTaskQueue();
    expect(result.processed).toBe(1);
    expect(scheduler.getTask(approvedId)?.status).toBe("running");
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

  it("fails task when team has no explicit entrypoint", async () => {
    // Create team without explicit entrypoint_agent_id
    const agentId = createAgent("Agent", "test-echo");
    const teamId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO teams (id, name) VALUES (?, 'No Entry Team')",
    ).run(teamId);
    const taId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO team_agents (id, team_id, agent_id) VALUES (?, ?, ?)",
    ).run(taId, teamId, agentId);

    const taskId = createApprovedTask(teamId);

    const result = await daemon.processTaskQueue();
    expect(result.processed).toBe(1);

    // Task should be failed because team has no entrypoint
    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("failed");
  });

  it("does not treat delegated child PID on template row as orphaned", async () => {
    const workerId = createAgent("Worker Agent");
    const childId = createAgent("Child Agent");
    const teamId = createTeamWithEntrypoint(workerId);
    addAgentToTeam(teamId, childId);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    const delegation = await daemon.handleDelegation("skipper", childId, "do work");
    expect(delegation).not.toBeNull();
    const childInstanceId = delegation!.child_instance_id!;
    const childRuntime = daemon.getAgentManager().getRunningAgent(childInstanceId);
    expect(childRuntime).toBeDefined();

    const before = db
      .prepare("SELECT process_pid FROM agents WHERE id = ?")
      .get(childId) as { process_pid: number | null };
    expect(before.process_pid).toBe(childRuntime!.process.pid);

    daemon.checkProcessHealth();

    const after = db
      .prepare("SELECT process_pid FROM agents WHERE id = ?")
      .get(childId) as { process_pid: number | null };
    expect(after.process_pid).toBe(childRuntime!.process.pid);

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");
  });

  it("fails task when skipper agent is deleted", async () => {
    // Create agent, set up team, then delete Skipper from DB
    const agentId = createAgent("Temp Agent", "test-echo");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    // Remove Skipper (disable FK temporarily to simulate orphaned reference)
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM agents WHERE id = 'skipper'").run();
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

    // Skipper (the entrypoint) should have current_task_id set
    const agentRow = db
      .prepare("SELECT current_task_id FROM agents WHERE id = ?")
      .get("skipper") as { current_task_id: string | null };
    expect(agentRow.current_task_id).toBe(taskId);
  });

  it("handles spawn failure gracefully", async () => {
    // Set Skipper to a bad type that will fail to spawn
    setupAgentType("bad-type");
    db.prepare(
      "UPDATE agent_types SET command = 'nonexistent-binary-12345' WHERE name = 'bad-type'",
    ).run();
    db.prepare("UPDATE agents SET type = 'bad-type' WHERE id = 'skipper'").run();
    clearAgentTypeCache();
    const agentId = createAgent("Worker Agent", "test-echo");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    const result = await daemon.processTaskQueue();
    expect(result.processed).toBe(1);

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("failed");
  });

  it("processes earliest created task first", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);

    const firstId = createApprovedTask(teamId, "First Task");
    const secondId = createApprovedTask(teamId, "Second Task");

    const result = await daemon.processTaskQueue();
    expect(result.processed).toBe(1);

    // First task should be running
    const firstTask = scheduler.getTask(firstId);
    expect(firstTask?.status).toBe("running");

    // Second should still be approved
    const secondTask = scheduler.getTask(secondId);
    expect(secondTask?.status).toBe("approved");
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

  it("resumes from saved phase when a failed task is resumed", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const phases = [
      { name: "Planning", prompt: "Create a plan" },
      { name: "Implementation", prompt: "Implement the plan" },
    ];
    const teamId = createTeamWithEntrypoint(agentId, phases);
    const taskId = createApprovedTask(teamId);

    // Simulate a previously failed task at phase 2, then resume it.
    db.prepare("UPDATE tasks SET status = 'failed', current_phase = 1 WHERE id = ?").run(taskId);
    scheduler.resumeTask(taskId);

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

    expect(capturedPrompt).toContain("CURRENT PHASE (2/2): Implementation");
    expect(capturedPrompt).toContain("Implement the plan");
  });

  it("closes stdin for non-streaming agents", async () => {
    setupAgentType("exec-agent", false);
    // Update Skipper to use exec-agent type (non-streaming)
    db.prepare("UPDATE agents SET type = 'exec-agent' WHERE id = 'skipper'").run();
    clearAgentTypeCache();
    const agentId = createAgent("Worker Agent", "exec-agent");
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
  it("does not complete task while escalation is open", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    daemon.getEscalationManager().createEscalation({
      agentId: "skipper",
      runtimeAgentId: "skipper",
      taskId,
      type: "agent_request",
      question: "Need operator decision",
    });

    const exitEvent: AgentExitEvent = {
      agentId: "skipper",
      code: 0,
      isRespawn: false,
      hasDelegation: false,
    };
    eventBus.emit("agent:exit", exitEvent);

    await new Promise((r) => setTimeout(r, 50));

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");
  });

  it("marks task idle on successful exit; does not auto-complete (Skipper must call complete_task)", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    const exitEvent: AgentExitEvent = {
      agentId: "skipper",
      code: 0,
      isRespawn: false,
      hasDelegation: false,
    };

    eventBus.emit("agent:exit", exitEvent);
    eventBus.emit("agent:streams_drained", { agentId: exitEvent.agentId });
    await new Promise((r) => setTimeout(r, 100));

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");

    // IdlePokeManager should have recorded the task as idle
    const idleRow = db
      .prepare("SELECT value FROM daemon_state WHERE key = ?")
      .get(`idle_since:${taskId}`) as { value: string } | null;
    expect(idleRow).not.toBeNull();
  });

  it("fails task on non-zero exit", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    const exitEvent: AgentExitEvent = {
      agentId: "skipper",
      code: 1,
      isRespawn: false,
      hasDelegation: false,
    };

    eventBus.emit("agent:exit", exitEvent);
    eventBus.emit("agent:streams_drained", { agentId: exitEvent.agentId });
    await new Promise((r) => setTimeout(r, 100));

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("failed");
  });

  it("keeps task running on interrupted exit codes for recovery", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    const exitEvent: AgentExitEvent = {
      agentId: "skipper",
      code: 130,
      isRespawn: false,
      hasDelegation: false,
    };

    eventBus.emit("agent:exit", exitEvent);
    eventBus.emit("agent:streams_drained", { agentId: exitEvent.agentId });
    await new Promise((r) => setTimeout(r, 100));

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");

    const checkpoint = db
      .prepare("SELECT checkpoint_type FROM task_checkpoints WHERE task_id = ? ORDER BY sequence DESC LIMIT 1")
      .get(taskId) as { checkpoint_type: string } | null;
    expect(checkpoint?.checkpoint_type).toBe("AGENT_INTERRUPTED");
  });

  it("does not track interrupted exits for incident cluster detection", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    createApprovedTask(teamId);

    await daemon.processTaskQueue();

    const monitor = daemon.getHealthMonitor();
    const trackSpy = spyOn(monitor, "trackExitCode");

    const exitEvent: AgentExitEvent = {
      agentId: "skipper",
      code: 143,
      isRespawn: false,
      hasDelegation: false,
      stderrSnippet: "",
    };

    eventBus.emit("agent:exit", exitEvent);
    eventBus.emit("agent:streams_drained", { agentId: exitEvent.agentId });
    await new Promise((r) => setTimeout(r, 100));

    expect(trackSpy).not.toHaveBeenCalled();
  });

  it("skips respawn exits", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    const exitEvent: AgentExitEvent = {
      agentId: "skipper",
      code: 0,
      isRespawn: true,
      hasDelegation: false,
    };

    eventBus.emit("agent:exit", exitEvent);
    eventBus.emit("agent:streams_drained", { agentId: exitEvent.agentId });
    await new Promise((r) => setTimeout(r, 100));

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
      agentId: "skipper",
      code: 0,
      isRespawn: false,
      hasDelegation: true,
    };

    eventBus.emit("agent:exit", exitEvent);
    eventBus.emit("agent:streams_drained", { agentId: exitEvent.agentId });
    await new Promise((r) => setTimeout(r, 100));

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
    eventBus.emit("agent:streams_drained", { agentId: exitEvent.agentId });
    await new Promise((r) => setTimeout(r, 100));
  });

  it("does NOT advance phase on successful exit; task stays at current phase until Skipper calls complete_phase", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const phases = [
      { name: "Planning", prompt: "Create a plan" },
      { name: "Implementation", prompt: "Implement the plan" },
      { name: "Testing", prompt: "Write tests" },
    ];
    const teamId = createTeamWithEntrypoint(agentId, phases);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    let task = scheduler.getTask(taskId);
    expect(task?.current_phase).toBe(0);

    const exitEvent: AgentExitEvent = {
      agentId: "skipper",
      code: 0,
      isRespawn: false,
      hasDelegation: false,
    };

    eventBus.emit("agent:exit", exitEvent);
    eventBus.emit("agent:streams_drained", { agentId: exitEvent.agentId });
    await new Promise((r) => setTimeout(r, 100));

    // Phase remains 0 — no auto-advance under the explicit-advance model
    task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");
    expect(task?.current_phase).toBe(0);
  });

  it("does NOT auto-complete task on last-phase clean exit; Skipper must call complete_task", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const phases = [
      { name: "Planning", prompt: "Plan" },
      { name: "Implementation", prompt: "Implement" },
    ];
    const teamId = createTeamWithEntrypoint(agentId, phases);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();
    db.prepare("UPDATE tasks SET current_phase = 1 WHERE id = ?").run(taskId);

    const exitEvent: AgentExitEvent = {
      agentId: "skipper",
      code: 0,
      isRespawn: false,
      hasDelegation: false,
    };

    eventBus.emit("agent:exit", exitEvent);
    eventBus.emit("agent:streams_drained", { agentId: exitEvent.agentId });
    await new Promise((r) => setTimeout(r, 100));

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");
  });

  it("fails non-streaming successful exit when no completed-turn output exists", async () => {
    setupAgentType("exec-agent", false);
    db.prepare("UPDATE agents SET type = 'exec-agent' WHERE id = 'skipper'").run();
    clearAgentTypeCache();

    const workerId = createAgent("Worker Agent", "exec-agent", "Build software");
    const teamId = createTeamWithEntrypoint(workerId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    const exitEvent: AgentExitEvent = {
      agentId: "skipper",
      code: 0,
      isRespawn: false,
      hasDelegation: false,
    };

    eventBus.emit("agent:exit", exitEvent);
    eventBus.emit("agent:streams_drained", { agentId: exitEvent.agentId });
    await new Promise((r) => setTimeout(r, 100));

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("failed");
    const row = db.prepare("SELECT result FROM tasks WHERE id = ?").get(taskId) as { result: string | null } | null;
    expect(row?.result ?? "").toContain("missing result/turn.completed/step_finish");
  });

  it("accepts non-streaming successful exit when completed-turn output exists in instance window", async () => {
    setupAgentType("exec-agent", false);
    db.prepare("UPDATE agents SET type = 'exec-agent' WHERE id = 'skipper'").run();
    clearAgentTypeCache();

    const workerId = createAgent("Worker Agent", "exec-agent", "Build software");
    const teamId = createTeamWithEntrypoint(workerId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    // Get the actual runtime ID (UUID) for the entrypoint agent
    const running = daemon.getAgentManager().getRunningAgent("skipper");
    expect(running).toBeTruthy();
    const runtimeId = running!.id;

    // Write a completed-turn JSON event in the same instance time window.
    db.prepare("INSERT INTO agent_sessions (id, agent_id) VALUES (?, ?)").run("sess-out-1", runtimeId);
    db.prepare(
      "INSERT INTO terminal_outputs (agent_id, session_id, stream, data, sequence) VALUES (?, ?, 'stdout', ?, ?)",
    ).run(
      runtimeId,
      "sess-out-1",
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
      1,
    );

    const exitEvent: AgentExitEvent = {
      agentId: runtimeId,
      code: 0,
      isRespawn: false,
      hasDelegation: false,
    };

    eventBus.emit("agent:exit", exitEvent);
    eventBus.emit("agent:streams_drained", { agentId: exitEvent.agentId });
    await new Promise((r) => setTimeout(r, 100));

    // No auto-advance — task stays running, marked idle
    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");
    const idleRow = db.prepare("SELECT value FROM daemon_state WHERE key = ?").get(`idle_since:${taskId}`) as { value: string } | null;
    expect(idleRow).not.toBeNull();
  });

  it("accepts non-streaming successful exit when step_finish output exists in instance window", async () => {
    setupAgentType("exec-agent", false);
    db.prepare("UPDATE agents SET type = 'exec-agent' WHERE id = 'skipper'").run();
    clearAgentTypeCache();

    const workerId = createAgent("Worker Agent", "exec-agent", "Build software");
    const teamId = createTeamWithEntrypoint(workerId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    const running = daemon.getAgentManager().getRunningAgent("skipper");
    expect(running).toBeTruthy();
    const runtimeId = running!.id;

    db.prepare("INSERT INTO agent_sessions (id, agent_id) VALUES (?, ?)").run("sess-out-2", runtimeId);
    db.prepare(
      "INSERT INTO terminal_outputs (agent_id, session_id, stream, data, sequence) VALUES (?, ?, 'stdout', ?, ?)",
    ).run(
      runtimeId,
      "sess-out-2",
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 10, output: 5 } } }),
      1,
    );

    const exitEvent: AgentExitEvent = {
      agentId: runtimeId,
      code: 0,
      isRespawn: false,
      hasDelegation: false,
    };

    eventBus.emit("agent:exit", exitEvent);
    eventBus.emit("agent:streams_drained", { agentId: exitEvent.agentId });
    await new Promise((r) => setTimeout(r, 100));

    // No auto-advance — task stays running, marked idle
    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");
    const idleRow = db.prepare("SELECT value FROM daemon_state WHERE key = ?").get(`idle_since:${taskId}`) as { value: string } | null;
    expect(idleRow).not.toBeNull();
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
  // Create a worker agent but Skipper is always the entrypoint
  const workerId = createAgent("Dev Agent", "test-echo", "Build software");
  const teamId = createTeamWithEntrypoint(workerId, phases);
  const taskId = createApprovedTask(teamId);
  await daemon.processTaskQueue();
  // Return "skipper" as the agentId since that's the actual entrypoint
  return { agentId: "skipper", taskId, teamId };
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

    await daemon.handlePhaseComplete(agentId);

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

  it("regresses immediately for exec-mode agents (no deferred pending map)", async () => {
    setupAgentType("exec-agent", false);
    db.prepare("UPDATE agents SET type = 'exec-agent' WHERE id = 'skipper'").run();
    clearAgentTypeCache();
    const agentId = createAgent("Worker Agent", "exec-agent", "Build software");
    const phases = [
      { name: "Planning", prompt: "Plan" },
      { name: "Implementation", prompt: "Implement" },
    ];
    const teamId = createTeamWithEntrypoint(agentId, phases);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    db.prepare("UPDATE tasks SET current_phase = 1 WHERE id = ?").run(taskId);

    daemon.handlePhaseRegression("skipper", 1, "Needs rework");

    // Phase should be regressed synchronously regardless of streaming mode
    const task = scheduler.getTask(taskId);
    expect(task?.current_phase).toBe(0);
    expect(task?.regression_count).toBe(1);
  });

  it("auto-escalates when max regressions exceeded", async () => {
    const phases = [
      { name: "Planning", prompt: "Plan" },
      { name: "Implementation", prompt: "Implement" },
    ];
    const { agentId, taskId } = await setupRunningTask(phases);

    // Set regression_count to MAX
    db.prepare("UPDATE tasks SET current_phase = 1, regression_count = 20 WHERE id = ?").run(taskId);

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
    const task = scheduler.getTask(taskId);
    expect(task?.current_phase).toBe(0);
  });

  it("ignores regression for agent with no task", () => {
    const agentId = createAgent("Idle Agent", "test-echo");
    // Should not throw
    daemon.handlePhaseRegression(agentId, 1, "No task");
  });
});

// Helper: create a second agent in the same team
describe("handleDelegation", () => {
  it("creates delegation and spawns child agent", async () => {
    const workerId = createAgent("Worker", "test-echo", "Lead dev");
    const childId = createAgent("Child", "test-echo", "Reviewer");
    const teamId = createTeamWithEntrypoint(workerId);
    addAgentToTeam(teamId, childId);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    const delegation = await daemon.handleDelegation("skipper", childId, "Review the code");

    expect(delegation).not.toBeNull();
    expect(delegation!.parent_agent_id).toBe("skipper");
    expect(delegation!.child_agent_id).toBe(childId);
    expect(delegation!.task_id).toBe(taskId);
    expect(delegation!.prompt).toBe("Review the code");
    expect(delegation!.status).toBe("running");

    // Child should have task assigned
    const childRow = db.prepare("SELECT current_task_id FROM agents WHERE id = ?").get(childId) as { current_task_id: string | null };
    expect(childRow.current_task_id).toBe(taskId);

    // Skipper state should be waiting_delegation
    const parentState = db.prepare("SELECT state, state_metadata FROM agent_states WHERE agent_id = ?").get("skipper") as { state: string; state_metadata: string } | null;
    expect(parentState?.state).toBe("waiting_delegation");
  });

  it("returns null when parent has no task", async () => {
    const workerId = createAgent("Worker", "test-echo");
    const childId = createAgent("Child", "test-echo");
    const teamId = createTeamWithEntrypoint(workerId);
    addAgentToTeam(teamId, childId);

    // Skipper has no task assigned (no processTaskQueue called)
    const result = await daemon.handleDelegation("skipper", childId, "Do work");
    expect(result).toBeNull();
  });

  it("returns null when child does not exist", async () => {
    const workerId = createAgent("Worker", "test-echo");
    const teamId = createTeamWithEntrypoint(workerId);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    const result = await daemon.handleDelegation("skipper", "nonexistent", "Do work");
    expect(result).toBeNull();
  });

  it("delegates via handleDelegation method (MCP path)", async () => {
    const workerId = createAgent("Worker", "test-echo");
    const investigatorId = createAgent("Investigator Agent", "test-echo");
    const teamId = createTeamWithEntrypoint(workerId);
    addAgentToTeam(teamId, investigatorId);
    createApprovedTask(teamId);
    await daemon.processTaskQueue();

    const delegation = await daemon.handleDelegation("skipper", investigatorId, "Investigate production failure");
    expect(delegation).not.toBeNull();

    const rows = db
      .prepare("SELECT child_agent_id, prompt, status FROM delegations ORDER BY created_at DESC LIMIT 1")
      .all() as { child_agent_id: string; prompt: string; status: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].child_agent_id).toBe(investigatorId);
    expect(rows[0].prompt).toBe("Investigate production failure");
    expect(rows[0].status).toBe("running");
  });

  it("returns null when agents are not in same team", async () => {
    const workerId = createAgent("Worker", "test-echo");
    const childId = createAgent("Child", "test-echo");
    const teamId = createTeamWithEntrypoint(workerId);
    // Child is NOT added to team
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    const result = await daemon.handleDelegation("skipper", childId, "Do work");
    expect(result).toBeNull();
  });

  it("returns null when parent already has active delegation", async () => {
    const workerId = createAgent("Worker", "test-echo");
    const child1Id = createAgent("Child 1", "test-echo");
    const child2Id = createAgent("Child 2", "test-echo");
    const teamId = createTeamWithEntrypoint(workerId);
    addAgentToTeam(teamId, child1Id);
    addAgentToTeam(teamId, child2Id);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    // First delegation succeeds
    const d1 = await daemon.handleDelegation("skipper", child1Id, "First task");
    expect(d1).not.toBeNull();

    // Second delegation should fail (concurrent limit 1)
    const d2 = await daemon.handleDelegation("skipper", child2Id, "Second task");
    expect(d2).toBeNull();
  });

  it("returns null when parent type does not support result receipt", async () => {
    // custom type with no stdin and no resume
    setupAgentType("no-io", false, false);
    // Update Skipper to no-io type
    db.prepare("UPDATE agents SET type = 'no-io' WHERE id = 'skipper'").run();
    clearAgentTypeCache();
    const childId = createAgent("Child", "test-echo");
    const workerId = createAgent("Worker", "test-echo");
    const teamId = createTeamWithEntrypoint(workerId);
    addAgentToTeam(teamId, childId);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    const result = await daemon.handleDelegation("skipper", childId, "Do work");
    expect(result).toBeNull();
  });

  it("allows delegation chains deeper than 3", async () => {
    const a2 = createAgent("Agent 2", "test-echo", "Mid 1");
    const a3 = createAgent("Agent 3", "test-echo", "Mid 2");
    const a4 = createAgent("Agent 4", "test-echo", "Bottom");
    const a5 = createAgent("Agent 5", "test-echo", "Deeper");
    const workerId = createAgent("Worker", "test-echo", "Top");
    const teamId = createTeamWithEntrypoint(workerId);
    addAgentToTeam(teamId, a2);
    addAgentToTeam(teamId, a3);
    addAgentToTeam(teamId, a4);
    addAgentToTeam(teamId, a5);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    // Create chain: skipper -> a2 -> a3 -> a4 -> a5
    const d1 = await daemon.handleDelegation("skipper", a2, "Level 1");
    expect(d1).not.toBeNull();
    const d2 = await daemon.handleDelegation(a2, a3, "Level 2");
    expect(d2).not.toBeNull();
    const d3 = await daemon.handleDelegation(a3, a4, "Level 3");
    expect(d3).not.toBeNull();
    const d4 = await daemon.handleDelegation(a4, a5, "Level 4");
    expect(d4).not.toBeNull();
  });
});

describe("handleDelegateComplete", () => {
  it("completes delegation and routes result to parent", async () => {
    const workerId = createAgent("Worker", "test-echo", "Lead");
    const childId = createAgent("Child", "test-echo", "Worker");
    const teamId = createTeamWithEntrypoint(workerId);
    addAgentToTeam(teamId, childId);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    await daemon.handleDelegation("skipper", childId, "Review code");

    // Spy on sendInput to verify result routing
    const agentManager = daemon.getAgentManager();
    let capturedInput = "";
    const origSendInput = agentManager.sendInput.bind(agentManager);
    spyOn(agentManager, "sendInput").mockImplementation(
      (id: string, input: string, close?: boolean) => {
        if (id === "skipper") capturedInput = input;
        origSendInput(id, input, close);
      },
    );

    daemon.handleDelegateComplete(childId, "Code looks good, approved");

    // Delegation should be completed
    const delegation = daemon.getActiveDelegationForChild(childId);
    expect(delegation).toBeNull();

    // Result should have been routed to parent (Skipper)
    expect(capturedInput).toContain("[DELEGATION_RESULT from:");
    expect(capturedInput).toContain("Code looks good, approved");
    expect(capturedInput).toContain("[END_DELEGATION_RESULT]");

    // Skipper state should be working
    const parentState = db.prepare("SELECT state FROM agent_states WHERE agent_id = ?").get("skipper") as { state: string } | null;
    expect(parentState?.state).toBe("working");

    // Child task assignment cleared
    const childRow = db.prepare("SELECT current_task_id FROM agents WHERE id = ?").get(childId) as { current_task_id: string | null };
    expect(childRow.current_task_id).toBeNull();
  });

  it("ignores delegate complete for agent with no active delegation", () => {
    const agentId = createAgent("Lone Agent", "test-echo");
    // Should not throw
    daemon.handleDelegateComplete(agentId, "Some result");
  });
});

describe("child exit handling for delegations", () => {
  it("completes delegation on child exit code 0", async () => {
    const workerId = createAgent("Worker", "test-echo", "Lead");
    const childId = createAgent("Child", "test-echo", "Worker");
    const teamId = createTeamWithEntrypoint(workerId);
    addAgentToTeam(teamId, childId);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    await daemon.handleDelegation("skipper", childId, "Do task");

    // Simulate child exit with code 0
    const exitEvent: AgentExitEvent = {
      agentId: childId,
      code: 0,
      isRespawn: false,
      hasDelegation: false,
    };

    eventBus.emit("agent:exit", exitEvent);
    eventBus.emit("agent:streams_drained", { agentId: exitEvent.agentId });
    await new Promise((r) => setTimeout(r, 100));

    // Delegation should be completed
    const delegation = daemon.getActiveDelegationForChild(childId);
    expect(delegation).toBeNull();

    // Skipper state should be working
    const parentState = db.prepare("SELECT state FROM agent_states WHERE agent_id = ?").get("skipper") as { state: string } | null;
    expect(parentState?.state).toBe("working");
  });

  it("fails delegation on child non-zero exit", async () => {
    const workerId = createAgent("Worker", "test-echo", "Lead");
    const childId = createAgent("Child", "test-echo", "Worker");
    const teamId = createTeamWithEntrypoint(workerId);
    addAgentToTeam(teamId, childId);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    const delegation = await daemon.handleDelegation("skipper", childId, "Do task");
    expect(delegation).not.toBeNull();
    const childInstanceId = delegation!.child_instance_id;

    // Exhaust retry limit so the delegation won't be retried on failure
    db.prepare("UPDATE agent_instances SET attempt = 2 WHERE id = ?").run(childInstanceId);

    const exitEvent: AgentExitEvent = {
      agentId: childInstanceId,
      code: 1,
      isRespawn: false,
      hasDelegation: false,
    };

    eventBus.emit("agent:exit", exitEvent);
    eventBus.emit("agent:streams_drained", { agentId: exitEvent.agentId });
    await new Promise((r) => setTimeout(r, 200));

    // Delegation should be failed
    const allDelegations = db.prepare("SELECT * FROM delegations WHERE child_agent_id = ?").all(childId) as { status: string; result: string }[];
    expect(allDelegations.length).toBe(1);
    expect(allDelegations[0].status).toBe("failed");
    expect(allDelegations[0].result).toContain("exited with code 1");
  });
});

describe("checkStaleDelegations", () => {
  it("times out delegations older than 60 minutes", async () => {
    const workerId = createAgent("Worker", "test-echo", "Lead");
    const childId = createAgent("Child", "test-echo", "Worker");
    const teamId = createTeamWithEntrypoint(workerId);
    addAgentToTeam(teamId, childId);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    const deleg = await daemon.handleDelegation("skipper", childId, "Long task");
    expect(deleg).not.toBeNull();

    // Exhaust retry limit so the delegation won't be retried
    const childInstanceId = deleg!.child_instance_id;
    db.prepare(
      "UPDATE agent_instances SET attempt = 2 WHERE id = ?",
    ).run(childInstanceId);

    // Backdate the delegation beyond the timeout window and ensure status is running
    db.prepare(
      "UPDATE delegations SET created_at = datetime('now', '-2 hours'), status = 'running' WHERE id = ?",
    ).run(deleg!.id);
    db.prepare(
      "UPDATE agent_instances SET created_at = datetime('now', '-2 hours') WHERE id = ?",
    ).run(childInstanceId);

    const timedOut = daemon.checkStaleDelegations();
    expect(timedOut).toBe(1);

    // Delegation should be failed
    const delegations = db.prepare("SELECT * FROM delegations WHERE id = ?").all(deleg!.id) as { status: string; result: string }[];
    expect(delegations[0].status).toBe("failed");
    expect(delegations[0].result).toContain("timed out");

    // Skipper state reset
    const parentState = db.prepare("SELECT state FROM agent_states WHERE agent_id = ?").get("skipper") as { state: string } | null;
    expect(parentState?.state).toBe("working");
  });

  it("returns 0 when no stale delegations exist", () => {
    const count = daemon.checkStaleDelegations();
    expect(count).toBe(0);
  });
});

describe("delegation helpers", () => {
  it("getActiveDelegationForParent returns null when none exist", () => {
    expect(daemon.getActiveDelegationForParent("nonexistent")).toBeNull();
  });

  it("getActiveDelegationForChild returns null when none exist", () => {
    expect(daemon.getActiveDelegationForChild("nonexistent")).toBeNull();
  });

  it("getDelegation returns null for nonexistent id", () => {
    expect(daemon.getDelegation("nonexistent")).toBeNull();
  });

  it("closes stdin when routing delegation result via resume to non-streaming parent", () => {
    const parentId = createAgent("Resume Parent", "codex");
    const childId = createAgent("Child");
    const agentManager = daemon.getAgentManager();
    const resumeSpy = spyOn(agentManager, "sendResumeMessage").mockResolvedValue();

    daemon.getDelegationManager().routeResultToParent(parentId, childId, "child result");

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy).toHaveBeenCalledWith(
      parentId,
      expect.stringContaining("[DELEGATION_RESULT"),
      true,
    );
    resumeSpy.mockRestore();
  });
});

// --- STORY-015: Health Checks & Stuck Detection Tests ---

describe("checkProcessHealth", () => {
  it("does nothing when no agents have PIDs", () => {
    createAgent("Idle Agent");
    // Should not throw
    daemon.checkProcessHealth();
  });

  it("cleans up DB entry for agent whose OS process has died", () => {
    const agentId = createAgent("Dead Agent");
    const fakePid = 99999999;
    db.prepare("UPDATE agents SET process_pid = ?, status = 'busy' WHERE id = ?").run(
      fakePid,
      agentId,
    );

    daemon.checkProcessHealth();

    const agentRow = db
      .prepare("SELECT process_pid, status FROM agents WHERE id = ?")
      .get(agentId) as { process_pid: number | null; status: string };
    expect(agentRow.process_pid).toBeNull();
    expect(agentRow.status).toBe("idle");
  });

  it("does NOT fail a task off the shared template row (parallel-task safety)", () => {
    // Task-fail authority moved to checkInstanceProcessHealth (per-instance) so
    // two parallel tasks sharing a template can't clobber each other via the
    // single-valued agents.current_task_id. checkProcessHealth now only does
    // template-row process hygiene.
    const agentId = createAgent("Dead Agent With Task");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);

    db.prepare("UPDATE agents SET process_pid = 99999999, current_task_id = ? WHERE id = ?").run(
      taskId,
      agentId,
    );

    daemon.checkProcessHealth();

    expect(scheduler.getTask(taskId)?.status).toBe("running");
    const agentRow = db.prepare("SELECT process_pid FROM agents WHERE id = ?").get(agentId) as { process_pid: number | null };
    expect(agentRow.process_pid).toBeNull(); // orphan cleanup still runs
  });

  it("fails running task when the entrypoint instance PID is dead (no active delegation)", () => {
    const agentId = createAgent("Dead Agent With Task");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);

    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, parent_instance_id, status, process_pid, attempt)
       VALUES (?, ?, ?, NULL, 'running', 99999999, 1)`,
    ).run(crypto.randomUUID(), taskId, agentId);

    daemon.getHealthMonitor().checkInstanceProcessHealth();

    expect(scheduler.getTask(taskId)?.status).toBe("failed");
  });

  it("does not fail task when dead agent has an active child delegation", async () => {
    const workerId = createAgent("Worker Agent");
    const childId = createAgent("Child Agent");
    const teamId = createTeamWithEntrypoint(workerId);
    addAgentToTeam(teamId, childId);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    // Set up a running delegation where childId is the child
    const delegId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO delegations (id, parent_agent_id, child_agent_id, task_id, prompt, status)
       VALUES (?, ?, ?, ?, 'do work', 'running')`,
    ).run(delegId, "skipper", childId, taskId);

    // Simulate childId having a dead PID (not tracked in memory, non-existent OS process)
    db.prepare("UPDATE agents SET process_pid = 99999999, current_task_id = ? WHERE id = ?").run(
      taskId,
      childId,
    );

    daemon.checkProcessHealth();

    // Task should NOT be failed because the child has an active delegation
    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");
  });

  it("skips agents that are currently being respawned", async () => {
    const agentId = createAgent("Respawning Agent");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    // Manually mark as respawning in agentManager (via private field access)
    const am = daemon.getAgentManager();
    expect(am.isRespawning(agentId)).toBe(false);

    // We can't easily test the full respawn path without real processes,
    // but we can verify that isRespawning() returns false for normal agents.
    daemon.checkProcessHealth();

    // Task should still be running (agent was running, so process is alive)
    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");
  });
});

describe("runStuckDetection (via tick)", () => {
  it("tick includes stuck detection without errors", async () => {
    // Just verify tick() doesn't throw when stuck detection runs
    const agentId = createAgent("Running Agent");
    const teamId = createTeamWithEntrypoint(agentId);
    createApprovedTask(teamId);
    await daemon.processTaskQueue();

    await daemon.tick();

    const runs = db
      .prepare("SELECT errors FROM manager_runs ORDER BY id DESC LIMIT 1")
      .get() as { errors: string | null };
    const errors: string[] = runs.errors ? JSON.parse(runs.errors) : [];
    expect(errors.filter((e) => e.includes("stuck") || e.includes("StateTracker"))).toHaveLength(0);
  });

  it("getStateTracker returns StateTracker instance", () => {
    const { StateTracker } = require("./state-tracker");
    expect(daemon.getStateTracker()).toBeInstanceOf(StateTracker);
  });
});

// --- STORY-018: Recovery & Resilience Tests ---

describe("orchestration state persistence", () => {
  it("persists orchestration state when task starts", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    const state = daemon.getOrchestrationState(taskId);
    expect(state).not.toBeNull();
    expect(state!.step).toBe("AGENT_RUNNING");
    expect(state!.last_checkpoint_ts).toBeTruthy();
    expect(state!.active_delegation_group_id).toBeNull();
  });

  it("writes PHASE_START checkpoint when task starts", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    const checkpoint = daemon.getLatestCheckpoint(taskId);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.checkpoint_type).toBe("PHASE_START");
    expect(checkpoint!.sequence).toBe(1);
    expect((checkpoint!.context_snapshot as Record<string, unknown>).phase).toBe(0);
  });

  it("updates orchestration state on delegation", async () => {
    const workerId = createAgent("Worker", "test-echo", "Lead dev");
    const childId = createAgent("Child", "test-echo", "Reviewer");
    const teamId = createTeamWithEntrypoint(workerId);
    addAgentToTeam(teamId, childId);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    await daemon.handleDelegation("skipper", childId, "Review the code");

    const state = daemon.getOrchestrationState(taskId);
    expect(state).not.toBeNull();
    expect(state!.step).toBe("WAITING_DELEGATION");
    expect(state!.active_delegation_group_id).toBeTruthy();
  });

  it("writes DELEGATION_COMPLETE checkpoint on delegation completion", async () => {
    const workerId = createAgent("Worker", "test-echo", "Lead");
    const childId = createAgent("Child", "test-echo", "Worker");
    const teamId = createTeamWithEntrypoint(workerId);
    addAgentToTeam(teamId, childId);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    await daemon.handleDelegation("skipper", childId, "Do work");
    daemon.handleDelegateComplete(childId, "Done");

    // Find DELEGATION_COMPLETE checkpoint
    const checkpoints = db
      .prepare("SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY sequence")
      .all(taskId) as { checkpoint_type: string; context_snapshot: string }[];

    const delCheckpoint = checkpoints.find((c) => c.checkpoint_type === "DELEGATION_COMPLETE");
    expect(delCheckpoint).toBeDefined();

    const state = daemon.getOrchestrationState(taskId);
    expect(state!.step).toBe("AGENT_RUNNING");
    expect(state!.active_delegation_group_id).toBeNull();
  });

  it("writes REGRESSION checkpoint on phase regression", async () => {
    const phases = [
      { name: "Planning", prompt: "Plan" },
      { name: "Implementation", prompt: "Implement" },
    ];
    const { agentId, taskId } = await setupRunningTask(phases);
    db.prepare("UPDATE tasks SET current_phase = 1 WHERE id = ?").run(taskId);

    daemon.handlePhaseRegression(agentId, 1, "Bugs found");

    const checkpoints = db
      .prepare("SELECT * FROM task_checkpoints WHERE task_id = ? AND checkpoint_type = 'REGRESSION'")
      .all(taskId) as { context_snapshot: string }[];
    expect(checkpoints.length).toBe(1);

    const snapshot = JSON.parse(checkpoints[0].context_snapshot);
    expect(snapshot.from_phase).toBe(1);
    expect(snapshot.to_phase).toBe(0);
    expect(snapshot.reason).toBe("Bugs found");
  });
});

describe("persistCheckpoints (tick)", () => {
  it("persists orchestration state on each tick for running task", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    // Tick to trigger persistCheckpoints
    await daemon.tick();

    const state = daemon.getOrchestrationState(taskId);
    expect(state).not.toBeNull();
    expect(state!.step).toBe("AGENT_RUNNING");
    expect(state!.last_checkpoint_ts).toBeTruthy();
  });
});

describe("cleanupStaleState", () => {
  it("clears PIDs for agents not tracked in memory", () => {
    const agentId = createAgent("Stale Agent", "test-echo");
    // Simulate stale PID in DB (no actual process)
    db.prepare("UPDATE agents SET process_pid = 999999, status = 'busy' WHERE id = ?").run(agentId);

    daemon.cleanupStaleState();

    const row = db.prepare("SELECT process_pid, status FROM agents WHERE id = ?").get(agentId) as {
      process_pid: number | null;
      status: string;
    };
    expect(row.process_pid).toBeNull();
    expect(row.status).toBe("idle");
  });

  it("preserves task assignments for recovery (does not clear them)", () => {
    const agentId = createAgent("Dead Agent", "test-echo");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);

    // Simulate agent assigned to task but no process
    db.prepare("UPDATE agents SET current_task_id = ?, process_pid = NULL WHERE id = ?").run(
      taskId,
      agentId,
    );

    daemon.cleanupStaleState();

    // Task assignment should be preserved so recoverAllStaleTasks can find and recover it
    const row = db.prepare("SELECT current_task_id FROM agents WHERE id = ?").get(agentId) as {
      current_task_id: string | null;
    };
    expect(row.current_task_id).toBe(taskId);
  });

  it("is called on daemon start", async () => {
    const agentId = createAgent("Stale Agent", "test-echo");
    db.prepare("UPDATE agents SET process_pid = 999999, status = 'busy' WHERE id = ?").run(agentId);

    await daemon.start();

    const row = db.prepare("SELECT process_pid FROM agents WHERE id = ?").get(agentId) as {
      process_pid: number | null;
    };
    expect(row.process_pid).toBeNull();
  });
  it("recovers running tasks during start instead of destroying them", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    // Start task normally, then simulate crash
    await daemon.processTaskQueue();
    daemon.getAgentManager().killAgent("skipper");
    daemon.getAgentManager().getRunningAgents().delete("skipper");
    db.prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = 'skipper'").run();
    daemon.stop();

    // Create a fresh daemon (simulates restart)
    const daemon2 = new ManagerDaemon(db);
    await daemon2.start();

    // Task should still be running (recovered, not failed)
    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");

    // Skipper should have task assigned
    const agentRow = db.prepare("SELECT current_task_id FROM agents WHERE id = ?").get("skipper") as {
      current_task_id: string | null;
    };
    expect(agentRow.current_task_id).toBe(taskId);

    daemon2.stop();
    // Kill recovered agent
    try { daemon2.getAgentManager().killAgent("skipper"); } catch { }
    daemon2.getAgentManager().getRunningAgents().clear();
  });
});

describe("recoverTask", () => {
  it("recovers a running task with no live agent", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    // Start the task normally
    await daemon.processTaskQueue();

    // Kill Skipper (the entrypoint) to simulate crash
    daemon.getAgentManager().killAgent("skipper");
    daemon.getAgentManager().getRunningAgents().delete("skipper");
    db.prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = 'skipper'").run();

    // Recover the task
    const recovered = await daemon.recoverTask(taskId);
    expect(recovered).toBe(true);

    // Skipper should be running again with task assigned
    const agentRow = db.prepare("SELECT current_task_id FROM agents WHERE id = ?").get("skipper") as {
      current_task_id: string | null;
    };
    expect(agentRow.current_task_id).toBe(taskId);

    // Task should still be running
    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");
  });

  it("restores in-memory phase guards from orchestration state", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const phases = [
      { name: "P1", prompt: "Phase 1" },
      { name: "P2", prompt: "Phase 2" },
      { name: "P3", prompt: "Phase 3" },
    ];
    const teamId = createTeamWithEntrypoint(agentId, phases);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    // Simulate phase 0 completed
    daemon.getPhaseCompleteHandled().add(`${taskId}:0`);
    db.prepare("UPDATE tasks SET current_phase = 1 WHERE id = ?").run(taskId);

    // Persist state via tick
    await daemon.tick();

    // Clear in-memory state to simulate restart
    daemon.getPhaseCompleteHandled().clear();

    // Kill Skipper
    daemon.getAgentManager().killAgent("skipper");
    daemon.getAgentManager().getRunningAgents().delete("skipper");
    db.prepare("UPDATE agents SET process_pid = NULL WHERE id = 'skipper'").run();

    await daemon.recoverTask(taskId);

    // Phase guard should be restored
    expect(daemon.getPhaseCompleteHandled().has(`${taskId}:0`)).toBe(true);
  });

  it("returns false for non-running task", async () => {
    const agentId = createAgent("Dev Agent", "test-echo");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    const recovered = await daemon.recoverTask(taskId);
    expect(recovered).toBe(false);
  });

  it("returns false for task with no team", async () => {
    const taskId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO tasks (id, title, status, started_at) VALUES (?, 'Orphan', 'running', datetime('now'))",
    ).run(taskId);

    const recovered = await daemon.recoverTask(taskId);
    expect(recovered).toBe(false);
  });

  it("skips respawn if active delegation exists", async () => {
    const workerId = createAgent("Worker", "test-echo", "Lead");
    const childId = createAgent("Child", "test-echo", "Worker");
    const teamId = createTeamWithEntrypoint(workerId);
    addAgentToTeam(teamId, childId);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    const delegation = await daemon.handleDelegation("skipper", childId, "Do work");
    expect(delegation).not.toBeNull();

    // Simulate Skipper crash but child still alive
    db.prepare("UPDATE agents SET process_pid = NULL WHERE id = 'skipper'").run();

    // Set orchestration state with active delegation
    daemon.updateOrchestrationState(taskId, {
      step: "WAITING_DELEGATION",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: null,
      active_delegation_group_id: delegation!.delegation_group_id ?? null,
      active_delegation_child_count: 1,
      active_delegation_settled_count: 0,
      phase_guards: [],
      pending_regression: null,
      checkpoint_prompt_hash: null,
    });

    const recovered = await daemon.recoverTask(taskId);
    expect(recovered).toBe(true);

    // Skipper should be in waiting_delegation state, not respawned with task prompt
    const parentState = db
      .prepare("SELECT state FROM agent_states WHERE agent_id = ?")
      .get("skipper") as { state: string } | null;
    expect(parentState?.state).toBe("waiting_delegation");
  });

  it("fails second recovery without progress (one-shot exhausted)", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    // Simulate crash and first recovery
    daemon.getAgentManager().killAgent("skipper");
    daemon.getAgentManager().getRunningAgents().delete("skipper");
    db.prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = 'skipper'").run();
    const first = await daemon.recoverTask(taskId);
    expect(first).toBe(true);

    // Crash again without phase/checkpoint progress
    daemon.getAgentManager().killAgent("skipper");
    daemon.getAgentManager().getRunningAgents().delete("skipper");
    db.prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = 'skipper'").run();
    const second = await daemon.recoverTask(taskId);
    expect(second).toBe(false);

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("failed");
  });

  it("allows second recovery when progress occurred since prior recovery", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const phases = [
      { name: "P1", prompt: "Phase 1" },
      { name: "P2", prompt: "Phase 2" },
    ];
    const teamId = createTeamWithEntrypoint(agentId, phases);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    // First crash + recovery
    daemon.getAgentManager().killAgent("skipper");
    daemon.getAgentManager().getRunningAgents().delete("skipper");
    db.prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = 'skipper'").run();
    const first = await daemon.recoverTask(taskId);
    expect(first).toBe(true);

    // Simulate forward progress before next crash
    db.prepare("UPDATE tasks SET current_phase = 1 WHERE id = ?").run(taskId);
    daemon.writeCheckpoint(taskId, "PHASE_START", { phase: 1 });

    // Crash again
    const skipperRuntime2 = daemon.getAgentManager().getRunningAgent("skipper");
    const skipperRuntimeId2 = skipperRuntime2?.id ?? "skipper";
    daemon.getAgentManager().killAgent(skipperRuntimeId2);
    daemon.getAgentManager().getRunningAgents().delete(skipperRuntimeId2);
    db.prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = 'skipper'").run();
    const second = await daemon.recoverTask(taskId);
    expect(second).toBe(true);

    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");
  });
});

describe("recoverAllStaleTasks", () => {
  it("recovers tasks with dead agents", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    // Kill Skipper without proper cleanup — get UUID runtime ID first
    const skipperRuntime = daemon.getAgentManager().getRunningAgent("skipper");
    const skipperRuntimeId = skipperRuntime?.id ?? "skipper";
    daemon.getAgentManager().killAgent(skipperRuntimeId);
    daemon.getAgentManager().getRunningAgents().delete(skipperRuntimeId);
    db.prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = 'skipper'").run();

    // Pre-seed the orphan recovery grace period so the second call recovers immediately
    // First call starts the grace timer and returns 0
    const first = await daemon.recoverAllStaleTasks();
    expect(first).toBe(0);

    // Backdate the grace entry so it's past the 15s window
    db.prepare("UPDATE daemon_state SET value = ? WHERE key = ?")
      .run(String(Date.now() - 20_000), `orphan_recovery_seen:${taskId}`);

    const recovered = await daemon.recoverAllStaleTasks();
    expect(recovered).toBe(1);
  });

  it("skips tasks with live agents", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    await daemon.processTaskQueue();

    // Agent is still running — should not recover
    const recovered = await daemon.recoverAllStaleTasks();
    expect(recovered).toBe(0);
  });

  it("returns 0 when no running tasks exist", async () => {
    const recovered = await daemon.recoverAllStaleTasks();
    expect(recovered).toBe(0);
  });
});

describe("writeCheckpoint and getLatestCheckpoint", () => {
  it("writes and retrieves checkpoints", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    // Write additional checkpoint
    daemon.writeCheckpoint(taskId, "NOTE_ADDED", { note: "test note" });

    const checkpoint = daemon.getLatestCheckpoint(taskId);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.checkpoint_type).toBe("NOTE_ADDED");
    expect(checkpoint!.sequence).toBe(2); // 1 from PHASE_START, 2 from this
    expect((checkpoint!.context_snapshot as Record<string, unknown>).note).toBe("test note");
  });

  it("returns null for task with no checkpoints", () => {
    const checkpoint = daemon.getLatestCheckpoint("nonexistent");
    expect(checkpoint).toBeNull();
  });

  it("increments sequence numbers", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);
    await daemon.processTaskQueue();

    daemon.writeCheckpoint(taskId, "NOTE_ADDED", { n: 1 });
    daemon.writeCheckpoint(taskId, "NOTE_ADDED", { n: 2 });

    const checkpoints = db
      .prepare("SELECT sequence FROM task_checkpoints WHERE task_id = ? ORDER BY sequence")
      .all(taskId) as { sequence: number }[];
    expect(checkpoints.length).toBe(3); // PHASE_START + 2 notes
    expect(checkpoints[0].sequence).toBe(1);
    expect(checkpoints[1].sequence).toBe(2);
    expect(checkpoints[2].sequence).toBe(3);
  });
});

describe("tick with recovery loop", () => {
  it("runs full tick cycle: recover → process → delegations → checkpoints", async () => {
    // Just verify the full tick runs without error and records run
    await daemon.tick();

    const runs = db
      .prepare("SELECT * FROM manager_runs")
      .all() as { completed_at: string; errors: string }[];
    expect(runs.length).toBe(1);
    expect(runs[0].completed_at).toBeTruthy();
    const errors = JSON.parse(runs[0].errors);
    expect(errors.length).toBe(0);
  });

  it("recovers stale task during tick", async () => {
    const agentId = createAgent("Dev Agent", "test-echo", "Build software");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    // Start task
    await daemon.processTaskQueue();

    // Kill Skipper to create stale state
    daemon.getAgentManager().killAgent("skipper");
    daemon.getAgentManager().getRunningAgents().delete("skipper");
    db.prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = 'skipper'").run();

    // Tick should recover
    await daemon.tick();

    // Task should still be running (recovered, not failed)
    const task = scheduler.getTask(taskId);
    expect(task?.status).toBe("running");

    // Skipper should have been respawned
    const agentRow = db.prepare("SELECT current_task_id FROM agents WHERE id = ?").get("skipper") as {
      current_task_id: string | null;
    };
    expect(agentRow.current_task_id).toBe(taskId);
  });
});
