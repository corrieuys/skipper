import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { DaemonLoop } from "./tick-loop";
import { unlinkSync } from "fs";

const TEST_DB = "test-tick-loop.db";

// Minimal mock implementations for DaemonLoop dependencies
function createMockDaemonLoop(db: Database): DaemonLoop {
  const mockAgentManager = {
    getRunningAgents: () => new Map(),
  } as any;
  const mockTaskRunner = {
    processTaskQueue: async () => ({ processed: 0 }),
  } as any;
  const mockRecoveryManager = {
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

  return new DaemonLoop(
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
  let loop: DaemonLoop;

  beforeEach(() => {
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);

    // Create a test agent
    db.prepare(
      "INSERT INTO agents (id, name, type, model, config, capabilities) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("agent-1", "Test Agent", "claude-code", "default", "{}", "[]");

    loop = createMockDaemonLoop(db);
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
