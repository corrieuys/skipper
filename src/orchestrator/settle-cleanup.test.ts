import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "fs";
import { initializeDatabase } from "../db/connection";
import { ManagerDaemon } from "../agents/manager-daemon";
import { clearAgentTypeCache } from "../agents/types";
import { eventBus, type InstanceStateChangedEvent } from "../events/bus";
import type { TaskScheduler } from "../tasks/scheduler";

// Settling a task must stop its agents on every path, not only where a route
// kills them first (web Complete/Cancel). The settle transaction flips the
// instance rows to completed/failed before the daemon's settled handler runs
// RecoveryManager.cleanupTerminalTaskState, so the cleanup has to find the live
// processes through the in-memory runtimes. Real processes, real daemon.

const TEST_DB = "test-settle-cleanup.db";

let db: Database;
let daemon: ManagerDaemon;
let scheduler: TaskScheduler;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

/** handleAgentExit logged that it bailed on this runtime's exit because the task is settled. */
function exitBailedOnSettledTask(runtimeId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM error_log WHERE category = 'agent_exit_bail'
         AND json_extract(context, '$.agentId') = ? AND json_extract(context, '$.reason') = 'task_status_settled'`,
    )
    .get(runtimeId);
}

function createApprovedTask(): string {
  const taskId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, title, team_id, status, approved_at, wake_requested_at)
     VALUES (?, 'Settle me', 'team-1', 'active', datetime('now'), datetime('now'))`,
  ).run(taskId);
  return taskId;
}

/** Start the task's root through the queue, then give it a running delegated child. */
async function startTaskWithChild(): Promise<{ taskId: string; rootId: string; childId: string; rootPid: number; childPid: number }> {
  const taskId = createApprovedTask();
  const agentManager = daemon.getAgentManager();
  const started = await daemon.processTaskQueue();
  expect(started.processed).toBe(1);
  const root = [...agentManager.getRunningAgents().values()].find((r) => r.taskId === taskId);
  expect(root).toBeTruthy();

  const childId = crypto.randomUUID();
  const child = await agentManager.spawnAgentInstance("worker", childId, {
    workingDir: process.cwd(),
    taskId,
    parentInstanceId: root!.id,
    rootInstanceId: root!.id,
  });
  db.prepare(
    `INSERT INTO delegations (id, parent_agent_id, child_agent_id, parent_instance_id, child_instance_id, task_id, prompt, status)
     VALUES (?, 'skipper', 'worker', ?, ?, ?, 'do work', 'running')`,
  ).run(crypto.randomUUID(), root!.id, childId, taskId);

  const rootPid = root!.process.pid!;
  const childPid = child.process.pid!;
  expect(isAlive(rootPid)).toBe(true);
  expect(isAlive(childPid)).toBe(true);
  return { taskId, rootId: root!.id, childId, rootPid, childPid };
}

function countRunFailed(taskId: string): () => number {
  let count = 0;
  eventBus.on("task:run_failed", (e) => {
    if (e.taskId === taskId) count++;
  });
  return () => count;
}

beforeEach(() => {
  clearAgentTypeCache();
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  // A stand-in CLI that keeps running until something stops it.
  db.prepare(
    `INSERT OR IGNORE INTO agent_types (name, command, args, supports_stdin, supports_resume)
     VALUES ('test-sleep', 'bash', '["-c", "sleep 30"]', 0, 0)`,
  ).run();
  db.prepare("INSERT OR IGNORE INTO agents (id, name, type, model) VALUES ('skipper', 'Skipper', 'test-sleep', 'default')").run();
  db.prepare("UPDATE agents SET type = 'test-sleep' WHERE id = 'skipper'").run();
  db.prepare("INSERT INTO agents (id, name, type, config, capabilities) VALUES ('worker', 'Worker', 'test-sleep', '{}', '[]')").run();
  db.prepare("INSERT INTO teams (id, name, entrypoint_agent_id, phases) VALUES ('team-1', 'Team', 'skipper', '[]')").run();
  db.prepare("INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES ('ta-lead', 'team-1', 'skipper', 'lead', 0)").run();
  db.prepare("INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES ('ta-worker', 'team-1', 'worker', 'worker', 1)").run();
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

describe("settling a task stops its agents (regression: settle paths left processes alive)", () => {
  it("cancel without a route kill first (MCP cancel_task) stops the root and its child, announces both, and their exits leave the task settled", async () => {
    const { taskId, rootId, childId, rootPid, childPid } = await startTaskWithChild();
    const announced: InstanceStateChangedEvent[] = [];
    eventBus.on("instance:state_changed", (e) => {
      if (e.taskId === taskId) announced.push(e);
    });
    const runFailed = countRunFailed(taskId);

    scheduler.settleTask(taskId, { error: "Cancelled by user" });

    // The settle announces both instances it closed at once.
    const closed = announced.filter((e) => e.status === "failed").map((e) => e.instanceId);
    expect(closed).toContain(rootId);
    expect(closed).toContain(childId);
    // Both process trees die.
    expect(await waitFor(() => !isAlive(rootPid) && !isAlive(childPid), 5_000)).toBe(true);
    // Their exits reach handleAgentExit, which leaves the settled task alone.
    expect(await waitFor(() => exitBailedOnSettledTask(rootId) && exitBailedOnSettledTask(childId), 10_000)).toBe(true);

    const task = scheduler.getTask(taskId)!;
    expect(task.status).toBe("settled");
    expect(task.result).toEqual({ error: "Cancelled by user" });
    expect(runFailed()).toBe(0);
    const rows = db
      .prepare("SELECT status, process_pid FROM agent_instances WHERE id IN (?, ?)")
      .all(rootId, childId) as Array<{ status: string; process_pid: number | null }>;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(["completed", "failed", "stopped"]).toContain(row.status);
      expect(row.process_pid).toBeNull();
    }
  }, 20_000);

  it("a root completing its own run (completeRun) is stopped with its still-running child, and neither exit reopens the task", async () => {
    const { taskId, rootId, childId, rootPid, childPid } = await startTaskWithChild();

    scheduler.completeRun(taskId);

    expect(await waitFor(() => !isAlive(rootPid) && !isAlive(childPid), 5_000)).toBe(true);
    expect(await waitFor(() => exitBailedOnSettledTask(rootId) && exitBailedOnSettledTask(childId), 10_000)).toBe(true);
    expect(scheduler.getTask(taskId)!.status).toBe("settled");
    // The stop's non-zero exit keeps the status the settle wrote.
    const rows = db
      .prepare("SELECT status FROM agent_instances WHERE id IN (?, ?)")
      .all(rootId, childId) as Array<{ status: string }>;
    expect(rows.map((r) => r.status)).toEqual(["completed", "completed"]);
  }, 25_000);

  it("a start whose prompt write fails stops the runtime it just spawned", async () => {
    const taskId = createApprovedTask();
    const agentManager = daemon.getAgentManager();
    let spawned = null as { runtimeId: string; pid: number } | null;
    eventBus.on("instance:state_changed", (e) => {
      if (e.taskId !== taskId || e.status !== "running" || spawned) return;
      const row = db.prepare("SELECT process_pid FROM agent_instances WHERE id = ?").get(e.instanceId) as { process_pid: number | null } | null;
      if (row?.process_pid) spawned = { runtimeId: e.instanceId, pid: row.process_pid };
    });
    const runFailed = countRunFailed(taskId);
    agentManager.sendInput = () => {
      throw new Error("EPIPE: broken pipe");
    };

    await daemon.processTaskQueue();

    expect(spawned).toBeTruthy();
    const { runtimeId, pid } = spawned!;
    const task = scheduler.getTask(taskId)!;
    expect(task.status).toBe("settled");
    expect((task.result as { error: string }).error).toContain("Failed to send initial prompt");
    expect(await waitFor(() => !isAlive(pid), 5_000)).toBe(true);
    expect(await waitFor(() => exitBailedOnSettledTask(runtimeId), 10_000)).toBe(true);
    expect(scheduler.getTask(taskId)!.status).toBe("settled");
    expect(runFailed()).toBe(1);
  }, 20_000);
});
