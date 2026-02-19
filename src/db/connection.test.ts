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
      "agent_states",
      "agent_types",
      "agents",
      "daemon_state",
      "delegations",
      "escalations",
      "events",
      "manager_runs",
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
    expect(row.resume_args).toBeNull();
    const args = JSON.parse(row.args as string);
    expect(args).toContain("--print");
    expect(args).toContain("--output-format");
  });

  it("seeds codex agent type", () => {
    const row = db.prepare("SELECT * FROM agent_types WHERE name = ?").get("codex") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.command).toBe("codex");
    expect(row.supports_resume).toBe(1);
    expect(row.resume_flag).toBeNull();
    expect(row.resume_args).toBe(
      JSON.stringify(["exec", "resume", "{{session_id}}", "--json", "--dangerously-bypass-approvals-and-sandbox", "-"]),
    );
  });

  it("seeds opencode agent type", () => {
    const row = db.prepare("SELECT * FROM agent_types WHERE name = ?").get("opencode") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.command).toBe("opencode");
    expect(row.supports_resume).toBe(1);
    expect(row.resume_flag).toBeNull();
    expect(row.model_flag).toBe("-m");
    expect(row.resume_args).toBe(
      JSON.stringify(["run", "{{prompt}}", "--format", "json", "--session", "{{session_id}}"]),
    );
  });

  it("seeds oz agent type", () => {
    const row = db.prepare("SELECT * FROM agent_types WHERE name = ?").get("oz") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.command).toBe("oz");
    expect(row.supports_resume).toBe(0);
    expect(row.model_flag).toBe("--model");
    expect(row.resume_args).toBeNull();
    expect(row.args).toBe(
      JSON.stringify(["agent", "run", "--output-format", "json", "--prompt", "{{prompt}}"]),
    );
  });

  it("seeds conversation-skipper agent type", () => {
    const row = db.prepare("SELECT * FROM agent_types WHERE name = ?").get("conversation-skipper") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.command).toBe("claude");
    expect(row.supports_resume).toBe(1);
    expect(row.resume_flag).toBe("--resume");
  });

  it("seeds chat-skipper agent with claude-code type", () => {
    const row = db.prepare("SELECT * FROM agents WHERE id = ?").get("chat-skipper") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.type).toBe("claude-code");
    expect(row.name).toBe("Chat Skipper");
    expect(row.model).toBe("claude-opus-4-6");
  });

  it("is idempotent (running seed twice does not duplicate)", () => {
    initializeDatabase(db);
    const typeCount = db.prepare("SELECT COUNT(*) as cnt FROM agent_types").get() as { cnt: number };
    expect(typeCount.cnt).toBe(5);
    const agentCount = db.prepare("SELECT COUNT(*) as cnt FROM agents WHERE id = 'chat-skipper'").get() as { cnt: number };
    expect(agentCount.cnt).toBe(1);
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

describe("Legacy schema migration", () => {
  it("adds missing session_id columns before creating session index", () => {
    const legacyDbPath = "test-legacy-schema.db";
    const legacyDb = new Database(legacyDbPath);
    legacyDb.exec("PRAGMA foreign_keys = ON");

    try {
      legacyDb.exec(`
        CREATE TABLE terminal_outputs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          stream TEXT NOT NULL,
          data TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE task_checkpoints (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          checkpoint_type TEXT NOT NULL,
          context_snapshot TEXT NOT NULL DEFAULT '{}',
          terminal_seq INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      expect(() => initializeDatabase(legacyDb)).not.toThrow();

      const terminalCols = legacyDb
        .prepare("PRAGMA table_info(terminal_outputs)")
        .all() as { name: string }[];
      expect(terminalCols.some((col) => col.name === "session_id")).toBe(true);

      const checkpointCols = legacyDb
        .prepare("PRAGMA table_info(task_checkpoints)")
        .all() as { name: string }[];
      expect(checkpointCols.some((col) => col.name === "session_id")).toBe(true);

      const sessionIdx = legacyDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_terminal_outputs_session'",
      ).all();
      expect(sessionIdx).toHaveLength(1);
    } finally {
      legacyDb.close();
      try { unlinkSync(legacyDbPath); } catch {}
    }
  });

  it("drops legacy team_agents.skills column by rebuilding table", () => {
    const legacyDbPath = "test-legacy-team-agents.db";
    const legacyDb = new Database(legacyDbPath);
    legacyDb.exec("PRAGMA foreign_keys = ON");

    try {
      legacyDb.exec(`
        CREATE TABLE agent_types (
          name TEXT PRIMARY KEY,
          command TEXT NOT NULL,
          args TEXT NOT NULL DEFAULT '[]',
          model_flag TEXT,
          available_models TEXT NOT NULL DEFAULT '[]',
          env_vars TEXT NOT NULL DEFAULT '{}',
          supports_stdin INTEGER NOT NULL DEFAULT 0,
          supports_resume INTEGER NOT NULL DEFAULT 0,
          resume_flag TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL REFERENCES agent_types(name),
          capabilities TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE teams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          entrypoint_agent_id TEXT REFERENCES agents(id)
        );
        CREATE TABLE team_agents (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          role TEXT,
          level INTEGER NOT NULL DEFAULT 0,
          parent_agent_id TEXT REFERENCES agents(id),
          skills TEXT NOT NULL DEFAULT '[]',
          max_complexity INTEGER DEFAULT 10,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(team_id, agent_id)
        );
      `);

      legacyDb.prepare("INSERT INTO agent_types (name, command) VALUES ('claude-code', 'claude')").run();
      legacyDb.prepare("INSERT INTO agents (id, name, type, capabilities) VALUES ('a1', 'Agent', 'claude-code', '[]')").run();
      legacyDb.prepare("INSERT INTO teams (id, name) VALUES ('t1', 'Team')").run();
      legacyDb.prepare("INSERT INTO team_agents (id, team_id, agent_id, role, level, skills, max_complexity) VALUES ('ta1', 't1', 'a1', 'worker', 1, '[\"legacy\"]', 7)").run();

      initializeDatabase(legacyDb);

      const cols = legacyDb.prepare("PRAGMA table_info(team_agents)").all() as { name: string }[];
      expect(cols.some((col) => col.name === "skills")).toBe(false);
      expect(cols.some((col) => col.name === "max_complexity")).toBe(false);

      const row = legacyDb
        .prepare("SELECT role, level FROM team_agents WHERE id = 'ta1'")
        .get() as { role: string; level: number } | null;
      expect(row).not.toBeNull();
      expect(row?.role).toBe("worker");
      expect(row?.level).toBe(1);
    } finally {
      legacyDb.close();
      try { unlinkSync(legacyDbPath); } catch {}
    }
  });

  it("adds agent_types.resume_args and migrates agents.config.goal to instruction", () => {
    const legacyDbPath = "test-legacy-agent-config.db";
    const legacyDb = new Database(legacyDbPath);
    legacyDb.exec("PRAGMA foreign_keys = ON");

    try {
      legacyDb.exec(`
        CREATE TABLE agent_types (
          name TEXT PRIMARY KEY,
          command TEXT NOT NULL,
          args TEXT NOT NULL DEFAULT '[]',
          model_flag TEXT,
          available_models TEXT NOT NULL DEFAULT '[]',
          env_vars TEXT NOT NULL DEFAULT '{}',
          supports_stdin INTEGER NOT NULL DEFAULT 0,
          supports_resume INTEGER NOT NULL DEFAULT 0,
          resume_flag TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL REFERENCES agent_types(name),
          model TEXT NOT NULL DEFAULT 'default',
          config TEXT NOT NULL DEFAULT '{}',
          capabilities TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'idle'
        );
      `);
      legacyDb.prepare("INSERT INTO agent_types (name, command) VALUES ('codex', 'codex')").run();
      legacyDb.prepare(
        "INSERT INTO agents (id, name, type, config, capabilities) VALUES ('a1', 'Legacy Agent', 'codex', ?, '[]')",
      ).run(JSON.stringify({ goal: "Legacy goal", model: "default" }));

      initializeDatabase(legacyDb);

      const typeCols = legacyDb.prepare("PRAGMA table_info(agent_types)").all() as { name: string }[];
      expect(typeCols.some((col) => col.name === "resume_args")).toBe(true);

      const agent = legacyDb.prepare("SELECT config FROM agents WHERE id = 'a1'").get() as { config: string } | null;
      expect(agent).not.toBeNull();
      const config = JSON.parse(agent!.config) as Record<string, unknown>;
      expect(config.goal).toBeUndefined();
      expect(config.instruction).toBe("Legacy goal");
    } finally {
      legacyDb.close();
      try { unlinkSync(legacyDbPath); } catch {}
    }
  });
});
