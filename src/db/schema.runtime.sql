-- Runtime/local database schema (ephemeral and machine-specific)

-- Tasks
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  team_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'running', 'completed', 'failed')),
  current_phase INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  result TEXT,
  orchestration_state TEXT NOT NULL DEFAULT '{}',
  regression_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Task checkpoints for long-running tasks
CREATE TABLE IF NOT EXISTS task_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  checkpoint_type TEXT NOT NULL,
  session_id TEXT,
  context_snapshot TEXT NOT NULL DEFAULT '{}',
  terminal_seq INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Real-time agent state tracking
CREATE TABLE IF NOT EXISTS agent_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'stopped',
  state_metadata TEXT NOT NULL DEFAULT '{}',
  heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
  screen_fingerprint TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id)
);

-- Agent spawn sessions
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent ON agent_sessions(agent_id, created_at DESC);

-- Terminal output capture
CREATE TABLE IF NOT EXISTS terminal_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr')),
  data TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_terminal_outputs_agent_seq ON terminal_outputs(agent_id, sequence);
CREATE INDEX IF NOT EXISTS idx_terminal_outputs_session ON terminal_outputs(session_id);
CREATE INDEX IF NOT EXISTS idx_terminal_outputs_created ON terminal_outputs(created_at);

-- Delegation records
CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  parent_agent_id TEXT NOT NULL,
  child_agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  prompt TEXT NOT NULL,
  result TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Phase regression audit log
CREATE TABLE IF NOT EXISTS phase_regressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  from_phase INTEGER NOT NULL,
  to_phase INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Task notes for inter-agent knowledge sharing
CREATE TABLE IF NOT EXISTS task_notes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Escalation records
CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  type TEXT NOT NULL,
  question TEXT NOT NULL,
  response TEXT,
  severity TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- Agent-to-agent message audit trail
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Daemon check run history
CREATE TABLE IF NOT EXISTS manager_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  tasks_processed INTEGER NOT NULL DEFAULT 0,
  agents_checked INTEGER NOT NULL DEFAULT 0,
  errors TEXT
);

-- Stuck detection analysis records
CREATE TABLE IF NOT EXISTS stuck_detection_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  detection_type TEXT NOT NULL,
  screen_fingerprint TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Agent memory checkpoint data
CREATE TABLE IF NOT EXISTS agent_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, key)
);

-- General event audit log
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  source_agent_id TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);

-- Task output artifacts
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT,
  path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Daemon state persistence (survives restarts)
CREATE TABLE IF NOT EXISTS daemon_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Structured error log
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '{}',
  stack TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_error_log_category ON error_log(category);

-- CLI runtime detection cache
CREATE TABLE IF NOT EXISTS cli_runtimes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command TEXT NOT NULL UNIQUE,
  version TEXT,
  path TEXT,
  available INTEGER NOT NULL DEFAULT 0,
  detected_at TEXT NOT NULL DEFAULT (datetime('now'))
);
