import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { ReconciliationLoop } from "./tick-loop";
import { TaskScheduler } from "../tasks/scheduler";
import {
  setNumberSetting,
  SETTING_TASK_RETENTION_DAYS,
  SETTING_RECURRING_TASK_RETENTION_DAYS,
} from "../config/app-settings";
import { unlinkSync } from "fs";

const TEST_DB = "test-tick-loop.db";

// Minimal mock implementations for ReconciliationLoop dependencies
function createMockReconciliationLoop(db: Database): ReconciliationLoop {
  const mockAgentManager = {
    getRunningAgents: () => new Map(),
  } as any;
  const mockTaskRunner = {
    processTaskQueue: async () => ({ processed: 0 }),
  } as any;
  const mockRecoveryManager = {
    cleanupStaleState: () => {},
    recoverAllStaleTasks: async () => {},
    persistCheckpoints: () => {},
  } as any;
  const mockDelegationManager = {
    checkStaleDelegations: () => {},
    getActiveDelegationForParent: () => null,
  } as any;
  const mockHealthMonitor = {
    checkProcessHealth: () => {},
    runStuckDetection: () => {},
  } as any;

  return new ReconciliationLoop(
    db,
    mockAgentManager,
    mockTaskRunner,
    mockRecoveryManager,
    mockDelegationManager,
    mockHealthMonitor,
  );
}

describe("cleanupOldTerminalOutputs", () => {
  let db: Database;
  let loop: ReconciliationLoop;

  beforeEach(() => {
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);

    // Create a test agent
    db.prepare(
      "INSERT INTO agents (id, name, type, model, config, capabilities) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("agent-1", "Test Agent", "claude-code", "default", "{}", "[]");

    loop = createMockReconciliationLoop(db);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it("deletes terminal outputs older than retention period", () => {
    // Create a session
    const sessionId = "sess-old";
    db.prepare("INSERT INTO agent_sessions (id, agent_id, created_at) VALUES (?, ?, datetime('now', '-48 hours'))").run(sessionId, "agent-1");

    // Insert old output (48 hours ago)
    db.prepare(
      "INSERT INTO terminal_outputs (agent_id, session_id, stream, data, sequence, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-48 hours'))",
    ).run("agent-1", sessionId, "stdout", "old output", 1);

    // Insert recent output
    const recentSessionId = "sess-new";
    db.prepare("INSERT INTO agent_sessions (id, agent_id) VALUES (?, ?)").run(recentSessionId, "agent-1");
    db.prepare(
      "INSERT INTO terminal_outputs (agent_id, session_id, stream, data, sequence) VALUES (?, ?, ?, ?, ?)",
    ).run("agent-1", recentSessionId, "stdout", "recent output", 2);

    // Run cleanup
    loop.cleanupOldTerminalOutputs();

    // Old output should be gone
    const oldRows = db.prepare("SELECT * FROM terminal_outputs WHERE data = 'old output'").all();
    expect(oldRows).toHaveLength(0);

    // Recent output should remain
    const recentRows = db.prepare("SELECT * FROM terminal_outputs WHERE data = 'recent output'").all();
    expect(recentRows).toHaveLength(1);
  });

  it("deletes old agent sessions", () => {
    db.prepare("INSERT INTO agent_sessions (id, agent_id, created_at) VALUES (?, ?, datetime('now', '-48 hours'))").run("sess-old", "agent-1");
    db.prepare("INSERT INTO agent_sessions (id, agent_id) VALUES (?, ?)").run("sess-new", "agent-1");

    loop.cleanupOldTerminalOutputs();

    const sessions = db.prepare("SELECT * FROM agent_sessions WHERE agent_id = 'agent-1'").all();
    expect(sessions).toHaveLength(1);
    expect((sessions[0] as any).id).toBe("sess-new");
  });

  it("preserves outputs within retention period", () => {
    const sessionId = "sess-recent";
    db.prepare("INSERT INTO agent_sessions (id, agent_id) VALUES (?, ?)").run(sessionId, "agent-1");
    db.prepare(
      "INSERT INTO terminal_outputs (agent_id, session_id, stream, data, sequence) VALUES (?, ?, ?, ?, ?)",
    ).run("agent-1", sessionId, "stdout", "keep this", 1);

    loop.cleanupOldTerminalOutputs();

    const rows = db.prepare("SELECT * FROM terminal_outputs WHERE data = 'keep this'").all();
    expect(rows).toHaveLength(1);
  });
});

describe("autoDeleteOldTasks", () => {
  let db: Database;
  let loop: ReconciliationLoop;

  function makeLoopWithScheduler(database: Database): ReconciliationLoop {
    const noop = () => {};
    return new ReconciliationLoop(
      database,
      { getRunningAgents: () => new Map() } as any,
      { processTaskQueue: async () => ({ processed: 0 }) } as any,
      { cleanupStaleState: noop, recoverAllStaleTasks: async () => {}, persistCheckpoints: noop } as any,
      { checkStaleDelegations: noop, getActiveDelegationForParent: () => null } as any,
      { checkProcessHealth: noop, runStuckDetection: noop } as any,
      undefined, undefined, undefined, undefined,
      new TaskScheduler(database),
    );
  }

  function insertTask(id: string, status: string, ageDays: number, recurring: boolean): void {
    db.prepare(
      `INSERT INTO tasks (id, title, status, source_scheduled_task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now', ? || ' days'), datetime('now', ? || ' days'))`,
    ).run(id, `t-${id}`, status, recurring ? "sched-1" : null, -ageDays, -ageDays);
  }

  const remaining = (): string[] =>
    (db.prepare("SELECT id FROM tasks ORDER BY id").all() as { id: string }[]).map((r) => r.id);

  beforeEach(() => {
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);
    loop = makeLoopWithScheduler(db);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it("does nothing when both windows are disabled (0/default)", () => {
    insertTask("old-done", "completed", 100, false);
    loop.autoDeleteOldTasks();
    expect(remaining()).toEqual(["old-done"]);
  });

  it("deletes only finished regular tasks past the regular window", () => {
    setNumberSetting(db, SETTING_TASK_RETENTION_DAYS, 30);
    insertTask("reg-old-done", "completed", 40, false);   // delete
    insertTask("reg-old-failed", "failed", 45, false);    // delete
    insertTask("reg-recent", "completed", 5, false);      // keep (too recent)
    insertTask("reg-running", "running", 90, false);      // keep (active)
    insertTask("reg-approved", "approved", 90, false);    // keep (active)
    insertTask("rec-old-done", "completed", 40, true);    // keep (recurring window disabled)
    loop.autoDeleteOldTasks();
    expect(remaining()).toEqual(["rec-old-done", "reg-approved", "reg-recent", "reg-running"]);
  });

  it("applies an independent window to recurring runs", () => {
    setNumberSetting(db, SETTING_TASK_RETENTION_DAYS, 30);
    setNumberSetting(db, SETTING_RECURRING_TASK_RETENTION_DAYS, 7);
    insertTask("reg-25d", "completed", 25, false);  // keep (< 30)
    insertTask("rec-10d", "completed", 10, true);   // delete (> 7)
    insertTask("rec-3d", "completed", 3, true);     // keep (< 7)
    loop.autoDeleteOldTasks();
    expect(remaining()).toEqual(["rec-3d", "reg-25d"]);
  });
});

describe("daemon owner pid coordination", () => {
  let db: Database;
  let loop: ReconciliationLoop;

  beforeEach(() => {
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);
    loop = createMockReconciliationLoop(db);
  });

  afterEach(() => {
    loop.stop();
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it("claims owner pid on start", async () => {
    await loop.start();

    const row = db
      .prepare("SELECT value FROM daemon_state WHERE key = 'owner_pid'")
      .get() as { value: string } | null;
    expect(row?.value).toBe(String(process.pid));
  });

  it("releases owner pid on stop when owned by current process", async () => {
    await loop.start();
    loop.stop();

    const row = db
      .prepare("SELECT value FROM daemon_state WHERE key = 'owner_pid'")
      .get() as { value: string } | null;
    expect(row).toBeNull();
  });

  it("does not release owner pid on stop when owned by another process", () => {
    db
      .prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES ('owner_pid', '424242')")
      .run();

    loop.stop();

    const row = db
      .prepare("SELECT value FROM daemon_state WHERE key = 'owner_pid'")
      .get() as { value: string } | null;
    expect(row?.value).toBe("424242");
  });
});
