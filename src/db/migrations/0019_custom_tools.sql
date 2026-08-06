-- Operator-defined tools: a name, a parameter list, and a JavaScript body that
-- Skipper runs when an agent calls it.
--
-- The body executes in a terminated-on-timeout Worker rather than the daemon's
-- own event loop, so a runaway loop in a tool cannot take the orchestrator down
-- with it (see custom-tools/runtime.ts).
--
-- Runtime DB: the code is machine-local and may embed endpoints or credentials,
-- and the shared config tables are persisted to committed JSON snapshots.
CREATE TABLE IF NOT EXISTS custom_tools (
  id TEXT PRIMARY KEY,
  -- What the model calls. Constrained to a valid function name and unique, since
  -- it shares a namespace with Skipper's own MCP tools.
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  -- Parameter rows: [{name, type, description, required}]. The JSON Schema the
  -- model sees is derived from these, so there is one source of truth.
  parameters TEXT NOT NULL DEFAULT '[]',
  code TEXT NOT NULL DEFAULT '',
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tools a custom agent always has, wherever it is used. A team may additionally
-- grant tools to any agent (CLI ones included) via local_teams.agents[].customTools;
-- a session gets the union of the two.
ALTER TABLE custom_agents ADD COLUMN enabled_custom_tools TEXT NOT NULL DEFAULT '[]';
