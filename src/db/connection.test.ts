import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "./connection";
import { unlinkSync } from "fs";

const TEST_DB = "test-schema.db";

let db: Database;

beforeEach(() => {
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
});

afterEach(() => {
  db.close();
  try { unlinkSync(TEST_DB); } catch {}
});

describe("Schema creation", () => {
  it("creates all expected tables", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    const expected = [
      "agent_memories",
      "agent_states",
      "agent_types",
      "agents",
      "artifacts",
      "cli_runtimes",
      "daemon_state",
      "delegations",
      "escalations",
      "events",
      "manager_runs",
      "messages",
      "phase_regressions",
      "state_patterns",
      "task_checkpoints",
      "task_notes",
      "tasks",
      "team_agents",
      "teams",
      "terminal_outputs",
      "stuck_detection_logs",
    ];
    for (const name of expected) {
      expect(tableNames).toContain(name);
    }
  });
});

describe("Seed data", () => {
  it("seeds claude-code agent type", () => {
    const row = db.prepare("SELECT * FROM agent_types WHERE name = ?").get("claude-code") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.command).toBe("claude");
    expect(row.supports_resume).toBe(1);
    expect(row.resume_flag).toBe("--resume");
    const args = JSON.parse(row.args as string);
    expect(args).toContain("--print");
    expect(args).toContain("--output-format");
  });

  it("seeds codex agent type", () => {
    const row = db.prepare("SELECT * FROM agent_types WHERE name = ?").get("codex") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.command).toBe("codex");
    expect(row.supports_resume).toBe(1);
    expect(row.resume_flag).toBe("exec resume");
  });

  it("seeds custom agent type", () => {
    const row = db.prepare("SELECT * FROM agent_types WHERE name = ?").get("custom") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.command).toBe("");
    expect(row.supports_resume).toBe(0);
  });

  it("is idempotent (running seed twice does not duplicate)", () => {
    initializeDatabase(db);
    const count = db.prepare("SELECT COUNT(*) as cnt FROM agent_types").get() as { cnt: number };
    expect(count.cnt).toBe(3);
  });
});

describe("Table constraints", () => {
  it("enforces task status check constraint", () => {
    expect(() => {
      db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run("t1", "Test", "invalid");
    }).toThrow();
  });

  it("enforces agent status check constraint", () => {
    db.prepare("INSERT INTO agent_types (name, command) VALUES (?, ?)").run("test-type", "test");
    expect(() => {
      db.prepare("INSERT INTO agents (id, name, type, status) VALUES (?, ?, ?, ?)").run("a1", "Test", "test-type", "invalid");
    }).toThrow();
  });

  it("enforces foreign key on agents.type", () => {
    expect(() => {
      db.prepare("INSERT INTO agents (id, name, type) VALUES (?, ?, ?)").run("a1", "Test", "nonexistent");
    }).toThrow();
  });

  it("enforces unique team_agents membership", () => {
    db.prepare("INSERT INTO agents (id, name, type) VALUES (?, ?, ?)").run("a1", "Agent 1", "claude-code");
    db.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run("team1", "Team 1");
    db.prepare("INSERT INTO team_agents (id, team_id, agent_id) VALUES (?, ?, ?)").run("ta1", "team1", "a1");
    expect(() => {
      db.prepare("INSERT INTO team_agents (id, team_id, agent_id) VALUES (?, ?, ?)").run("ta2", "team1", "a1");
    }).toThrow();
  });
});

describe("Indexes", () => {
  it("creates terminal_outputs index", () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_terminal_outputs_agent_seq'"
    ).all();
    expect(indexes).toHaveLength(1);
  });

  it("creates events indexes", () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_events_%'"
    ).all();
    expect(indexes.length).toBeGreaterThanOrEqual(2);
  });
});
