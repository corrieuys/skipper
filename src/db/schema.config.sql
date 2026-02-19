-- Shared configuration database schema (portable across users)

-- Agent type definitions (CLI tool definitions)
CREATE TABLE IF NOT EXISTS agent_types (
  name TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  resume_args TEXT,
  model_flag TEXT,
  available_models TEXT NOT NULL DEFAULT '[]',
  env_vars TEXT NOT NULL DEFAULT '{}',
  supports_stdin INTEGER NOT NULL DEFAULT 0,
  supports_resume INTEGER NOT NULL DEFAULT 0,
  resume_flag TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Agent instances
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL REFERENCES agent_types(name),
  model TEXT NOT NULL DEFAULT 'default',
  config TEXT NOT NULL DEFAULT '{}',
  capabilities TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'busy', 'error', 'stopped')),
  process_pid INTEGER,
  current_task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Teams
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entrypoint_agent_id TEXT REFERENCES agents(id),
  phases TEXT NOT NULL DEFAULT '[]',
  goal TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Skipper (lead agent) configuration
CREATE TABLE IF NOT EXISTS skipper_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Agent-team membership with hierarchy
CREATE TABLE IF NOT EXISTS team_agents (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT,
  level INTEGER NOT NULL DEFAULT 0,
  parent_agent_id TEXT REFERENCES agents(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(team_id, agent_id)
);
