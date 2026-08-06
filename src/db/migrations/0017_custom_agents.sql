-- Custom agents: agent definitions that Skipper executes inside its own process
-- instead of spawning a vendor CLI. A definition names an OpenAI-compatible
-- endpoint, its auth, a system prompt, and the exact set of tools the agent is
-- allowed to see.
--
-- Runtime DB on purpose, never the shared config tables: these rows carry API
-- keys and header values, and the shared tables are seeded from committed
-- config/*.json snapshots. The agent_types row each definition needs is
-- registered into the in-memory config DB at boot (see custom-agents/store.ts),
-- so nothing here is ever written to disk outside the runtime database.
CREATE TABLE IF NOT EXISTS custom_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL,
  model_id TEXT NOT NULL,
  -- Literal secret or a ${ENV_VAR} reference resolved at run time.
  -- Empty is normal: a local server (LM Studio, llama.cpp, Ollama) needs no auth.
  api_key TEXT NOT NULL DEFAULT '',
  headers TEXT NOT NULL DEFAULT '{}',        -- JSON object, values may be ${ENV_VAR}
  -- Query string appended to every call. Azure OpenAI requires api-version here;
  -- nothing else does, so it defaults empty.
  query_params TEXT NOT NULL DEFAULT '{}',   -- JSON object, values may be ${ENV_VAR}
  system_prompt TEXT NOT NULL DEFAULT '',
  enabled_tools TEXT NOT NULL DEFAULT '[]',      -- JSON array of local tool ids
  enabled_mcp_tools TEXT NOT NULL DEFAULT '[]',  -- JSON array of skipper MCP tool names
  enabled_skills TEXT NOT NULL DEFAULT '[]',     -- JSON array of skill names
  max_steps INTEGER NOT NULL DEFAULT 40,
  temperature REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Conversation history for resume. A custom agent has no vendor session store,
-- so Skipper keeps its own: one row per model message, replayed on the next
-- spawn that carries the same session id.
CREATE TABLE IF NOT EXISTS custom_agent_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message TEXT NOT NULL,                     -- JSON-encoded model message
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_custom_agent_messages_session
  ON custom_agent_messages(session_id, seq);
