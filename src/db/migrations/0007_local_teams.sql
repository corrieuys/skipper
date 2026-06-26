-- Teams persisted in the runtime DB. A team embeds its own agents + phases +
-- skipper prompt + hooks. At boot (and on every mutation) each team is
-- registered into the shared config layer (teams / agents / team_agents and the
-- in-memory store Maps) so the orchestrator can resolve it.
CREATE TABLE IF NOT EXISTS local_teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  skipper_prompt TEXT NOT NULL DEFAULT '',
  hooks TEXT NOT NULL DEFAULT '[]',       -- JSON array
  phases TEXT NOT NULL DEFAULT '[]',      -- JSON array of {name,prompt,review?,consensus?}
  agents TEXT NOT NULL DEFAULT '[]',      -- JSON array of inline agents
                                          -- {id,name,type,model,instruction,role,parent_agent_id,capabilities}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
