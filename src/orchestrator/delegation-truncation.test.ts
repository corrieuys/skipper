import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { DelegationManager, truncateResult, MAX_DELEGATION_RESULT_CHARS } from "./delegation-manager";
import { unlinkSync } from "fs";

const TEST_DB = "test-delegation-truncation.db";

function setupDb(): Database {
  const db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  return db;
}

function seedData(db: Database) {
  db.prepare(
    `INSERT OR IGNORE INTO agent_types (name, command, supports_stdin, supports_resume)
     VALUES ('claude-code', 'echo', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO agents (id, name, type, status, config)
     VALUES ('parent-1', 'parent-agent', 'claude-code', 'idle', '{"instruction":"test"}')`,
  ).run();
  db.prepare(
    `INSERT INTO agents (id, name, type, status, config)
     VALUES ('child-1', 'child-agent', 'claude-code', 'idle', '{"instruction":"test"}')`,
  ).run();
  db.prepare(
    `INSERT INTO teams (id, name, entrypoint_agent_id, phases)
     VALUES ('team-1', 'test-team', 'parent-1', '[]')`,
  ).run();
  db.prepare(
    `INSERT INTO team_agents (id, team_id, agent_id, role, level)
     VALUES ('ta-1', 'team-1', 'parent-1', 'lead', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO team_agents (id, team_id, agent_id, role, level)
     VALUES ('ta-2', 'team-1', 'child-1', 'worker', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO tasks (id, title, status, team_id, current_phase, orchestration_state)
     VALUES ('task-1', 'test-task', 'running', 'team-1', 0, '{}')`,
  ).run();
  db.prepare(
    `UPDATE agents SET current_task_id = 'task-1' WHERE id = 'parent-1'`,
  ).run();
}

describe("truncateResult", () => {
  it("returns short text unchanged", () => {
    expect(truncateResult("hello")).toBe("hello");
  });

  it("truncates text exceeding the limit", () => {
    const result = truncateResult("a".repeat(100), 50);
    expect(result.length).toBeLessThan(100);
    expect(result).toContain("[truncated");
    expect(result.startsWith("a".repeat(50))).toBe(true);
  });

  it("uses MAX_DELEGATION_RESULT_CHARS as default limit", () => {
    const shortText = "x".repeat(MAX_DELEGATION_RESULT_CHARS);
    expect(truncateResult(shortText)).toBe(shortText);

    const longText = "x".repeat(MAX_DELEGATION_RESULT_CHARS + 1000);
    const truncated = truncateResult(longText);
    expect(truncated).toContain("[truncated");
    expect(truncated.length).toBeLessThan(longText.length);
  });

  it("includes truncation marker with character count", () => {
    const result = truncateResult("a".repeat(200), 100);
    expect(result).toContain("[truncated — result exceeded 100 characters]");
  });
});

describe("delegation result truncation", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
    seedData(db);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  describe("handleDelegateComplete", () => {
    it("truncates large results before storing in DB", () => {
      db.prepare(
        `INSERT INTO delegations (id, parent_agent_id, child_agent_id, task_id, prompt, status)
         VALUES ('del-1', 'parent-1', 'child-1', 'task-1', 'do something', 'running')`,
      ).run();

      const largeResult = "x".repeat(MAX_DELEGATION_RESULT_CHARS + 10000);

      let sentMessage = "";
      const dm = new DelegationManager(
        db,
        {
          getAgent: (id: string) => ({ id, name: "test", type: "claude-code", config: { instruction: "test" } }),
          getRunningAgent: (id: string) => id === "parent-1" ? { process: {} } : null,
          getSessionId: () => null,
          sendInput: (_id: string, msg: string) => { sentMessage = msg; },
          killAgent: () => {},
        } as any,
        {} as any,
        { getTask: () => ({ id: "task-1", status: "running" }) } as any,
        () => {},
        () => {},
        () => {},
        () => new Set(),
      );

      dm.handleDelegateComplete("child-1", largeResult);

      const delegation = db.prepare("SELECT result FROM delegations WHERE id = 'del-1'").get() as any;
      expect(delegation.result.length).toBeLessThan(largeResult.length);
      expect(delegation.result).toContain("[truncated");

      expect(sentMessage).toContain("[DELEGATION_RESULT");
      expect(sentMessage).toContain("[truncated");
      expect(sentMessage.length).toBeLessThan(largeResult.length);
    });
  });

  describe("handleChildExit", () => {
    it("truncates gathered terminal output on successful exit", () => {
      db.prepare(
        `INSERT INTO delegations (id, parent_agent_id, child_agent_id, task_id, prompt, status)
         VALUES ('del-1', 'parent-1', 'child-1', 'task-1', 'do something', 'running')`,
      ).run();

      // Insert large terminal output
      for (let i = 0; i < 100; i++) {
        db.prepare(
          `INSERT INTO terminal_outputs (agent_id, stream, sequence, data)
           VALUES ('child-1', 'stdout', ?, ?)`,
        ).run(i, "y".repeat(1000));
      }

      let sentMessage = "";
      const dm = new DelegationManager(
        db,
        {
          getAgent: (id: string) => ({ id, name: "test", type: "claude-code", config: { instruction: "test" } }),
          getRunningAgent: (id: string) => id === "parent-1" ? { process: {} } : null,
          getSessionId: () => null,
          sendInput: (_id: string, msg: string) => { sentMessage = msg; },
          killAgent: () => {},
        } as any,
        {} as any,
        { getTask: () => ({ id: "task-1", status: "running" }) } as any,
        () => {},
        () => {},
        () => {},
        () => new Set(),
      );

      const delegation = {
        id: "del-1",
        parent_agent_id: "parent-1",
        child_agent_id: "child-1",
        task_id: "task-1",
        prompt: "do something",
        result: null,
        status: "running" as const,
        created_at: new Date().toISOString(),
        completed_at: null,
      };

      dm.handleChildExit(delegation, { agentId: "child-1", code: 0 });

      const updated = db.prepare("SELECT result FROM delegations WHERE id = 'del-1'").get() as any;
      expect(updated.result.length).toBeLessThanOrEqual(MAX_DELEGATION_RESULT_CHARS + 200); // allow for marker
      expect(updated.result).toContain("[truncated");

      expect(sentMessage).toContain("[DELEGATION_RESULT");
      expect(sentMessage).toContain("[truncated");
    });
  });

  describe("routeResultToParent", () => {
    it("truncates result in the routed message", () => {
      const largeResult = "z".repeat(MAX_DELEGATION_RESULT_CHARS + 5000);

      let sentMessage = "";
      const dm = new DelegationManager(
        db,
        {
          getAgent: () => ({ id: "parent-1", name: "test", type: "claude-code", config: { instruction: "test" } }),
          getRunningAgent: () => ({ process: {} }),
          getSessionId: () => null,
          sendInput: (_id: string, msg: string) => { sentMessage = msg; },
        } as any,
        {} as any,
        {} as any,
        () => {},
        () => {},
        () => {},
        () => new Set(),
      );

      dm.routeResultToParent("parent-1", "child-1", largeResult, "task-1");

      expect(sentMessage).toContain("[DELEGATION_RESULT from:child-1]");
      expect(sentMessage).toContain("[truncated");
      expect(sentMessage).toContain("[END_DELEGATION_RESULT]");
      expect(sentMessage.length).toBeLessThan(largeResult.length);
    });

    it("does not truncate short results", () => {
      const shortResult = "all good";

      let sentMessage = "";
      const dm = new DelegationManager(
        db,
        {
          getAgent: () => ({ id: "parent-1", name: "test", type: "claude-code", config: { instruction: "test" } }),
          getRunningAgent: () => ({ process: {} }),
          getSessionId: () => null,
          sendInput: (_id: string, msg: string) => { sentMessage = msg; },
        } as any,
        {} as any,
        {} as any,
        () => {},
        () => {},
        () => {},
        () => new Set(),
      );

      dm.routeResultToParent("parent-1", "child-1", shortResult, "task-1");

      expect(sentMessage).toBe("[DELEGATION_RESULT from:child-1]\nall good\n[END_DELEGATION_RESULT]");
      expect(sentMessage).not.toContain("[truncated");
    });
  });
});
