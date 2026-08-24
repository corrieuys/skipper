-- Single agents: a standalone agent (NOT the root Skipper) that runs a regular
-- or recurring task by itself, with no delegation and no phases. Persisted in the
-- runtime DB and projected into the shared config layer as a "team of one" whose
-- entrypoint is the agent itself (id prefix "sa:"), so the whole team-keyed task
-- pipeline runs it unchanged. The `config` JSON column holds the Slack opt-in and
-- slash-command binding, mirroring local_teams.team_config.
CREATE TABLE IF NOT EXISTS single_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'default',
  instruction TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '[]',
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
