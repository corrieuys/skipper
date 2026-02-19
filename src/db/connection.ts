import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";

const SCHEMA_PATH = resolve(import.meta.dir, "schema.sql");

let db: Database | null = null;

export function getDb(dbPath: string = "playhive.db"): Database {
  if (db) return db;

  db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  return db;
}

export function initializeDatabase(database: Database): void {
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  database.exec(schema);
  seedAgentTypes(database);
}

function seedAgentTypes(database: Database): void {
  const insert = database.prepare(`
    INSERT OR IGNORE INTO agent_types (name, command, args, model_flag, available_models, env_vars, supports_stdin, supports_resume, resume_flag)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    "claude-code",
    "claude",
    JSON.stringify(["--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]),
    "--model",
    JSON.stringify(["opus", "sonnet", "haiku"]),
    JSON.stringify({ ANTHROPIC_MODEL: "$MODEL" }),
    0,
    1,
    "--resume"
  );

  insert.run(
    "codex",
    "codex",
    JSON.stringify(["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "-"]),
    null,
    JSON.stringify(["default"]),
    JSON.stringify({}),
    0,
    1,
    "exec resume"
  );

  insert.run(
    "custom",
    "",
    JSON.stringify([]),
    null,
    JSON.stringify([]),
    JSON.stringify({}),
    0,
    0,
    null
  );
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function resetDb(): void {
  db = null;
}
