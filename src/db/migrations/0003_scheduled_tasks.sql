-- Scheduled recurring tasks
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  team_id TEXT REFERENCES teams(id),
  working_directory TEXT NOT NULL DEFAULT '',
  schedule_unit TEXT NOT NULL CHECK (schedule_unit IN ('minutes', 'hours', 'days')),
  schedule_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  task_config TEXT NOT NULL DEFAULT '{}',
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status_next ON scheduled_tasks(status, next_run_at);
