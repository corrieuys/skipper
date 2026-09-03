import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "./connection";
import { unlinkSync } from "fs";

const TEST_DB = "test-file-artifacts-migration.db";
let db: Database;

afterEach(() => {
  try { db.close(); } catch {}
  try { unlinkSync(TEST_DB); } catch {}
});

function columns(database: Database, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

describe("file artifact migrations", () => {
  it("rebuilds an old-shape task_artifacts + realtime_timeline into the file-artifact shape, keeping rows, indexes and FK children", () => {
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");

    // Pre-create the OLD tables (no storage/mime columns, CHECKs without
    // 'upload' / 'image'), plus a child table referencing task_artifacts so the
    // rebuild is proven not to cascade-delete it.
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'settled')),
        mode TEXT NOT NULL DEFAULT 'workflow',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE task_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        kind TEXT NOT NULL CHECK (kind IN ('transcript', 'summary', 'plan', 'other')),
        description TEXT,
        body TEXT NOT NULL,
        created_by_agent_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(task_id, name, version)
      );
      CREATE INDEX idx_task_artifacts_task_kind ON task_artifacts(task_id, kind, created_at);
      CREATE TABLE artifact_kids (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES task_artifacts(id) ON DELETE CASCADE
      );
      CREATE TABLE realtime_timeline (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        entry_type TEXT NOT NULL CHECK (entry_type IN ('summary', 'text', 'error')),
        content TEXT NOT NULL,
        source_segment_ids TEXT NOT NULL DEFAULT '[]',
        fed_to_skipper INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec("INSERT INTO tasks (id, title, status) VALUES ('t1', 'T', 'active')");
    db.exec("INSERT INTO task_artifacts (id, task_id, name, version, kind, description, body, created_by_agent_id) VALUES ('a1', 't1', 'plan', 1, 'plan', 'd', 'body one', 'agent-x')");
    db.exec("INSERT INTO task_artifacts (id, task_id, name, version, kind, body) VALUES ('a2', 't1', 'plan', 2, 'plan', 'body two')");
    db.exec("INSERT INTO artifact_kids (id, artifact_id) VALUES ('r1', 'a1')");
    db.exec("INSERT INTO realtime_timeline (id, task_id, entry_type, content, fed_to_skipper) VALUES ('e1', 't1', 'text', 'hello', 1)");

    initializeDatabase(db);

    // Columns added
    const artifactCols = columns(db, "task_artifacts");
    for (const c of ["storage", "mime", "bytes", "sha256", "width", "height", "source", "publish_key", "published_at", "format", "deleted_at"]) {
      expect(artifactCols).toContain(c);
    }
    expect(columns(db, "realtime_timeline")).toContain("artifact_id");
    expect(columns(db, "realtime_timeline")).toContain("priority");

    // Rows preserved
    const rows = db.prepare("SELECT id, version, body, storage, created_by_agent_id FROM task_artifacts ORDER BY version").all() as Record<string, unknown>[];
    expect(rows).toEqual([
      { id: "a1", version: 1, body: "body one", storage: "inline", created_by_agent_id: "agent-x" },
      { id: "a2", version: 2, body: "body two", storage: "inline", created_by_agent_id: null },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM artifact_kids").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT content, fed_to_skipper, priority FROM realtime_timeline WHERE id = 'e1'").get()).toEqual({ content: "hello", fed_to_skipper: 1, priority: "normal" });

    // New CHECK values accepted
    expect(() => db.exec("INSERT INTO task_artifacts (id, task_id, name, version, kind, body, storage, mime) VALUES ('a3', 't1', 'x.png', 1, 'upload', '', 'file', 'image/png')")).not.toThrow();
    expect(() => db.exec("INSERT INTO realtime_timeline (id, task_id, entry_type, content, artifact_id) VALUES ('e2', 't1', 'image', 'x.png', 'a3')")).not.toThrow();
    expect(() => db.exec("INSERT INTO realtime_timeline (id, task_id, entry_type, content) VALUES ('e3', 't1', 'file', 'y.pdf')")).not.toThrow();
    expect(() => db.exec("INSERT INTO realtime_timeline (id, task_id, entry_type, content) VALUES ('e4', 't1', 'bogus', 'no')")).toThrow();
    expect(() => db.exec("INSERT INTO task_artifacts (id, task_id, name, version, kind, body) VALUES ('a4', 't1', 'y', 1, 'bogus', '')")).toThrow();

    // Indexes recreated; unique constraint intact
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_artifacts'").all() as { name: string }[]).map((i) => i.name);
    expect(indexes).toContain("idx_task_artifacts_task_kind");
    expect(indexes).toContain("idx_task_artifacts_task_name_latest");
    const tlIndexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'realtime_timeline'").all() as { name: string }[]).map((i) => i.name);
    expect(tlIndexes).toContain("idx_realtime_timeline_task_fed");
    expect(() => db.exec("INSERT INTO task_artifacts (id, task_id, name, version, kind, body) VALUES ('dup', 't1', 'plan', 1, 'plan', '')")).toThrow();

    // Idempotent: a second init leaves the rebuilt shape alone
    const sqlBefore = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'task_artifacts'").get();
    initializeDatabase(db);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'task_artifacts'").get()).toEqual(sqlBefore);
    expect(db.prepare("SELECT COUNT(*) AS c FROM task_artifacts").get()).toEqual({ c: 3 });
  });

  it("is a no-op on a fresh schema", () => {
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'task_artifacts'").get() as { sql: string }).sql;
    expect(sql).toContain("'upload'");
    expect(sql).toContain("storage TEXT NOT NULL DEFAULT 'inline'");
    const tl = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'realtime_timeline'").get() as { sql: string }).sql;
    expect(tl).toContain("'image'");
    expect(tl).toContain("artifact_id");
  });
});
