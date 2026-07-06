// One-shot legacy schema migrations, run on every init via migrateLegacySchema().
// Each function guards on current schema state and no-ops once applied.
// New migrations go in src/db/migrations/ as numbered SQL files — add here only
// when SQLite requires a table rebuild or data rewrite that SQL alone can't express.
import { Database } from "bun:sqlite";

export function tableExists(database: Database, tableName: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName) as { name: string } | null;
  return !!row;
}

export function migrateLegacySchema(database: Database): void {
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
  ensureColumn(database, "task_notes", "deleted_at", "TEXT");
  ensureColumn(database, "task_artifacts", "deleted_at", "TEXT");
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
