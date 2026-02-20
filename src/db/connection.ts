import { Database } from "bun:sqlite";
import { dirname, resolve } from "path";
import { mkdirSync, readFileSync } from "fs";

const MONOLITH_SCHEMA_PATH = resolve(import.meta.dir, "schema.sql");
const CONFIG_SCHEMA_PATH = resolve(import.meta.dir, "schema.config.sql");
const RUNTIME_SCHEMA_PATH = resolve(import.meta.dir, "schema.runtime.sql");

const DEFAULT_CONFIG_DB_PATH = process.env.PLAYHIVE_CONFIG_DB_PATH ?? "playhive.db";
const DEFAULT_RUNTIME_DB_PATH = process.env.PLAYHIVE_RUNTIME_DB_PATH ?? "playhive-runtime.db";

type DbMode = "none" | "single" | "split";

let mode: DbMode = "none";
let db: Database | null = null;
let configDb: Database | null = null;
let configDbPath: string = DEFAULT_CONFIG_DB_PATH;
let runtimeDbPath: string = DEFAULT_RUNTIME_DB_PATH;

const RUNTIME_TABLES = [
  "tasks",
  "task_checkpoints",
  "agent_states",
  "agent_sessions",
  "terminal_outputs",
  "delegations",
  "phase_regressions",
  "task_notes",
  "escalations",
  "messages",
  "manager_runs",
  "stuck_detection_logs",
  "agent_memories",
  "events",
  "artifacts",
  "daemon_state",
  "error_log",
  "cli_runtimes",
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
  ensureColumn(database, "terminal_outputs", "session_id", "TEXT");
  ensureColumn(database, "task_checkpoints", "session_id", "TEXT");
  ensureColumn(database, "agent_types", "resume_args", "TEXT");
  migrateAgentConfigGoalToInstruction(database);
  migrateTeamAgentsDropSkills(database);
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
        max_complexity INTEGER DEFAULT 10,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(team_id, agent_id)
      );
    `);
    database.exec(`
      INSERT INTO team_agents_new (id, team_id, agent_id, role, level, parent_agent_id, max_complexity, created_at)
      SELECT id, team_id, agent_id, role, level, parent_agent_id, max_complexity, created_at
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

function seedAgentTypes(database: Database): void {
  const insert = database.prepare(`
    INSERT OR IGNORE INTO agent_types (name, command, args, resume_args, model_flag, available_models, env_vars, supports_stdin, supports_resume, resume_flag)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    "claude-code",
    "claude",
    JSON.stringify(["--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]),
    null,
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
    JSON.stringify(["exec", "resume", "{{session_id}}", "--json", "--dangerously-bypass-approvals-and-sandbox", "-"]),
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
    null,
    JSON.stringify([]),
    JSON.stringify({}),
    0,
    0,
    null
  );

  database.prepare("UPDATE agent_types SET resume_args = NULL WHERE name = 'claude-code'").run();
  database.prepare(
    "UPDATE agent_types SET args = ?, resume_args = ?, supports_resume = 1, resume_flag = NULL WHERE name = 'codex'",
  ).run(
    JSON.stringify(["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "-"]),
    JSON.stringify(["exec", "resume", "{{session_id}}", "--json", "--dangerously-bypass-approvals-and-sandbox", "-"]),
  );
}

function ensureSharedAttached(runtimeDb: Database): void {
  const rows = runtimeDb.prepare("PRAGMA database_list").all() as { name: string }[];
  const alreadyAttached = rows.some((row) => row.name === "shared");
  if (alreadyAttached) return;
  runtimeDb.exec(`ATTACH DATABASE '${escapeSqlString(configDbPath)}' AS shared`);
}

const SHARED_TABLES = ["agent_types", "state_patterns", "agents", "teams", "team_agents"] as const;

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

function migrateLegacyMonolithData(runtimeDb: Database, sharedDb: Database): void {
  let hasLegacyRuntimeTables = false;
  for (const table of RUNTIME_TABLES) {
    if (tableExists(sharedDb, table)) {
      hasLegacyRuntimeTables = true;
      break;
    }
  }
  if (!hasLegacyRuntimeTables) return;

  // Ensure legacy DB has expected columns before copy.
  migrateLegacySchema(sharedDb);

  let copiedAny = false;
  let runtimeHadData = false;

  runtimeDb.exec("PRAGMA foreign_keys = OFF");
  try {
    for (const table of RUNTIME_TABLES) {
      if (!tableExists(sharedDb, table) || !tableExists(runtimeDb, table)) continue;
      const count = runtimeDb.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
      if (count.c > 0) {
        runtimeHadData = true;
        continue;
      }
      const cols = runtimeDb
        .prepare(`PRAGMA table_info(${table})`)
        .all() as { name: string; notnull: number; dflt_value: string | null }[];
      if (cols.length === 0) continue;
      const colList = cols.map((c) => c.name).join(", ");
      const selectList = cols
        .map((c) => {
          if (c.notnull && c.dflt_value) {
            return `COALESCE(${c.name}, ${c.dflt_value}) AS ${c.name}`;
          }
          return c.name;
        })
        .join(", ");
      runtimeDb.exec(`INSERT INTO ${table} (${colList}) SELECT ${selectList} FROM shared.${table}`);
      copiedAny = true;
    }
  } finally {
    runtimeDb.exec("PRAGMA foreign_keys = ON");
  }

  if (!copiedAny && runtimeHadData) return;

  // Remove runtime tables from shared config DB so it only stores shared config.
  sharedDb.exec("PRAGMA foreign_keys = OFF");
  try {
    for (const table of RUNTIME_TABLES) {
      sharedDb.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  } finally {
    sharedDb.exec("PRAGMA foreign_keys = ON");
  }
}

function resetLegacyRuntimeSchema(runtimeDb: Database): void {
  const sharedTableSet = new Set(["agent_types", "state_patterns", "agents", "teams", "team_agents"]);
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
    const tables = runtimeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      runtimeDb.exec(`DROP TABLE IF EXISTS ${name}`);
    }
  } finally {
    runtimeDb.exec("PRAGMA foreign_keys = ON");
  }
}

function initializeSplitDatabases(runtimeDb: Database, sharedDb: Database): void {
  runSchema(sharedDb, CONFIG_SCHEMA_PATH);
  migrateLegacySchema(sharedDb);
  seedAgentTypes(sharedDb);

  resetLegacyRuntimeSchema(runtimeDb);
  runSchema(runtimeDb, RUNTIME_SCHEMA_PATH);
  migrateLegacySchema(runtimeDb);

  ensureSharedAttached(runtimeDb);
  migrateLegacyMonolithData(runtimeDb, sharedDb);
  installSplitSqlRouting(runtimeDb);
}

function initializeSingleDatabase(database: Database): void {
  migrateLegacySchema(database);
  runSchema(database, MONOLITH_SCHEMA_PATH);
  migrateLegacySchema(database);
  seedAgentTypes(database);
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
  configDbPath = DEFAULT_CONFIG_DB_PATH;
  runtimeDbPath = DEFAULT_RUNTIME_DB_PATH;

  ensureParentDir(configDbPath);
  ensureParentDir(runtimeDbPath);

  configDb = new Database(configDbPath);
  configureDatabase(configDb);

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

  if (!configDb) {
    configDb = new Database(configDbPath);
    configureDatabase(configDb);
  }

  initializeSplitDatabases(activeDb, configDb);
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

  if (configDb) {
    configDb.close();
    configDb = null;
  }

  mode = "none";
}

export function resetDb(): void {
  closeDb();
}
