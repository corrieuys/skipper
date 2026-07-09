import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getDataDir } from "../paths";

// Greg's chat DB is runtime state — lives in the data dir alongside the runtime
// DB (not next to the source/binary, which is read-only when compiled).
const DB_PATH = join(getDataDir(), "greg.db");

let db: Database | null = null;

export function getGregDb(): Database {
  if (db) return db;

  db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS monkey_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      request_type TEXT NOT NULL DEFAULT 'tick' CHECK (request_type IN ('tick', 'reply')),
      conversation_length INTEGER NOT NULL DEFAULT 0,
      response_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_monkey_usage_created ON monkey_usage(created_at);
  `);

  return db;
}

export function closeGregDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
