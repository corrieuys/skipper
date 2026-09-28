import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initializeDatabase } from "../db/connection";
import { ManagerDaemon } from "../agents/manager-daemon";
import { clearAgentTypeCache } from "../agents/types";
import { eventBus } from "../events/bus";

// Delegated siblings that finish while an escalation is open on their task. The
// escalating runtime stays halted until the operator answers, but a sibling's
// result must land on its delegation (it used to be dropped, leaving the
// delegation running with a dead child until the 60 min timeout), and nothing may
// reach or wake the root until the task's last escalation is closed. Then the
// held results reach the parent once, never as a second resume on top of the
// turn the answer itself resumed.

const TEST_DB = "test-delegation-escalation-hold.db";

// A stand-in CLI whose every run waits for its go file, prints it as one stdout
// frame and exits 0. Reading the file removes it, so a resumed run of the same
// runtime waits again: the test decides when each turn ends.
const WAIT_SCRIPT = 'while [ ! -f "$GO_FILE" ]; do sleep 0.05; done; cat "$GO_FILE"; rm -f "$GO_FILE"';

let db: Database;
let daemon: ManagerDaemon;
let goDir: string;

interface ResumeCall { id: string; message: string; wasRunning: boolean }

function goFile(agentId: string): string {
  return join(goDir, `go-${agentId}`);
}

/** End the current turn of every running `agentId` runtime with this result. */
function go(agentId: string, result: string): void {
  const tmp = `${goFile(agentId)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ type: "result", result })}\n`);
  renameSync(tmp, goFile(agentId));
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

/** Record every resume (escalation answers and delegation results alike), then let it run. */
function trackResumes(): ResumeCall[] {
  const calls: ResumeCall[] = [];
  const agentManager = daemon.getAgentManager();
  const original = agentManager.sendResumeMessage.bind(agentManager);
  agentManager.sendResumeMessage = async (id: string, message: string, closeStdin?: boolean) => {
    calls.push({ id, message, wasRunning: !!agentManager.getRunningAgent(id) });
    return original(id, message, closeStdin);
  };
  return calls;
}

function isRunning(runtimeId: string): boolean {
  return !!daemon.getAgentManager().getRunningAgent(runtimeId);
}

function instanceStatus(id: string): string | undefined {
  return (db.prepare("SELECT status FROM agent_instances WHERE id = ?").get(id) as { status: string } | null)?.status;
}

function delegationRow(id: string): { status: string; result: string | null } {
  return db.prepare("SELECT status, result FROM delegations WHERE id = ?").get(id) as { status: string; result: string | null };
}

function groupRow(id: string): { status: string; settled_count: number; expected_count: number } {
  return db
    .prepare("SELECT status, settled_count, expected_count FROM delegation_groups WHERE id = ?")
    .get(id) as { status: string; settled_count: number; expected_count: number };
}

interface Started {
  taskId: string;
  rootId: string;
  groupId: string;
  a: { delegationId: string; runtimeId: string };
  b: { delegationId: string; runtimeId: string };
}

/**
 * A root that delegates part A and part B to two workers, then ends its turn:
 * parked on the group, exactly as a CLI root waits for its children.
 */
async function startRootWithTwoChildren(): Promise<Started> {
  const taskId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO tasks (id, title, team_id, status, started_at) VALUES (?, 'Hold test', 'team-1', 'active', datetime('now'))",
  ).run(taskId);
  const agentManager = daemon.getAgentManager();
  const root = await agentManager.spawnAgent("skipper", { workingDir: process.cwd(), taskId });
  // Resumable, so an escalation answer and a delegation result can resume it.
  db.prepare("UPDATE agent_instances SET session_id = 'sess-root' WHERE id = ?").run(root.id);

  const started = await daemon.getDelegationManager().handleDelegationBatch(root.id, [
    { to: "worker-a", work: "Investigate part A" },
    { to: "worker-b", work: "Investigate part B" },
  ]);
  expect(started).toHaveLength(2);
  const a = started.find((d) => d.child_agent_id === "worker-a")!;
  const b = started.find((d) => d.child_agent_id === "worker-b")!;
  db.prepare("UPDATE agent_instances SET session_id = 'sess-a' WHERE id = ?").run(a.child_instance_id!);

  go("skipper", "handed off to part A and part B");
  expect(await waitFor(() => !isRunning(root.id))).toBe(true);

  return {
    taskId,
    rootId: root.id,
    groupId: a.delegation_group_id!,
    a: { delegationId: a.id, runtimeId: a.child_instance_id! },
    b: { delegationId: b.id, runtimeId: b.child_instance_id! },
  };
}

beforeEach(() => {
  clearAgentTypeCache();
  goDir = mkdtempSync(join(tmpdir(), "skipper-escalation-hold-"));
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  db.prepare(
    `INSERT OR REPLACE INTO agent_types (name, command, args, supports_stdin, supports_resume)
     VALUES ('test-wait', 'bash', ?, 0, 1)`,
  ).run(JSON.stringify(["-c", WAIT_SCRIPT]));
  const config = (agentId: string): string => JSON.stringify({ environment: { GO_FILE: goFile(agentId) } });
  db.prepare("INSERT OR IGNORE INTO agents (id, name, type, model) VALUES ('skipper', 'Skipper', 'test-wait', 'default')").run();
  db.prepare("UPDATE agents SET type = 'test-wait', config = ? WHERE id = 'skipper'").run(config("skipper"));
  db.prepare("INSERT INTO agents (id, name, type, config, capabilities) VALUES ('worker-a', 'Worker A', 'test-wait', ?, '[]')").run(config("worker-a"));
  db.prepare("INSERT INTO agents (id, name, type, config, capabilities) VALUES ('worker-b', 'Worker B', 'test-wait', ?, '[]')").run(config("worker-b"));
  db.prepare("INSERT INTO teams (id, name, entrypoint_agent_id, phases) VALUES ('team-1', 'Team', 'skipper', '[]')").run();
  db.prepare("INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES ('ta-lead', 'team-1', 'skipper', 'lead', 0)").run();
  db.prepare("INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES ('ta-a', 'team-1', 'worker-a', 'analyst', 1)").run();
  db.prepare("INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES ('ta-b', 'team-1', 'worker-b', 'researcher', 1)").run();
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
  rmSync(goDir, { recursive: true, force: true });
});

describe("delegation results while an escalation is open (regression: a sibling's exit was dropped)", () => {
  it("records a sibling's result while another child's escalation is open, keeps the root parked, and delivers it once after the answer", async () => {
    const s = await startRootWithTwoChildren();
    const resumes = trackResumes();
    const escalation = daemon.getEscalationManager().createEscalation({
      agentId: "worker-a",
      runtimeAgentId: s.a.runtimeId,
      taskId: s.taskId,
      type: "agent_request",
      question: "Which region?",
    });

    // The escalating child ends its turn to wait for the answer: halted, as before.
    go("worker-a", "waiting on the operator");
    expect(await waitFor(() => instanceStatus(s.a.runtimeId) === "stopped")).toBe(true);
    expect(delegationRow(s.a.delegationId)).toEqual({ status: "running", result: null });

    // Its sibling finishes meanwhile: the result lands on its delegation and group.
    go("worker-b", "worker-b findings");
    expect(await waitFor(() => delegationRow(s.b.delegationId).status === "completed")).toBe(true);
    expect(delegationRow(s.b.delegationId).result).toBe("worker-b findings");
    expect(instanceStatus(s.b.runtimeId)).toBe("completed");
    expect(groupRow(s.groupId)).toMatchObject({ status: "running", settled_count: 1 });
    // Nothing reached or woke the root.
    await Bun.sleep(150);
    expect(resumes).toHaveLength(0);
    expect(isRunning(s.rootId)).toBe(false);

    // The answer resumes the escalating child, not the root.
    await daemon.resolveEscalation(escalation.id, "EU only");
    expect(resumes.map((r) => r.id)).toEqual([s.a.runtimeId]);
    expect(isRunning(s.a.runtimeId)).toBe(true);
    expect(isRunning(s.rootId)).toBe(false);

    // When it finishes, the group completes and the root gets both results in one delivery.
    go("worker-a", "worker-a findings");
    expect(await waitFor(() => resumes.some((r) => r.id === s.rootId))).toBe(true);
    await Bun.sleep(150);
    const toRoot = resumes.filter((r) => r.id === s.rootId);
    expect(toRoot).toHaveLength(1);
    expect(toRoot[0]!.message).toContain("worker-b findings");
    expect(toRoot[0]!.message).toContain("worker-a findings");
    expect(groupRow(s.groupId).status).toBe("completed");
  }, 30_000);

  it("holds a group that settles while the root's own escalation is open and hands it over when the answered turn ends, never on top of it", async () => {
    const s = await startRootWithTwoChildren();
    const resumes = trackResumes();
    const escalation = daemon.getEscalationManager().createEscalation({
      agentId: "skipper",
      runtimeAgentId: s.rootId,
      taskId: s.taskId,
      type: "agent_request",
      question: "What budget?",
    });

    go("worker-a", "worker-a findings");
    go("worker-b", "worker-b findings");
    expect(await waitFor(() =>
      delegationRow(s.a.delegationId).status === "completed" && delegationRow(s.b.delegationId).status === "completed",
    )).toBe(true);
    // Every member settled, yet the group is held: not completed, nothing routed.
    expect(groupRow(s.groupId)).toMatchObject({ status: "running", settled_count: 2, expected_count: 2 });
    await Bun.sleep(150);
    expect(resumes).toHaveLength(0);
    expect(isRunning(s.rootId)).toBe(false);

    // The answer resumes the root; the held results are not pushed onto that turn.
    await daemon.resolveEscalation(escalation.id, "Stay under budget");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.id).toBe(s.rootId);
    expect(resumes[0]!.message).toContain("[USER_RESPONSE] Stay under budget");
    expect(isRunning(s.rootId)).toBe(true);
    await Bun.sleep(300);
    expect(resumes).toHaveLength(1);
    expect(groupRow(s.groupId).status).toBe("running");

    // The answered turn ends: now the held results go to the root, once.
    go("skipper", "answer handled");
    expect(await waitFor(() => resumes.length >= 2)).toBe(true);
    await Bun.sleep(300);
    expect(resumes).toHaveLength(2);
    expect(resumes[1]!.id).toBe(s.rootId);
    expect(resumes[1]!.wasRunning).toBe(false);
    expect(resumes[1]!.message).toContain("[DELEGATION_BATCH_RESULT");
    expect(resumes[1]!.message).toContain("worker-a findings");
    expect(resumes[1]!.message).toContain("worker-b findings");
    expect(groupRow(s.groupId).status).toBe("completed");
  }, 30_000);
});

describe("dismissing a halted child's escalation (regression: its delegation stayed running with no agent)", () => {
  it("fails the child's delegation, never resumes the child, and routes the group to the root once", async () => {
    const s = await startRootWithTwoChildren();
    const resumes = trackResumes();
    const escalation = daemon.getEscalationManager().createEscalation({
      agentId: "worker-a",
      runtimeAgentId: s.a.runtimeId,
      taskId: s.taskId,
      type: "agent_request",
      question: "Install on the iPhone again?",
    });

    // The escalating child ends its turn and is held for the answer.
    go("worker-a", "waiting on the operator");
    expect(await waitFor(() => instanceStatus(s.a.runtimeId) === "stopped")).toBe(true);
    go("worker-b", "worker-b findings");
    expect(await waitFor(() => delegationRow(s.b.delegationId).status === "completed")).toBe(true);

    // The operator dismisses it: no answer to deliver, so the delegation fails.
    daemon.getEscalationManager().dismissEscalation(escalation.id);
    expect(delegationRow(s.a.delegationId)).toEqual({ status: "failed", result: "Escalation dismissed by operator" });
    expect(instanceStatus(s.a.runtimeId)).toBe("stopped");
    expect(await waitFor(() => resumes.some((r) => r.id === s.rootId))).toBe(true);
    await Bun.sleep(300);
    expect(resumes.map((r) => r.id)).toEqual([s.rootId]);
    expect(resumes[0]!.message).toContain("worker-b findings");
    expect(resumes[0]!.message).toContain("Escalation dismissed by operator");
    expect(groupRow(s.groupId)).toMatchObject({ status: "completed", settled_count: 2 });
  }, 30_000);

  it("leaves a child that is still running alone: its own exit settles the delegation", async () => {
    const s = await startRootWithTwoChildren();
    const escalation = daemon.getEscalationManager().createEscalation({
      agentId: "worker-a",
      runtimeAgentId: s.a.runtimeId,
      taskId: s.taskId,
      type: "agent_request",
      question: "Which region?",
    });
    daemon.getEscalationManager().dismissEscalation(escalation.id);
    expect(isRunning(s.a.runtimeId)).toBe(true);
    expect(delegationRow(s.a.delegationId)).toEqual({ status: "running", result: null });

    go("worker-a", "worker-a findings");
    expect(await waitFor(() => delegationRow(s.a.delegationId).status === "completed")).toBe(true);
    expect(delegationRow(s.a.delegationId).result).toBe("worker-a findings");
  }, 30_000);
});

describe("held delegation results survive in the rows", () => {
  /** What a daemon leaves behind for a held group: both members settled, the group still running. */
  function seedHeldGroup(): { taskId: string; rootId: string; groupId: string } {
    const taskId = crypto.randomUUID();
    const rootId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO tasks (id, title, team_id, status, started_at) VALUES (?, 'Held', 'team-1', 'active', datetime('now'))",
    ).run(taskId);
    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, parent_instance_id, root_instance_id, status, session_id, attempt)
       VALUES (?, ?, 'skipper', NULL, ?, 'failed', 'sess-root', 1)`,
    ).run(rootId, taskId, rootId);
    db.prepare(
      `INSERT INTO delegation_groups (id, task_id, parent_instance_id, expected_count, settled_count, failed_count, status, created_at)
       VALUES (?, ?, ?, 2, 2, 0, 'running', datetime('now', '-90 minutes'))`,
    ).run(groupId, taskId, rootId);
    for (const [agentId, result] of [["worker-a", "worker-a findings"], ["worker-b", "worker-b findings"]] as const) {
      db.prepare(
        `INSERT INTO delegations (id, parent_agent_id, child_agent_id, parent_instance_id, child_instance_id, delegation_group_id, task_id, prompt, result, status, completed_at, created_at)
         VALUES (?, 'skipper', ?, ?, ?, ?, ?, 'part', ?, 'completed', datetime('now'), datetime('now', '-90 minutes'))`,
      ).run(crypto.randomUUID(), agentId, rootId, crypto.randomUUID(), groupId, taskId, result);
    }
    return { taskId, rootId, groupId };
  }

  /** Record parent resumes without respawning anything. */
  function recordResumes(): ResumeCall[] {
    const calls: ResumeCall[] = [];
    daemon.getAgentManager().sendResumeMessage = async (id: string, message: string) => {
      calls.push({ id, message, wasRunning: isRunning(id) });
    };
    return calls;
  }

  it("keeps an old held group through the sweep while the escalation is open, and delivers it once on dismiss", async () => {
    const { taskId, rootId, groupId } = seedHeldGroup();
    const escalationId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO escalations (id, agent_id, runtime_agent_id, task_id, type, question)
       VALUES (?, 'skipper', ?, ?, 'agent_request', 'Go on?')`,
    ).run(escalationId, rootId, taskId);
    const resumes = recordResumes();
    const dm = daemon.getDelegationManager();

    expect(dm.checkStaleDelegationGroups()).toBe(0);
    expect(groupRow(groupId).status).toBe("running");
    expect(resumes).toHaveLength(0);

    daemon.getEscalationManager().dismissEscalation(escalationId);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.id).toBe(rootId);
    expect(resumes[0]!.message).toContain("worker-a findings");
    expect(resumes[0]!.message).toContain("worker-b findings");
    expect(groupRow(groupId).status).toBe("completed");

    dm.checkStaleDelegationGroups();
    await Bun.sleep(20);
    expect(resumes).toHaveLength(1);
  });

  it("delivers a held group left by a previous daemon once the sweep finds its escalations closed", async () => {
    const { taskId, rootId, groupId } = seedHeldGroup();
    // Answered while the root was running, then the daemon restarted before
    // that root's exit could hand the results over.
    db.prepare(
      `INSERT INTO escalations (id, agent_id, runtime_agent_id, task_id, type, question, response, status, resolved_at)
       VALUES (?, 'skipper', ?, ?, 'agent_request', 'Go on?', 'Yes', 'resolved', datetime('now'))`,
    ).run(crypto.randomUUID(), rootId, taskId);
    const resumes = recordResumes();
    const dm = daemon.getDelegationManager();

    dm.checkStaleDelegationGroups();
    dm.checkStaleDelegationGroups();
    await Bun.sleep(20);

    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.id).toBe(rootId);
    expect(resumes[0]!.message).toContain("[DELEGATION_BATCH_RESULT");
    expect(groupRow(groupId).status).toBe("completed");
  });
});
