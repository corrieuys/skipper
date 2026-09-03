import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "./connection";
import { unlinkSync } from "fs";

const TEST_DB = "test-unified-migration.db";
let db: Database;

afterEach(() => {
  try { db.close(); } catch {}
  try { unlinkSync(TEST_DB); } catch {}
});

describe("migrateTasksToUnifiedModel", () => {
  it("rebuilds an old-shape tasks table into the unified model without losing child rows", () => {
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");

    // Pre-create the OLD tasks table (six statuses + task_type/iteration_count)
    // plus a child table referencing it ON DELETE CASCADE, so we can prove the
    // rebuild doesn't wipe children via an implicit cascade.
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        team_id TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'running', 'paused', 'completed', 'failed')),
        current_phase INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        orchestration_state TEXT NOT NULL DEFAULT '{}',
        regression_count INTEGER NOT NULL DEFAULT 0,
        iteration_count INTEGER NOT NULL DEFAULT 0,
        needs_review INTEGER NOT NULL DEFAULT 0,
        working_directory TEXT NOT NULL DEFAULT '',
        task_type TEXT NOT NULL DEFAULT 'standard' CHECK (task_type IN ('standard', 'real_time')),
        task_config TEXT NOT NULL DEFAULT '{}',
        source_scheduled_task_id TEXT,
        run_input TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        approved_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec("INSERT INTO tasks (id, title, status, approved_at) VALUES ('t-draft', 'Draft', 'draft', NULL)");
    db.exec("INSERT INTO tasks (id, title, status, approved_at) VALUES ('t-approved', 'Queued', 'approved', '2026-01-01 00:00:00')");
    db.exec("INSERT INTO tasks (id, title, status, started_at) VALUES ('t-running', 'Running', 'running', '2026-01-01 00:00:00')");
    db.exec("INSERT INTO tasks (id, title, status) VALUES ('t-paused', 'Paused', 'paused')");
    db.exec("INSERT INTO tasks (id, title, status, result, completed_at) VALUES ('t-done', 'Done', 'completed', '{\"output\":1}', '2026-01-02 00:00:00')");
    db.exec("INSERT INTO tasks (id, title, status, result) VALUES ('t-failed', 'Failed', 'failed', '{\"error\":\"x\"}')");
    db.exec("INSERT INTO tasks (id, title, status, task_type) VALUES ('t-rt', 'Realtime', 'running', 'real_time')");
    db.exec(`
      CREATE TABLE task_kids (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
      );
    `);
    db.exec("INSERT INTO task_kids (id, task_id) VALUES ('k-1', 't-running')");

    initializeDatabase(db);

    const rows = db.prepare("SELECT id, status, mode, paused, wake_requested_at, settled_at FROM tasks ORDER BY id").all() as Array<{
      id: string; status: string; mode: string; paused: number; wake_requested_at: string | null; settled_at: string | null;
    }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId["t-draft"].status).toBe("draft");
    expect(byId["t-approved"].status).toBe("active");
    expect(byId["t-approved"].wake_requested_at).toBeTruthy();
    expect(byId["t-running"].status).toBe("active");
    expect(byId["t-paused"].status).toBe("active");
    expect(byId["t-paused"].paused).toBe(1);
    expect(byId["t-done"].status).toBe("settled");
    expect(byId["t-done"].settled_at).toBeTruthy();
    expect(byId["t-failed"].status).toBe("settled");
    expect(byId["t-rt"].mode).toBe("conversational");
    expect(byId["t-running"].mode).toBe("workflow");

    // Dropped columns are gone.
    const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("task_type");
    expect(cols).not.toContain("iteration_count");
    expect(cols).toContain("mode");

    // The cascade child survived the rebuild.
    const kid = db.prepare("SELECT COUNT(*) AS c FROM task_kids WHERE task_id = 't-running'").get() as { c: number };
    expect(kid.c).toBe(1);

    // Idempotent: re-init is a no-op.
    initializeDatabase(db);
    const again = db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number };
    expect(again.c).toBe(7);
  });
});

describe("migrateTasksArchivedToSettled", () => {
  it("renames the archived vocabulary on a DB unified by an earlier build", () => {
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");

    // The unified shape as an earlier build wrote it: 'archived' + archived_at.
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        team_id TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
        mode TEXT NOT NULL DEFAULT 'workflow' CHECK (mode IN ('workflow', 'conversational')),
        paused INTEGER NOT NULL DEFAULT 0,
        current_phase INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        orchestration_state TEXT NOT NULL DEFAULT '{}',
        regression_count INTEGER NOT NULL DEFAULT 0,
        needs_review INTEGER NOT NULL DEFAULT 0,
        working_directory TEXT NOT NULL DEFAULT '',
        task_config TEXT NOT NULL DEFAULT '{}',
        source_scheduled_task_id TEXT,
        run_input TEXT,
        wake_requested_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        approved_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        archived_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec("INSERT INTO tasks (id, title, status) VALUES ('t-active', 'Active', 'active')");
    db.exec("INSERT INTO tasks (id, title, status, result, archived_at) VALUES ('t-done', 'Done', 'archived', '{\"output\":1}', '2026-09-01 04:34:09')");
    db.exec("INSERT INTO tasks (id, title, status, result, archived_at) VALUES ('t-failed', 'Failed', 'archived', '{\"error\":\"x\"}', '2026-09-01 04:34:09')");

    initializeDatabase(db);

    const rows = db.prepare("SELECT id, status, settled_at FROM tasks ORDER BY id").all() as Array<{
      id: string; status: string; settled_at: string | null;
    }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["t-active"].status).toBe("active");
    expect(byId["t-done"].status).toBe("settled");
    expect(byId["t-done"].settled_at).toBe("2026-09-01 04:34:09");
    expect(byId["t-failed"].status).toBe("settled");

    const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("archived_at");
    expect(cols).toContain("settled_at");

    // The new CHECK accepts 'settled' and rejects 'archived'.
    expect(() => db.exec("UPDATE tasks SET status = 'archived' WHERE id = 't-done'")).toThrow();

    // Idempotent: re-init is a no-op.
    initializeDatabase(db);
    expect((db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c).toBe(3);
  });
});
