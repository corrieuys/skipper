import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "./connection";
import { unlinkSync } from "fs";

const TEST_DB = "test-paused-migration.db";
let db: Database;

afterEach(() => {
  try { db.close(); } catch {}
  try { unlinkSync(TEST_DB); } catch {}
});

describe("migrateTasksAddPausedStatus", () => {
  it("adds 'paused' to an existing tasks CHECK without losing child rows", () => {
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");

    // Pre-create the OLD tasks table (CHECK without 'paused') plus a child table
    // referencing it ON DELETE CASCADE, so we can prove the rebuild doesn't wipe
    // children via an implicit cascade.
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        team_id TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'running', 'completed', 'failed')),
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        approved_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec("INSERT INTO tasks (id, title, status) VALUES ('t-1', 'Existing', 'running')");
    db.exec(`
      CREATE TABLE task_kids (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
      );
    `);
    db.exec("INSERT INTO task_kids (id, task_id) VALUES ('k-1', 't-1')");

    // Old CHECK rejects 'paused'.
    expect(() => db.exec("UPDATE tasks SET status = 'paused' WHERE id = 't-1'")).toThrow();

    // Run init → migrateLegacySchema → migrateTasksAddPausedStatus rebuilds tasks.
    initializeDatabase(db);

    // 'paused' now accepted.
    db.exec("UPDATE tasks SET status = 'paused' WHERE id = 't-1'");
    const row = db.prepare("SELECT status FROM tasks WHERE id = 't-1'").get() as { status: string };
    expect(row.status).toBe("paused");

    // The existing task row and its cascade child both survived the rebuild.
    const kid = db.prepare("SELECT COUNT(*) AS c FROM task_kids WHERE task_id = 't-1'").get() as { c: number };
    expect(kid.c).toBe(1);
  });
});
