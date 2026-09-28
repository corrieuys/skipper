import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "fs";
import { initializeDatabase } from "../db/connection";
import { ManagerDaemon } from "../agents/manager-daemon";
import { clearAgentTypeCache } from "../agents/types";
import { eventBus } from "../events/bus";

// Delegation and delegation-group timeouts, on a real daemon. A timed-out
// member is retried by checkStaleDelegations and the group sweep runs right
// after it in the same tick (ReconciliationLoop.tick), so the sweep has to see
// the retry as a fresh attempt. A retry whose spawn fails must settle its
// delegation instead of leaving the parent parked until the group timeout.

const TEST_DB = "test-delegation-timeouts.db";

let db: Database;
let daemon: ManagerDaemon;

interface ResumeCall { id: string; message: string }

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

/** Record every parent resume instead of respawning anything. */
function recordResumes(): ResumeCall[] {
  const calls: ResumeCall[] = [];
  daemon.getAgentManager().sendResumeMessage = async (id: string, message: string) => {
    calls.push({ id, message });
  };
  return calls;
}

function seedTask(): { taskId: string; parentId: string } {
  const taskId = crypto.randomUUID();
  const parentId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO tasks (id, title, team_id, status, started_at) VALUES (?, 'Long work', 'team-1', 'active', datetime('now'))",
  ).run(taskId);
  // The root handed off and exited, as a CLI root does while its children work.
  db.prepare(
    `INSERT INTO agent_instances (id, task_id, template_agent_id, parent_instance_id, root_instance_id, status, attempt)
     VALUES (?, ?, 'skipper', NULL, ?, 'completed', 1)`,
  ).run(parentId, taskId, parentId);
  return { taskId, parentId };
}

/** A one-member group whose group, delegation and first attempt all started 70 minutes ago. */
function seedStaleMember(taskId: string, parentId: string): { groupId: string; delegationId: string; childId: string } {
  const groupId = crypto.randomUUID();
  const delegationId = crypto.randomUUID();
  const childId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO delegation_groups (id, task_id, parent_instance_id, expected_count, settled_count, failed_count, status, created_at)
     VALUES (?, ?, ?, 1, 0, 0, 'running', datetime('now', '-70 minutes'))`,
  ).run(groupId, taskId, parentId);
  db.prepare(
    `INSERT INTO agent_instances (id, task_id, template_agent_id, parent_instance_id, root_instance_id, status, attempt, created_at)
     VALUES (?, ?, 'worker', ?, ?, 'running', 1, datetime('now', '-70 minutes'))`,
  ).run(childId, taskId, parentId, parentId);
  db.prepare(
    `INSERT INTO delegations (id, parent_agent_id, child_agent_id, parent_instance_id, child_instance_id, delegation_group_id, task_id, prompt, status, created_at)
     VALUES (?, 'skipper', 'worker', ?, ?, ?, ?, 'long job', 'running', datetime('now', '-70 minutes'))`,
  ).run(delegationId, parentId, childId, groupId, taskId);
  return { groupId, delegationId, childId };
}

function delegationRow(id: string): { status: string; result: string | null; child_instance_id: string | null } {
  return db
    .prepare("SELECT status, result, child_instance_id FROM delegations WHERE id = ?")
    .get(id) as { status: string; result: string | null; child_instance_id: string | null };
}

function groupRow(id: string): { status: string; settled_count: number; failed_count: number } {
  return db
    .prepare("SELECT status, settled_count, failed_count FROM delegation_groups WHERE id = ?")
    .get(id) as { status: string; settled_count: number; failed_count: number };
}

beforeEach(() => {
  clearAgentTypeCache();
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  // A stand-in CLI that keeps running until something stops it.
  db.prepare(
    `INSERT OR IGNORE INTO agent_types (name, command, args, supports_stdin, supports_resume)
     VALUES ('test-sleep', 'bash', '["-c", "sleep 30"]', 0, 1)`,
  ).run();
  // A CLI that is not installed: Bun.spawn throws ENOENT for it.
  db.prepare(
    `INSERT OR IGNORE INTO agent_types (name, command, args, supports_stdin, supports_resume)
     VALUES ('test-missing', '/nonexistent/skipper-test-binary', '[]', 0, 1)`,
  ).run();
  db.prepare("INSERT OR IGNORE INTO agents (id, name, type, model) VALUES ('skipper', 'Skipper', 'test-sleep', 'default')").run();
  db.prepare("UPDATE agents SET type = 'test-sleep' WHERE id = 'skipper'").run();
  db.prepare("INSERT INTO agents (id, name, type, config, capabilities) VALUES ('worker', 'Worker', 'test-sleep', '{}', '[]')").run();
  db.prepare("INSERT INTO teams (id, name, entrypoint_agent_id, phases) VALUES ('team-1', 'Team', 'skipper', '[]')").run();
  db.prepare("INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES ('ta-lead', 'team-1', 'skipper', 'lead', 0)").run();
  db.prepare("INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES ('ta-worker', 'team-1', 'worker', 'worker', 1)").run();
  daemon = new ManagerDaemon(db);
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

describe("stale delegation group sweep (regression: it killed the retry spawned in the same tick)", () => {
  it("keeps a group whose member the stale-delegation sweep just retried, and the retry keeps running", async () => {
    const { taskId, parentId } = seedTask();
    const { groupId, delegationId, childId } = seedStaleMember(taskId, parentId);
    const resumes = recordResumes();
    const dm = daemon.getDelegationManager();

    // Same order, same synchronous turn as ReconciliationLoop.tick().
    expect(dm.checkStaleDelegations()).toBe(1);
    expect(dm.checkStaleDelegationGroups()).toBe(0);

    expect(groupRow(groupId).status).toBe("running");
    const retried = delegationRow(delegationId);
    expect(["pending", "running"]).toContain(retried.status);
    expect(retried.child_instance_id).not.toBe(childId);
    const attempt = db
      .prepare("SELECT attempt FROM agent_instances WHERE id = ?")
      .get(retried.child_instance_id) as { attempt: number } | null;
    expect(attempt?.attempt).toBe(2);

    expect(await waitFor(() => delegationRow(delegationId).status === "running")).toBe(true);
    expect(daemon.getAgentManager().getRunningAgent(retried.child_instance_id!)).toBeTruthy();
    expect(resumes).toHaveLength(0);
  });

  it("still times out a group whose unsettled members have no attempt younger than the timeout", async () => {
    const { taskId, parentId } = seedTask();
    const { groupId, delegationId } = seedStaleMember(taskId, parentId);
    const resumes = recordResumes();

    expect(daemon.getDelegationManager().checkStaleDelegationGroups()).toBe(1);

    expect(groupRow(groupId).status).toBe("completed");
    expect(delegationRow(delegationId)).toMatchObject({ status: "failed", result: "Delegation group timed out" });
    expect(resumes.map((r) => r.id)).toEqual([parentId]);
    await Bun.sleep(20);
  });

  it("does not sweep a stale group while an escalation is open on its task (its parent must not be woken)", async () => {
    const { taskId, parentId } = seedTask();
    const { groupId, delegationId, childId } = seedStaleMember(taskId, parentId);
    db.prepare(
      `INSERT INTO escalations (id, agent_id, runtime_agent_id, task_id, type, question)
       VALUES (?, 'worker', ?, ?, 'agent_request', 'Which region?')`,
    ).run(crypto.randomUUID(), childId, taskId);
    const resumes = recordResumes();

    expect(daemon.getDelegationManager().checkStaleDelegationGroups()).toBe(0);

    expect(groupRow(groupId).status).toBe("running");
    expect(delegationRow(delegationId).status).toBe("running");
    await Bun.sleep(20);
    expect(resumes).toHaveLength(0);
  });
});

describe("delegation retry whose spawn fails (regression: a false spawn left it pending for the group timeout)", () => {
  it("settles a retry whose spawn returns false as failed and routes the failure to the parent", async () => {
    // The worker's CLI is gone by the time the retry spawns: spawnChildInstance
    // reports the ENOENT as false, not as a rejection.
    db.prepare("UPDATE agents SET type = 'test-missing' WHERE id = 'worker'").run();
    const { taskId, parentId } = seedTask();
    const { groupId, delegationId } = seedStaleMember(taskId, parentId);
    const resumes = recordResumes();

    expect(daemon.getDelegationManager().checkStaleDelegations()).toBe(1);

    expect(await waitFor(() => delegationRow(delegationId).status === "failed", 2_000)).toBe(true);
    expect(delegationRow(delegationId).result).toBe("Retry spawn failed");
    expect(groupRow(groupId)).toMatchObject({ status: "completed", settled_count: 1, failed_count: 1 });
    expect(await waitFor(() => resumes.length > 0, 2_000)).toBe(true);
    await Bun.sleep(50);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.id).toBe(parentId);
    expect(resumes[0]!.message).toContain("Retry spawn failed");
  });

  it("leaves a retry whose prompt write failed to its killed child's exit, so it is settled once", async () => {
    const { taskId, parentId } = seedTask();
    const { groupId, delegationId } = seedStaleMember(taskId, parentId);
    const resumes = recordResumes();
    // The retry spawns, then the prompt write breaks: spawnChildInstance kills
    // the child and reports false with the delegation already running.
    daemon.getAgentManager().sendInput = () => {
      throw new Error("EPIPE: broken pipe");
    };

    expect(daemon.getDelegationManager().checkStaleDelegations()).toBe(1);

    expect(await waitFor(() => delegationRow(delegationId).status === "failed", 10_000)).toBe(true);
    expect(delegationRow(delegationId).result).toMatch(/^Child agent exited with code/);
    expect(groupRow(groupId)).toMatchObject({ status: "completed", settled_count: 1, failed_count: 1 });
    expect(await waitFor(() => resumes.length > 0, 2_000)).toBe(true);
    await Bun.sleep(100);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.id).toBe(parentId);
  }, 20_000);
});
