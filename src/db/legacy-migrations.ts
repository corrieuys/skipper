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
  ensureColumn(database, "task_templates", "hooks", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "task_template_phases", "override_prompt", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "task_template_phases", "review_override", "TEXT DEFAULT NULL");
  ensureColumn(database, "task_template_phases", "consensus_override", "TEXT DEFAULT NULL");
  ensureColumn(database, "tasks", "source_scheduled_task_id", "TEXT");
  ensureColumn(database, "tasks", "run_input", "TEXT");
  ensureColumn(database, "agent_instances", "input_tokens", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "agent_instances", "output_tokens", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "agent_instances", "cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "agent_instances", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0");
  // File artifacts (operator uploads): metadata columns + the 'upload' kind.
  ensureColumn(database, "task_artifacts", "storage", "TEXT NOT NULL DEFAULT 'inline'");
  ensureColumn(database, "task_artifacts", "mime", "TEXT");
  ensureColumn(database, "task_artifacts", "bytes", "INTEGER");
  ensureColumn(database, "task_artifacts", "sha256", "TEXT");
  ensureColumn(database, "task_artifacts", "width", "INTEGER");
  ensureColumn(database, "task_artifacts", "height", "INTEGER");
  ensureColumn(database, "task_artifacts", "source", "TEXT");
  ensureColumn(database, "realtime_timeline", "artifact_id", "TEXT");
  migrateAgentConfigGoalToInstruction(database);
  migrateTeamAgentsDropSkills(database);
  migrateTeamAgentsDropMaxComplexity(database);
  migrateTaskNotesMillisecondTimestamps(database);
  migrateScheduledTasksOptionalInterval(database);
  migrateTasksToUnifiedModel(database);
  migrateTasksArchivedToSettled(database);
  migrateTaskArtifactsUploadKind(database);
  migrateRealtimeTimelineFileEntries(database);
}

function tableSql(database: Database, tableName: string): string | null {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql: string | null } | null;
  return row?.sql ?? null;
}

// File artifacts: the `kind` CHECK gains 'upload'. SQLite can't ALTER a CHECK,
// so rebuild the table. Guard: the stored CREATE statement lacks 'upload'.
// Every row and both indexes are carried across; foreign keys are off for the
// swap so the task_artifact_refs FK never cascades.
function migrateTaskArtifactsUploadKind(database: Database): void {
  const sql = tableSql(database, "task_artifacts");
  if (!sql || sql.includes("'upload'")) return;

  // Older DBs may predate these columns (they arrive via numbered migrations
  // that run AFTER this pass); the rebuild SELECT reads them.
  ensureColumn(database, "task_artifacts", "publish_key", "TEXT");
  ensureColumn(database, "task_artifacts", "published_at", "TEXT");
  ensureColumn(database, "task_artifacts", "format", "TEXT");
  ensureColumn(database, "task_artifacts", "deleted_at", "TEXT");

  const columns = [
    "id", "task_id", "name", "version", "kind", "description", "body", "created_by_agent_id",
    "created_at", "publish_key", "published_at", "format", "deleted_at",
    "storage", "mime", "bytes", "sha256", "width", "height", "source",
  ].join(", ");

  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec("BEGIN");
    try {
      database.exec(`
        CREATE TABLE task_artifacts_new (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          kind TEXT NOT NULL CHECK (kind IN ('transcript', 'summary', 'plan', 'other', 'upload')),
          description TEXT,
          body TEXT NOT NULL,
          created_by_agent_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          publish_key TEXT,
          published_at TEXT,
          format TEXT,
          deleted_at TEXT,
          storage TEXT NOT NULL DEFAULT 'inline',
          mime TEXT,
          bytes INTEGER,
          sha256 TEXT,
          width INTEGER,
          height INTEGER,
          source TEXT,
          UNIQUE(task_id, name, version)
        );
      `);
      database.exec(`INSERT INTO task_artifacts_new (${columns}) SELECT ${columns} FROM task_artifacts;`);
      database.exec("DROP TABLE task_artifacts;");
      database.exec("ALTER TABLE task_artifacts_new RENAME TO task_artifacts;");
      database.exec("CREATE INDEX IF NOT EXISTS idx_task_artifacts_task_kind ON task_artifacts(task_id, kind, created_at);");
      database.exec("CREATE INDEX IF NOT EXISTS idx_task_artifacts_task_name_latest ON task_artifacts(task_id, name, created_at DESC);");
      database.exec("COMMIT");
    } catch (err) {
      database.exec("ROLLBACK");
      throw err;
    }
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

// File artifacts in the input timeline: `entry_type` gains 'image' and 'file'
// (plus the artifact_id column added above). Same rebuild dance as the
// artifacts table; guard is the stored CREATE statement lacking 'image'.
function migrateRealtimeTimelineFileEntries(database: Database): void {
  const sql = tableSql(database, "realtime_timeline");
  if (!sql || sql.includes("'image'")) return;

  // `priority` normally arrives via migration 0005, which runs after this pass
  // on a DB that never had it; the rebuild SELECT reads it, so add it first.
  ensureColumn(database, "realtime_timeline", "priority", "TEXT NOT NULL DEFAULT 'normal'");

  const columns = [
    "id", "task_id", "entry_type", "content", "source_segment_ids", "fed_to_skipper",
    "artifact_id", "priority", "created_at",
  ].join(", ");

  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec("BEGIN");
    try {
      database.exec(`
        CREATE TABLE realtime_timeline_new (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          entry_type TEXT NOT NULL CHECK (entry_type IN ('summary', 'text', 'error', 'image', 'file')),
          content TEXT NOT NULL,
          source_segment_ids TEXT NOT NULL DEFAULT '[]',
          fed_to_skipper INTEGER NOT NULL DEFAULT 0,
          artifact_id TEXT,
          priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      database.exec(`INSERT INTO realtime_timeline_new (${columns}) SELECT ${columns} FROM realtime_timeline;`);
      database.exec("DROP TABLE realtime_timeline;");
      database.exec("ALTER TABLE realtime_timeline_new RENAME TO realtime_timeline;");
      database.exec("CREATE INDEX IF NOT EXISTS idx_realtime_timeline_task_fed ON realtime_timeline(task_id, fed_to_skipper, created_at);");
      database.exec("CREATE INDEX IF NOT EXISTS idx_realtime_timeline_task_time ON realtime_timeline(task_id, created_at);");
      database.exec("COMMIT");
    } catch (err) {
      database.exec("ROLLBACK");
      throw err;
    }
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

// Unify standard + realtime tasks into one model:
//   status: draft | active | settled   (was draft/approved/running/paused/completed/failed)
//   mode:   workflow | conversational   (replaces task_type standard/real_time)
//   paused: flag on active tasks        (was a status)
//   wake_requested_at: pending wake marker (replaces the approved queue state)
//   settled_at: terminal timestamp
// iteration_count and task_type are dropped: iterating is now just new input to
// an idle task, and audio input is available on every task.
// SQLite can't ALTER a CHECK, so rebuild the table. Runs only when the table
// still lacks the `mode` column; fresh DBs get the new shape from schema*.sql.
function migrateTasksToUnifiedModel(database: Database): void {
  if (!tableExists(database, "tasks")) return;
  if (hasColumn(database, "tasks", "mode")) return; // already unified

  // Very old DBs may predate these columns; the rebuild SELECT reads them.
  ensureColumn(database, "tasks", "iteration_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "tasks", "task_type", "TEXT NOT NULL DEFAULT 'standard'");

  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS tasks_new (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        team_id TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'settled')),
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
        settled_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    database.exec(`
      INSERT INTO tasks_new (id, title, description, team_id, status, mode, paused,
        current_phase, result, orchestration_state, regression_count, needs_review,
        working_directory, task_config, source_scheduled_task_id, run_input,
        wake_requested_at, created_at, approved_at, started_at, completed_at,
        settled_at, updated_at)
      SELECT id, title, description, team_id,
        CASE
          WHEN status = 'draft' THEN 'draft'
          WHEN status IN ('completed', 'failed') THEN 'settled'
          ELSE 'active'
        END,
        CASE WHEN task_type = 'real_time' THEN 'conversational' ELSE 'workflow' END,
        CASE WHEN status = 'paused' THEN 1 ELSE 0 END,
        current_phase, result, orchestration_state, regression_count, needs_review,
        working_directory, task_config, source_scheduled_task_id, run_input,
        CASE WHEN status = 'approved' THEN COALESCE(approved_at, datetime('now')) ELSE NULL END,
        created_at, approved_at, started_at, completed_at,
        CASE WHEN status IN ('completed', 'failed') THEN COALESCE(completed_at, datetime('now')) ELSE NULL END,
        updated_at
      FROM tasks;
    `);
    database.exec("DROP TABLE tasks;");
    database.exec("ALTER TABLE tasks_new RENAME TO tasks;");
    database.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);");
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

// Rename the settled vocabulary: stored status 'archived' -> 'settled' and
// column archived_at -> settled_at. Covers DBs that ran an earlier build of the
// unified migration (which used 'archived'); fresh DBs and DBs unified by the
// current build already have the settled shape. SQLite can't ALTER a CHECK, so
// rebuild the table. Guard: the old archived_at column still exists.
function migrateTasksArchivedToSettled(database: Database): void {
  if (!tableExists(database, "tasks")) return;
  if (!hasColumn(database, "tasks", "archived_at")) return; // already settled shape

  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS tasks_new (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        team_id TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'settled')),
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
        settled_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    database.exec(`
      INSERT INTO tasks_new (id, title, description, team_id, status, mode, paused,
        current_phase, result, orchestration_state, regression_count, needs_review,
        working_directory, task_config, source_scheduled_task_id, run_input,
        wake_requested_at, created_at, approved_at, started_at, completed_at,
        settled_at, updated_at)
      SELECT id, title, description, team_id,
        CASE WHEN status = 'archived' THEN 'settled' ELSE status END,
        mode, paused,
        current_phase, result, orchestration_state, regression_count, needs_review,
        working_directory, task_config, source_scheduled_task_id, run_input,
        wake_requested_at, created_at, approved_at, started_at, completed_at,
        archived_at, updated_at
      FROM tasks;
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
        max_complexity INTEGER DEFAULT 10,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(team_id, agent_id)`
      : `id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        role TEXT,
        level INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(team_id, agent_id)`;
    database.exec(`CREATE TABLE IF NOT EXISTS team_agents_new (${newTableCols});`);
    const insertCols = carryMaxComplexity
      ? "id, team_id, agent_id, role, level, max_complexity, created_at"
      : "id, team_id, agent_id, role, level, created_at";
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(team_id, agent_id)
      );
    `);
    database.exec(`
      INSERT INTO team_agents_new (id, team_id, agent_id, role, level, created_at)
      SELECT id, team_id, agent_id, role, level, created_at
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
