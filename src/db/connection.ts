import { Database } from "bun:sqlite";
import { dirname } from "path";
import { mkdirSync } from "fs";
import { loadConfigSnapshotIntoDb, loadRealtimeDefaultsIntoDb } from "../config/store";
import { flattenLocalTeamsIntoStore } from "../teams/local-teams";
import { getRuntimeDbPath, migrateLegacyDbIfNeeded } from "../paths";
import { migrateLegacySchema, tableExists } from "./legacy-migrations";
import { assetTextSync, listAssets } from "../assets";

// Schema + migrations are embedded assets (see scripts/gen-assets.ts) so the
// compiled binary carries them; logical paths mirror src/db/*.sql on disk.
const MONOLITH_SCHEMA = "db/schema.sql";
const CONFIG_SCHEMA = "db/schema.config.sql";
const RUNTIME_SCHEMA = "db/schema.runtime.sql";

const IN_MEMORY_DB = ":memory:";

type DbMode = "none" | "single" | "split";

let mode: DbMode = "none";
let db: Database | null = null;
let runtimeDbPath: string = "";

const RUNTIME_TABLES = [
  "tasks",
  "task_checkpoints",
  "agent_states",
  "agent_sessions",
  "terminal_outputs",
  "delegations",
  "task_notes",
  "escalations",
  "manager_runs",
  "stuck_detection_logs",
  "events",
  "agent_instances",
  "delegation_groups",
  "daemon_state",
  "error_log",
  "task_artifacts",
  "task_input_streams",
  "task_windows",
  "task_artifact_refs",
  "realtime_config",
  "realtime_timeline",
  "realtime_pipeline_state",
  "agent_note_receipts",
  "conversations",
  "conversation_messages",
  "task_templates",
  "task_template_phases",
  "notification_preferences",
  "app_settings",
  "api_keys",
  "local_teams",
];

function configureDatabase(database: Database): void {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
}

function ensureParentDir(path: string): void {
  if (path === ":memory:") return;
  const dir = dirname(path);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
}

function runSchema(database: Database, schemaAsset: string): void {
  const schema = assetTextSync(schemaAsset);
  database.exec(schema);
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function ensureSharedAttached(runtimeDb: Database): void {
  const rows = runtimeDb.prepare("PRAGMA database_list").all() as { name: string }[];
  const alreadyAttached = rows.some((row) => row.name === "shared");
  if (alreadyAttached) return;
  runtimeDb.exec(`ATTACH DATABASE '${escapeSqlString(IN_MEMORY_DB)}' AS shared`);
}

function runSharedConfigSchema(runtimeDb: Database): void {
  const schema = assetTextSync(CONFIG_SCHEMA);
  const rewritten = schema
    .replace(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g, "CREATE TABLE IF NOT EXISTS shared.$1");
  runtimeDb.exec(rewritten);
}

const SHARED_TABLES = ["agent_types", "agents", "teams", "team_agents", "skipper_config"] as const;

// Compiled once — rewriteSqlForSplit runs on every prepare()/exec() in split mode.
const SPLIT_REWRITE_RULES: Array<[RegExp, string]> = SHARED_TABLES.flatMap((table) => [
  [new RegExp(`\\bFROM\\s+${table}\\b`, "gi"), `FROM shared.${table}`],
  [new RegExp(`\\bJOIN\\s+${table}\\b`, "gi"), `JOIN shared.${table}`],
  [new RegExp(`\\bINTO\\s+${table}\\b`, "gi"), `INTO shared.${table}`],
  [new RegExp(`\\bUPDATE\\s+${table}\\b`, "gi"), `UPDATE shared.${table}`],
  [new RegExp(`\\bDELETE\\s+FROM\\s+${table}\\b`, "gi"), `DELETE FROM shared.${table}`],
] as Array<[RegExp, string]>);

function rewriteSqlForSplit(sql: string): string {
  let rewritten = sql;
  for (const [pattern, replacement] of SPLIT_REWRITE_RULES) {
    rewritten = rewritten.replace(pattern, replacement);
  }
  return rewritten;
}

function installSplitSqlRouting(runtimeDb: Database): void {
  const routedDb = runtimeDb as Database & { __splitRouted?: boolean };
  if (routedDb.__splitRouted) return;

  const originalPrepare = runtimeDb.prepare.bind(runtimeDb);
  const originalExec = runtimeDb.exec.bind(runtimeDb);
  routedDb.prepare = (sql: string) => originalPrepare(rewriteSqlForSplit(sql));
  routedDb.exec = (sql: string) => originalExec(rewriteSqlForSplit(sql));
  routedDb.__splitRouted = true;
}

function resetLegacyRuntimeSchema(runtimeDb: Database): void {
  const sharedTableSet = new Set(["agent_types", "agents", "teams", "team_agents"]);
  const hasLegacyConfigTables = Array.from(sharedTableSet)
    .some((table) => tableExists(runtimeDb, table));
  let hasSharedTableForeignKeys = false;
  if (!hasLegacyConfigTables) {
    for (const table of RUNTIME_TABLES) {
      if (!tableExists(runtimeDb, table)) continue;
      const fks = runtimeDb.prepare(`PRAGMA foreign_key_list(${table})`).all() as { table: string }[];
      if (fks.some((fk) => sharedTableSet.has(fk.table))) {
        hasSharedTableForeignKeys = true;
        break;
      }
    }
  }

  if (!hasLegacyConfigTables && !hasSharedTableForeignKeys) return;

  runtimeDb.exec("PRAGMA foreign_keys = OFF");
  try {
    // Never drop runtime tables automatically. Only remove legacy config tables
    // that may have been created in monolith mode inside the runtime DB file.
    if (hasLegacyConfigTables) {
      for (const table of sharedTableSet) {
        if (tableExists(runtimeDb, table)) {
          runtimeDb.exec(`DROP TABLE IF EXISTS ${table}`);
        }
      }
    }
  } finally {
    runtimeDb.exec("PRAGMA foreign_keys = ON");
  }
}

function initializeSplitDatabases(runtimeDb: Database): void {
  resetLegacyRuntimeSchema(runtimeDb);
  runSchema(runtimeDb, RUNTIME_SCHEMA);
  migrateLegacySchema(runtimeDb);
  applyVersionedMigrations(runtimeDb);

  // Shared config tables live in an in-memory attached DB; the JSON files in
  // config/*.json are the source of truth and are loaded here once at boot.
  ensureSharedAttached(runtimeDb);
  runSharedConfigSchema(runtimeDb);
  // Register teams into the in-memory store Maps before seeding the shared.*
  // tables, so the snapshot below already includes them.
  flattenLocalTeamsIntoStore(runtimeDb);
  loadConfigSnapshotIntoDb(runtimeDb, "shared");
  loadRealtimeDefaultsIntoDb(runtimeDb);
  installSplitSqlRouting(runtimeDb);
}

function initializeSingleDatabase(database: Database): void {
  migrateLegacySchema(database);
  runSchema(database, MONOLITH_SCHEMA);
  migrateLegacySchema(database);
  applyVersionedMigrations(database);
  flattenLocalTeamsIntoStore(database);
  loadConfigSnapshotIntoDb(database, "main");
  loadRealtimeDefaultsIntoDb(database);
}

/**
 * Apply numbered SQL migrations from src/db/migrations/ in order.
 * Each filename starts with a 4-digit version (e.g. `0001_add_index.sql`).
 * Already-applied versions are skipped via the `schema_version` table.
 */
function applyVersionedMigrations(database: Database): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );

  const files = listAssets("db/migrations/")
    .map((logical) => logical.slice("db/migrations/".length))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();

  if (files.length === 0) return;

  const appliedRows = database
    .prepare("SELECT version FROM schema_version")
    .all() as { version: number }[];
  const applied = new Set(appliedRows.map((r) => r.version));

  const recordStmt = database.prepare(
    "INSERT OR IGNORE INTO schema_version (version) VALUES (?)",
  );

  for (const file of files) {
    const version = parseInt(file.slice(0, 4), 10);
    if (Number.isNaN(version) || applied.has(version)) continue;
    const sql = assetTextSync(`db/migrations/${file}`);
    database.exec("BEGIN");
    try {
      database.exec(sql);
      recordStmt.run(version);
      database.exec("COMMIT");
    } catch (err) {
      database.exec("ROLLBACK");
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("duplicate column name")) {
        recordStmt.run(version);
        continue;
      }
      throw new Error(`Migration ${file} failed: ${msg}`);
    }
  }
}

export function getDb(dbPath?: string): Database {
  if (db) return db;

  if (typeof dbPath === "string") {
    mode = "single";
    db = new Database(dbPath);
    configureDatabase(db);
    return db;
  }

  mode = "split";
  const moved = migrateLegacyDbIfNeeded();
  if (moved.migrated) {
    console.log(`[skipper] Relocated runtime DB: ${moved.from} -> ${moved.to}. Original left in place; delete when ready.`);
  }
  runtimeDbPath = getRuntimeDbPath();

  ensureParentDir(runtimeDbPath);

  db = new Database(runtimeDbPath);
  configureDatabase(db);

  return db;
}

export function initializeDatabase(database?: Database): void {
  if (database) {
    initializeSingleDatabase(database);
    return;
  }

  const activeDb = getDb();
  if (mode === "single") {
    initializeSingleDatabase(activeDb);
    return;
  }

  initializeSplitDatabases(activeDb);
}

export function closeDb(): void {
  if (db) {
    try {
      if (mode === "split") {
        db.exec("DETACH DATABASE shared");
      }
    } catch {
      // best effort detach
    }
    db.close();
    db = null;
  }

  mode = "none";
}

export function resetDb(): void {
  closeDb();
}
