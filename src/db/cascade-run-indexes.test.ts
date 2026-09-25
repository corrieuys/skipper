import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "./connection";
import { assetTextSync } from "../assets";

// migrations/0028_cascade_and_run_indexes.sql: indexes behind the task-delete
// cascade and the recurring-run reads, and the redundant receipts index dropped.

const NEW_INDEXES = [
  "idx_agent_note_receipts_note",
  "idx_task_artifact_refs_input_stream",
  "idx_task_checkpoints_task_seq",
  "idx_tasks_source_scheduled",
];
const DROPPED = "idx_agent_note_receipts_instance";

let db: Database;

afterEach(() => {
  try { db.close(); } catch {}
});

function indexNames(database: Database): Set<string> {
  return new Set(
    (database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name),
  );
}

function plan(sql: string): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(" | ");
}

describe("cascade and recurring-run indexes", () => {
  it("a fresh DB gets the indexes and not the redundant receipts index", () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const names = indexNames(db);
    for (const name of NEW_INDEXES) expect(names.has(name)).toBe(true);
    expect(names.has(DROPPED)).toBe(false);
  });

  it("an existing DB from before 0028 gets them on the next init, rows kept", () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    db.prepare("INSERT INTO tasks (id, title, status, source_scheduled_task_id) VALUES ('run-1', 'Run', 'settled', 'series-1')").run();
    // Put the DB back in its pre-0028 shape.
    for (const name of NEW_INDEXES) db.exec(`DROP INDEX ${name}`);
    db.exec(`CREATE INDEX ${DROPPED} ON agent_note_receipts(agent_instance_id)`);
    db.exec("DELETE FROM schema_version WHERE version = 28");

    initializeDatabase(db);

    const names = indexNames(db);
    for (const name of NEW_INDEXES) expect(names.has(name)).toBe(true);
    expect(names.has(DROPPED)).toBe(false);
    expect(db.prepare("SELECT 1 FROM schema_version WHERE version = 28").get()).not.toBeNull();
    expect((db.prepare("SELECT title FROM tasks WHERE id = 'run-1'").get() as { title: string }).title).toBe("Run");
  });

  it("the runtime schema applies over a tasks table that predates source_scheduled_task_id", () => {
    // The runtime schema runs before legacy-migrations adds the column, so an
    // index on it in that file would fail the boot of an old DB.
    db = new Database(":memory:");
    db.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    expect(() => db.exec(assetTextSync("db/schema.runtime.sql"))).not.toThrow();
    const names = indexNames(db);
    expect(names.has("idx_task_checkpoints_task_seq")).toBe(true);
    expect(names.has("idx_agent_note_receipts_note")).toBe(true);
    expect(names.has("idx_task_artifact_refs_input_stream")).toBe(true);
    expect(names.has(DROPPED)).toBe(false);
  });

  it("the hot queries use them", () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    // writeCheckpoint's next sequence (agents/manager.ts, orchestrator/recovery-manager.ts).
    expect(plan("SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq FROM task_checkpoints WHERE task_id = 't'"))
      .toContain("idx_task_checkpoints_task_seq");
    // The child lookups a task delete cascades into.
    expect(plan("SELECT 1 FROM task_checkpoints WHERE task_id = 't'")).toContain("idx_task_checkpoints_task_seq");
    expect(plan("DELETE FROM agent_note_receipts WHERE note_id = 'n'")).toContain("idx_agent_note_receipts_note");
    expect(plan("UPDATE task_artifact_refs SET input_stream_id = NULL WHERE input_stream_id = 's'"))
      .toContain("idx_task_artifact_refs_input_stream");
    // Lookups by instance still have the primary key after the drop.
    expect(plan("DELETE FROM agent_note_receipts WHERE agent_instance_id IN ('a', 'b')"))
      .toContain("sqlite_autoindex_agent_note_receipts_1");
    expect(plan("SELECT note_id FROM agent_note_receipts WHERE agent_instance_id = 'a'"))
      .toContain("sqlite_autoindex_agent_note_receipts_1");
    // The sidebar run strip (data/command-center.ts:fetchRecentScheduledRuns) and a series' run list.
    expect(plan(`SELECT id FROM (
        SELECT t.id, ROW_NUMBER() OVER (PARTITION BY t.source_scheduled_task_id ORDER BY t.created_at DESC) AS rn
        FROM tasks t WHERE t.source_scheduled_task_id IS NOT NULL) WHERE rn <= 5`))
      .toContain("idx_tasks_source_scheduled");
    expect(plan("SELECT id FROM tasks WHERE source_scheduled_task_id = 's' ORDER BY created_at DESC LIMIT 20"))
      .toContain("idx_tasks_source_scheduled");
  });
});
