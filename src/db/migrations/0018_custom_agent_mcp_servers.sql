-- MCP servers a custom agent can be granted tools from.
--
-- Skipper's own registry, separate from the Claude/Codex configs that
-- config-readers/mcp.ts reads: those are files we do not own, and an import from
-- one copies the values in rather than referencing them, so editing Skipper's
-- copy never writes back to a user's Claude config.
--
-- Runtime DB, like custom_agents, because `env` and `headers` carry credentials
-- and the shared config tables are persisted to committed JSON snapshots.
CREATE TABLE IF NOT EXISTS custom_agent_mcp_servers (
  id TEXT PRIMARY KEY,
  -- Namespaces this server's tools as `<slug>__<tool>`, so two servers can both
  -- offer `search` without colliding. Constrained to what a model may call.
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),

  -- stdio transport
  command TEXT NOT NULL DEFAULT '',
  args TEXT NOT NULL DEFAULT '[]',           -- JSON array
  env TEXT NOT NULL DEFAULT '{}',            -- JSON object, values may be ${ENV_VAR}

  -- http transport
  url TEXT NOT NULL DEFAULT '',
  headers TEXT NOT NULL DEFAULT '{}',        -- JSON object, values may be ${ENV_VAR}

  -- Tool list cached at save/refresh. The agent form renders from this rather
  -- than connecting on page load, so an unreachable server cannot hang the page.
  tool_catalogue TEXT NOT NULL DEFAULT '[]', -- JSON [{name, description}]
  catalogue_error TEXT,                      -- last refresh failure, shown in the UI
  catalogue_refreshed_at TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tools granted from those servers, as `<slug>__<tool>` names.
-- Separate from enabled_mcp_tools (Skipper's own daemon tools) so the two
-- namespaces cannot be confused for each other.
ALTER TABLE custom_agents ADD COLUMN enabled_server_tools TEXT NOT NULL DEFAULT '[]';
