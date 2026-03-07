import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { ManagerDaemon } from "../agents/manager-daemon";
import { TaskScheduler } from "../tasks/scheduler";
import { clearAgentTypeCache } from "../agents/types";
import { eventBus } from "../events/bus";
import { unlinkSync } from "fs";

const TEST_DB = "test-hardening.db";

let db: Database;
let daemon: ManagerDaemon;
let scheduler: TaskScheduler;

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

function createAgent(name: string, type = "test-echo"): string {
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO agents (id, name, type, config, capabilities) VALUES (?, ?, ?, '{}', '[]')",
  ).run(id, name, type);
  return id;
}

function createTeamWithEntrypoint(agentId: string, phases: { name: string; prompt: string }[] = []): string {
  const teamId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO teams (id, name, entrypoint_agent_id, phases) VALUES (?, ?, 'skipper', ?)",
  ).run(teamId, "Test Team", JSON.stringify(phases));

  const skipperTaId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES (?, ?, 'skipper', 'lead', 0)",
  ).run(skipperTaId, teamId);

  if (agentId !== "skipper") {
    const taId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES (?, ?, ?, 'worker', 1)",
    ).run(taId, teamId, agentId);
  }

  return teamId;
}

function createRunningTask(teamId: string, title = "Test Task"): string {
  const taskId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, title, team_id, status, priority, started_at)
     VALUES (?, ?, ?, 'running', 5, datetime('now'))`,
  ).run(taskId, title, teamId);
  return taskId;
}

function createApprovedTask(teamId: string, title = "Test Task"): string {
  const taskId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, title, team_id, status, priority, approved_at)
     VALUES (?, ?, ?, 'approved', 5, datetime('now'))`,
  ).run(taskId, title, teamId);
  return taskId;
}

beforeEach(() => {
  clearAgentTypeCache();
  db = new Database(TEST_DB);
  initializeDatabase(db);
  setupAgentType();
  daemon = new ManagerDaemon(db);
  scheduler = daemon.getTaskScheduler();
});

afterEach(() => {
  daemon.stop();
  daemon.getAgentManager().close();
  eventBus.removeAllListeners();
  db.close();
  try { unlinkSync(TEST_DB); } catch { /* ok */ }
  try { unlinkSync(TEST_DB + "-shm"); } catch { /* ok */ }
  try { unlinkSync(TEST_DB + "-wal"); } catch { /* ok */ }
});

describe("State machine invariant tests", () => {
  it("should not allow completing a non-running task", () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    expect(() => scheduler.completeTask(taskId)).toThrow("Can only complete running tasks");
  });

  it("should not allow failing a non-running task", () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    expect(() => scheduler.failTask(taskId, "test")).toThrow("Can only fail running tasks");
  });

  it("should not allow starting a non-approved task", () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO tasks (id, title, team_id, status, priority) VALUES (?, ?, ?, 'draft', 5)",
    ).run(taskId, "Draft Task", teamId);

    expect(() => scheduler.startTask(taskId)).toThrow("Can only start approved tasks");
  });

  it("should not allow retrying a non-failed task", () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createApprovedTask(teamId);

    expect(() => scheduler.retryTask(taskId)).toThrow("Can only retry failed tasks");
  });

  it("should allow a task to reach completed from running", () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);

    const completed = scheduler.completeTask(taskId);
    expect(completed.status).toBe("completed");
  });

  it("should allow a task to reach failed from running", () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);

    const failed = scheduler.failTask(taskId, "test error");
    expect(failed.status).toBe("failed");
  });

  it("should clear agent assignments when task completes", () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);

    // Assign agent to task
    db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskId, agentId);

    scheduler.completeTask(taskId);

    const agent = db.prepare("SELECT current_task_id FROM agents WHERE id = ?").get(agentId) as { current_task_id: string | null };
    expect(agent.current_task_id).toBeNull();
  });

  it("should clear agent assignments when task fails", () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);

    db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskId, agentId);

    scheduler.failTask(taskId, "test error");

    const agent = db.prepare("SELECT current_task_id FROM agents WHERE id = ?").get(agentId) as { current_task_id: string | null };
    expect(agent.current_task_id).toBeNull();
  });
});

describe("Tick loop transition guard", () => {
  it("should track transitions per tick", () => {
    const loop = daemon.getReconciliationLoop();
    const taskId = "test-task-id";

    expect(loop.hasTransitionedThisTick(taskId)).toBe(false);
    loop.recordTransitionThisTick(taskId);
    expect(loop.hasTransitionedThisTick(taskId)).toBe(true);
  });
});

describe("Health monitor — instance process health", () => {
  it("should mark instances with dead PIDs as failed", () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);
    const instanceId = crypto.randomUUID();

    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, status, process_pid, attempt)
       VALUES (?, ?, ?, 'running', 999999, 1)`,
    ).run(instanceId, taskId, agentId);

    daemon.getHealthMonitor().checkInstanceProcessHealth();

    const inst = db.prepare("SELECT status, process_pid FROM agent_instances WHERE id = ?").get(instanceId) as { status: string; process_pid: number | null };
    expect(inst.status).toBe("failed");
    expect(inst.process_pid).toBeNull();
  });
});

describe("Health monitor — delegation orphan detection", () => {
  it("should fail waiting instances with no live children", () => {
    const agentId = createAgent("worker");
    const childId = createAgent("child");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);
    const parentInstanceId = crypto.randomUUID();
    const childInstanceId = crypto.randomUUID();

    // Create parent in waiting_delegation
    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, status, attempt)
       VALUES (?, ?, ?, 'waiting_delegation', 1)`,
    ).run(parentInstanceId, taskId, agentId);

    // Create a delegation with a child that has no live runtime
    const delegationId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO delegation_groups (id, task_id, parent_instance_id, expected_count, settled_count, failed_count, status)
       VALUES (?, ?, ?, 1, 0, 0, 'running')`,
    ).run(groupId, taskId, parentInstanceId);
    db.prepare(
      `INSERT INTO delegations (id, parent_agent_id, child_agent_id, parent_instance_id, child_instance_id, delegation_group_id, task_id, prompt, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'test prompt', 'running')`,
    ).run(delegationId, agentId, childId, parentInstanceId, childInstanceId, groupId, taskId);

    daemon.getHealthMonitor().checkDelegationOrphans();

    const inst = db.prepare("SELECT status FROM agent_instances WHERE id = ?").get(parentInstanceId) as { status: string };
    expect(inst.status).toBe("failed");

    const del = db.prepare("SELECT status FROM delegations WHERE id = ?").get(delegationId) as { status: string };
    expect(del.status).toBe("failed");

    const group = db.prepare("SELECT status FROM delegation_groups WHERE id = ?").get(groupId) as { status: string };
    expect(group.status).toBe("completed");
  });

  it("should fail waiting instances with zero delegation records", () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);
    const instanceId = crypto.randomUUID();

    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, status, attempt)
       VALUES (?, ?, ?, 'waiting_delegation', 1)`,
    ).run(instanceId, taskId, agentId);

    daemon.getHealthMonitor().checkDelegationOrphans();

    const inst = db.prepare("SELECT status FROM agent_instances WHERE id = ?").get(instanceId) as { status: string };
    expect(inst.status).toBe("failed");
  });
});

describe("Health monitor — orphaned task detection", () => {
  it("should emit remediation event for running task with no live runtime", () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);

    daemon.getHealthMonitor().checkOrphanedTasks();

    const events = db.prepare(
      "SELECT * FROM events WHERE task_id = ? AND type LIKE 'remediation:%'",
    ).all(taskId) as Array<{ type: string }>;
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe("remediation:orphaned_task");
  });
});

describe("Health monitor — exit code cluster detection", () => {
  it("should create incident event after 3 non-zero exits in 5 minutes", () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);
    db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskId, agentId);

    const monitor = daemon.getHealthMonitor();
    monitor.trackExitCode(agentId, 137);
    monitor.trackExitCode(agentId, 137);
    monitor.trackExitCode(agentId, 137);

    const incidents = db.prepare(
      "SELECT * FROM events WHERE type = 'incident:exit_code_cluster'",
    ).all() as Array<{ type: string; payload: string }>;
    expect(incidents.length).toBe(1);

    const payload = JSON.parse(incidents[0].payload);
    expect(payload.code).toBe(137);
    expect(payload.count).toBe(3);
  });

  it("should not trigger incident for exit code 0", () => {
    const agentId = createAgent("worker");
    const monitor = daemon.getHealthMonitor();

    monitor.trackExitCode(agentId, 0);
    monitor.trackExitCode(agentId, 0);
    monitor.trackExitCode(agentId, 0);

    const incidents = db.prepare(
      "SELECT * FROM events WHERE type = 'incident:exit_code_cluster'",
    ).all();
    expect(incidents.length).toBe(0);
  });
});

describe("Health monitor — why stuck diagnostic", () => {
  it("should return diagnostic for a running task", () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);

    const diagnostic = daemon.getHealthMonitor().generateWhyStuckDiagnostic(taskId);
    expect(diagnostic).not.toBeNull();
    expect(diagnostic!.taskId).toBe(taskId);
    expect(diagnostic!.taskStatus).toBe("running");
    expect(diagnostic!.likely_reasons.length).toBeGreaterThan(0);
  });

  it("should return null for non-existent task", () => {
    const diagnostic = daemon.getHealthMonitor().generateWhyStuckDiagnostic("nonexistent");
    expect(diagnostic).toBeNull();
  });
});

describe("Recovery manager — one-shot recovery policy", () => {
  it("should record recovery attempt in daemon_state", async () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);

    // First recovery attempt — will fail to spawn but records the attempt
    await daemon.getRecoveryManager().recoverTask(taskId);

    const row = db.prepare("SELECT value FROM daemon_state WHERE key = ?").get(`recovery_attempt:${taskId}`) as { value: string } | null;
    expect(row).not.toBeNull();
  });
});

describe("Recovery manager — terminal task cleanup", () => {
  it("should clean up agent assignments on terminal state", () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);

    // Set up stale state
    db.prepare("UPDATE agents SET current_task_id = ?, process_pid = 999999 WHERE id = ?").run(taskId, agentId);
    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, status, attempt)
       VALUES (?, ?, ?, 'running', 1)`,
    ).run(crypto.randomUUID(), taskId, agentId);

    daemon.getRecoveryManager().cleanupTerminalTaskState(taskId);

    const agent = db.prepare("SELECT current_task_id, process_pid FROM agents WHERE id = ?").get(agentId) as { current_task_id: string | null; process_pid: number | null };
    expect(agent.current_task_id).toBeNull();
    expect(agent.process_pid).toBeNull();

    const instances = db.prepare(
      "SELECT status FROM agent_instances WHERE task_id = ? AND status IN ('running', 'waiting_delegation')",
    ).all(taskId);
    expect(instances.length).toBe(0);
  });
});

describe("Delegation manager — stale delegation groups", () => {
  it("should complete groups older than timeout", () => {
    const agentId = createAgent("worker");
    const childId = createAgent("child");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);
    const parentInstanceId = crypto.randomUUID();
    const groupId = crypto.randomUUID();

    // Create instance for parent
    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, status, attempt)
       VALUES (?, ?, ?, 'waiting_delegation', 1)`,
    ).run(parentInstanceId, taskId, agentId);

    // Create a stale group (created 20 minutes ago)
    db.prepare(
      `INSERT INTO delegation_groups (id, task_id, parent_instance_id, expected_count, settled_count, failed_count, status, created_at)
       VALUES (?, ?, ?, 1, 0, 0, 'running', datetime('now', '-20 minutes'))`,
    ).run(groupId, taskId, parentInstanceId);

    const delegationId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO delegations (id, parent_agent_id, child_agent_id, parent_instance_id, delegation_group_id, task_id, prompt, status)
       VALUES (?, ?, ?, ?, ?, ?, 'test', 'running')`,
    ).run(delegationId, agentId, childId, parentInstanceId, groupId, taskId);

    daemon.getDelegationManager().checkStaleDelegationGroups();

    const group = db.prepare("SELECT status FROM delegation_groups WHERE id = ?").get(groupId) as { status: string };
    expect(group.status).toBe("completed");
  });
});

describe("Delegation manager — target validation", () => {
  it("should log event for ambiguous target name", () => {
    createAgent("Duplicate Name");
    createAgent("Duplicate Name");

    const delegationManager = daemon.getDelegationManager();
    const result = delegationManager.resolveDelegationTarget("Duplicate Name");
    expect(result).toBeNull();

    const events = db.prepare(
      "SELECT * FROM events WHERE type = 'delegation:ambiguous_target'",
    ).all() as Array<{ type: string; payload: string }>;
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0].payload);
    expect(payload.target).toBe("Duplicate Name");
    expect(payload.matches.length).toBe(2);
  });

  it("should log event for target not found", () => {
    const delegationManager = daemon.getDelegationManager();
    const result = delegationManager.resolveDelegationTarget("nonexistent-agent");
    expect(result).toBeNull();

    const events = db.prepare(
      "SELECT * FROM events WHERE type = 'delegation:target_not_found'",
    ).all() as Array<{ type: string; payload: string }>;
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0].payload);
    expect(payload.target).toBe("nonexistent-agent");
  });
});

describe("Task scheduler — agent cleanup on terminal states", () => {
  it("should clear agents.current_task_id in completeTask", () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);

    db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskId, agentId);

    scheduler.completeTask(taskId);

    const row = db.prepare("SELECT current_task_id FROM agents WHERE id = ?").get(agentId) as { current_task_id: string | null };
    expect(row.current_task_id).toBeNull();
  });

  it("should clear agents.current_task_id in failTask", () => {
    const agentId = createAgent("worker");
    const teamId = createTeamWithEntrypoint(agentId);
    const taskId = createRunningTask(teamId);

    db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskId, agentId);

    scheduler.failTask(taskId, "test error");

    const row = db.prepare("SELECT current_task_id FROM agents WHERE id = ?").get(agentId) as { current_task_id: string | null };
    expect(row.current_task_id).toBeNull();
  });
});
