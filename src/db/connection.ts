import { Database } from "bun:sqlite";
import { dirname, resolve } from "path";
import { mkdirSync, readFileSync, readdirSync, existsSync } from "fs";
import { loadConfigSnapshotIntoDb, loadRealtimeDefaultsIntoDb } from "../config/store";
import { flattenLocalTeamsIntoStore } from "../teams/local-teams";
import { getRuntimeDbPath, migrateLegacyDbIfNeeded } from "../paths";

const MONOLITH_SCHEMA_PATH = resolve(import.meta.dir, "schema.sql");
const CONFIG_SCHEMA_PATH = resolve(import.meta.dir, "schema.config.sql");
const RUNTIME_SCHEMA_PATH = resolve(import.meta.dir, "schema.runtime.sql");
const MIGRATIONS_DIR = resolve(import.meta.dir, "migrations");

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

function tableExists(database: Database, tableName: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName) as { name: string } | null;
  return !!row;
}

function runSchema(database: Database, schemaPath: string): void {
  const schema = readFileSync(schemaPath, "utf-8");
  database.exec(schema);
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function migrateLegacySchema(database: Database): void {
  // Migrate chat agent from conversation-skipper type to claude-code
  try {
    database.prepare("UPDATE agents SET type = 'claude-code' WHERE type = 'conversation-skipper'").run();
  } catch { /* table may not exist yet */ }

  ensureColumn(database, "terminal_outputs", "session_id", "TEXT");
  ensureColumn(database, "task_checkpoints", "session_id", "TEXT");
  ensureColumn(database, "agent_types", "resume_args", "TEXT");
  ensureColumn(database, "delegations", "parent_instance_id", "TEXT");
  ensureColumn(database, "delegations", "child_instance_id", "TEXT");
  ensureColumn(database, "delegations", "delegation_group_id", "TEXT");
  ensureColumn(database, "escalations", "runtime_agent_id", "TEXT");
  ensureColumn(database, "agents", "model", "TEXT NOT NULL DEFAULT 'default'");
  ensureColumn(database, "agents", "config", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(database, "agents", "status", "TEXT NOT NULL DEFAULT 'idle'");
  ensureColumn(database, "agents", "process_pid", "INTEGER");
  ensureColumn(database, "agents", "current_task_id", "TEXT");
  ensureColumn(database, "agents", "created_at", "TEXT DEFAULT ''");
  ensureColumn(database, "agents", "updated_at", "TEXT DEFAULT ''");
  ensureColumn(database, "teams", "created_at", "TEXT DEFAULT ''");
  ensureColumn(database, "teams", "updated_at", "TEXT DEFAULT ''");
  ensureColumn(database, "teams", "phases", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "teams", "goal", "TEXT");
  ensureColumn(database, "tasks", "iteration_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "tasks", "task_type", "TEXT NOT NULL DEFAULT 'standard'");
  ensureColumn(database, "tasks", "task_config", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(database, "tasks", "needs_review", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "task_input_streams", "transcription_status", "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn(database, "task_input_streams", "transcribed_text", "TEXT");
  ensureColumn(database, "task_input_streams", "summary_batch_id", "TEXT");
  ensureColumn(database, "task_notes", "source", "TEXT NOT NULL DEFAULT 'agent'");
  ensureColumn(database, "tasks", "working_directory", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "agent_states", "last_signal_at", "TEXT");
  ensureColumn(database, "conversation_messages", "parts", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "conversations", "system_prompt", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "conversations", "permission_mode", "TEXT NOT NULL DEFAULT 'bypassPermissions'");
  ensureColumn(database, "task_templates", "hooks", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "task_template_phases", "override_prompt", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "task_template_phases", "review_override", "TEXT DEFAULT NULL");
  ensureColumn(database, "task_template_phases", "consensus_override", "TEXT DEFAULT NULL");
  ensureColumn(database, "tasks", "source_scheduled_task_id", "TEXT");
  ensureColumn(database, "agent_instances", "input_tokens", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "agent_instances", "output_tokens", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "agent_instances", "cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "agent_instances", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0");
  migrateAgentConfigGoalToInstruction(database);
  migrateTeamAgentsDropSkills(database);
  migrateTeamAgentsDropMaxComplexity(database);
  migrateTaskNotesMillisecondTimestamps(database);
  migrateScheduledTasksOptionalInterval(database);
  migrateTasksAddPausedStatus(database);
}

// Add 'paused' to the tasks.status CHECK so a running task can be paused
// (agents stopped at a point in time, resumable). SQLite can't ALTER a CHECK,
// so rebuild the table. Runs only when the existing CHECK lacks 'paused';
// fresh DBs already include it via schema.runtime.sql. FK must be OFF during
// the rebuild — otherwise DROP TABLE tasks implicitly deletes all rows and
// cascades to children (checkpoints, instances, events, …).
function migrateTasksAddPausedStatus(database: Database): void {
  if (!tableExists(database, "tasks")) return;
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'")
    .get() as { sql: string } | null;
  if (!row || row.sql.includes("'paused'")) return; // already migrated

  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS tasks_new (
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        approved_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    database.exec(`
      INSERT INTO tasks_new (id, title, description, team_id, status, current_phase,
        result, orchestration_state, regression_count, iteration_count, needs_review,
        working_directory, task_type, task_config, source_scheduled_task_id,
        created_at, approved_at, started_at, completed_at, updated_at)
      SELECT id, title, description, team_id, status, current_phase,
        result, orchestration_state, regression_count, iteration_count, needs_review,
        working_directory, task_type, task_config, source_scheduled_task_id,
        created_at, approved_at, started_at, completed_at, updated_at FROM tasks;
    `);
    database.exec("DROP TABLE tasks;");
    database.exec("ALTER TABLE tasks_new RENAME TO tasks;");
    database.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);");
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

// Relax schedule_unit/schedule_amount from NOT NULL to nullable so a recurring
// task can have no interval (manual-only: never auto-fires, only "Run Now").
// SQLite can't ALTER a column's NOT NULL, so rebuild the table. Runs only when
// the existing column is still NOT NULL; fresh DBs already create it nullable.
function migrateScheduledTasksOptionalInterval(database: Database): void {
  if (!tableExists(database, "scheduled_tasks")) return;
  const cols = database
    .prepare("PRAGMA table_info(scheduled_tasks)")
    .all() as Array<{ name: string; notnull: number }>;
  const unit = cols.find((c) => c.name === "schedule_unit");
  if (!unit || unit.notnull === 0) return; // already nullable

  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks_new (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        team_id TEXT,
        working_directory TEXT NOT NULL DEFAULT '',
        schedule_unit TEXT CHECK (schedule_unit IS NULL OR schedule_unit IN ('minutes', 'hours', 'days')),
        schedule_amount INTEGER,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
        task_config TEXT NOT NULL DEFAULT '{}',
        next_run_at TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    database.exec(`
      INSERT INTO scheduled_tasks_new (id, title, description, team_id, working_directory,
        schedule_unit, schedule_amount, status, task_config, next_run_at, last_run_at,
        created_at, updated_at)
      SELECT id, title, description, team_id, working_directory,
        schedule_unit, schedule_amount, status, task_config, next_run_at, last_run_at,
        created_at, updated_at FROM scheduled_tasks;
    `);
    database.exec("DROP TABLE scheduled_tasks;");
    database.exec("ALTER TABLE scheduled_tasks_new RENAME TO scheduled_tasks;");
    database.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status_next ON scheduled_tasks(status, next_run_at);");
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

// Upgrade task_notes.created_at default from second-resolution datetime('now')
// to millisecond-resolution strftime('%f', 'now'). Existing rows keep their
// second-precision timestamps; only new inserts that rely on the column
// default get the higher precision. The tiebreaker is the id column at query
// time, so old rows still sort deterministically against each other.
function migrateTaskNotesMillisecondTimestamps(database: Database): void {
  if (!tableExists(database, "task_notes")) return;
  const cols = database.prepare("PRAGMA table_info(task_notes)").all() as Array<{ name: string; dflt_value: string | null }>;
  const created = cols.find((c) => c.name === "created_at");
  if (!created) return;
  // SQLite reports the default verbatim (including the surrounding `( ... )`)
  const def = (created.dflt_value ?? "").toLowerCase();
  if (def.includes("strftime")) return; // already upgraded
  if (!def.includes("datetime('now')")) return; // unknown default — leave alone

  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS task_notes_new (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'agent',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
      );
    `);
    const hasSource = cols.some((c) => c.name === "source");
    if (hasSource) {
      database.exec(`
        INSERT INTO task_notes_new (id, task_id, agent_id, content, source, created_at)
        SELECT id, task_id, agent_id, content, source, created_at FROM task_notes;
      `);
    } else {
      database.exec(`
        INSERT INTO task_notes_new (id, task_id, agent_id, content, created_at)
        SELECT id, task_id, agent_id, content, created_at FROM task_notes;
      `);
    }
    database.exec("DROP TABLE task_notes;");
    database.exec("ALTER TABLE task_notes_new RENAME TO task_notes;");
    database.exec("CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes(task_id, created_at);");
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

function ensureColumn(
  database: Database,
  tableName: string,
  columnName: string,
  columnDef: string,
): void {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | null;

  if (!table) return;

  const cols = database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as { name: string }[];

  const hasColumn = cols.some((col) => col.name === columnName);
  if (hasColumn) return;

  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
}

function hasColumn(database: Database, tableName: string, columnName: string): boolean {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | null;
  if (!table) return false;

  const cols = database.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  return cols.some((col) => col.name === columnName);
}

function migrateTeamAgentsDropSkills(database: Database): void {
  if (!hasColumn(database, "team_agents", "skills")) return;

  const carryMaxComplexity = hasColumn(database, "team_agents", "max_complexity");

  database.exec("PRAGMA foreign_keys = OFF");
  try {
    const newTableCols = carryMaxComplexity
      ? `id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        role TEXT,
        level INTEGER NOT NULL DEFAULT 0,
        parent_agent_id TEXT REFERENCES agents(id),
        max_complexity INTEGER DEFAULT 10,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(team_id, agent_id)`
      : `id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        role TEXT,
        level INTEGER NOT NULL DEFAULT 0,
        parent_agent_id TEXT REFERENCES agents(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(team_id, agent_id)`;
    database.exec(`CREATE TABLE IF NOT EXISTS team_agents_new (${newTableCols});`);
    const insertCols = carryMaxComplexity
      ? "id, team_id, agent_id, role, level, parent_agent_id, max_complexity, created_at"
      : "id, team_id, agent_id, role, level, parent_agent_id, created_at";
    database.exec(`
      INSERT INTO team_agents_new (${insertCols})
      SELECT ${insertCols}
      FROM team_agents;
    `);
    database.exec("DROP TABLE team_agents;");
    database.exec("ALTER TABLE team_agents_new RENAME TO team_agents;");
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateTeamAgentsDropMaxComplexity(database: Database): void {
  if (!tableExists(database, "team_agents")) return;
  if (!hasColumn(database, "team_agents", "max_complexity")) return;

  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS team_agents_new (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        role TEXT,
        level INTEGER NOT NULL DEFAULT 0,
        parent_agent_id TEXT REFERENCES agents(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(team_id, agent_id)
      );
    `);
    database.exec(`
      INSERT INTO team_agents_new (id, team_id, agent_id, role, level, parent_agent_id, created_at)
      SELECT id, team_id, agent_id, role, level, parent_agent_id, created_at
      FROM team_agents;
    `);
    database.exec("DROP TABLE team_agents;");
    database.exec("ALTER TABLE team_agents_new RENAME TO team_agents;");
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateAgentConfigGoalToInstruction(database: Database): void {
  if (!tableExists(database, "agents") || !hasColumn(database, "agents", "config")) return;

  database.exec(`
    UPDATE agents
       SET config = json_remove(
         CASE
           WHEN json_type(config, '$.instruction') IS NULL
             THEN json_set(config, '$.instruction', json_extract(config, '$.goal'))
           ELSE config
         END,
         '$.goal'
       )
     WHERE json_valid(config)
       AND json_type(config, '$.goal') IS NOT NULL;
  `);
}

function ensureSharedAttached(runtimeDb: Database): void {
  const rows = runtimeDb.prepare("PRAGMA database_list").all() as { name: string }[];
  const alreadyAttached = rows.some((row) => row.name === "shared");
  if (alreadyAttached) return;
  runtimeDb.exec(`ATTACH DATABASE '${escapeSqlString(IN_MEMORY_DB)}' AS shared`);
}

function runSharedConfigSchema(runtimeDb: Database): void {
  const schema = readFileSync(CONFIG_SCHEMA_PATH, "utf-8");
  const rewritten = schema
    .replace(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g, "CREATE TABLE IF NOT EXISTS shared.$1");
  runtimeDb.exec(rewritten);
}

const SHARED_TABLES = ["agent_types", "agents", "teams", "team_agents", "skipper_config"] as const;

function rewriteSqlForSplit(sql: string): string {
  let rewritten = sql;
  for (const table of SHARED_TABLES) {
    rewritten = rewritten
      .replace(new RegExp(`\\bFROM\\s+${table}\\b`, "gi"), `FROM shared.${table}`)
      .replace(new RegExp(`\\bJOIN\\s+${table}\\b`, "gi"), `JOIN shared.${table}`)
      .replace(new RegExp(`\\bINTO\\s+${table}\\b`, "gi"), `INTO shared.${table}`)
      .replace(new RegExp(`\\bUPDATE\\s+${table}\\b`, "gi"), `UPDATE shared.${table}`)
      .replace(new RegExp(`\\bDELETE\\s+FROM\\s+${table}\\b`, "gi"), `DELETE FROM shared.${table}`);
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
  runSchema(runtimeDb, RUNTIME_SCHEMA_PATH);
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
  runSchema(database, MONOLITH_SCHEMA_PATH);
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

  if (!existsSync(MIGRATIONS_DIR)) return;

  const files = readdirSync(MIGRATIONS_DIR)
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
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8");
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
