-- Skipper Orchestrator Database Schema

-- Agent type definitions (CLI tool definitions)
CREATE TABLE IF NOT EXISTS agent_types (
  name TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',          -- JSON array
  resume_args TEXT,                          -- JSON array for explicit resume invocation args
  model_flag TEXT,                           -- e.g. '--model'
  available_models TEXT NOT NULL DEFAULT '[]', -- JSON array
  env_vars TEXT NOT NULL DEFAULT '{}',       -- JSON object of env var templates
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
  config TEXT NOT NULL DEFAULT '{}',         -- JSON: {instruction, model, environment, constraints}
  capabilities TEXT NOT NULL DEFAULT '[]',   -- JSON array
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
  phases TEXT NOT NULL DEFAULT '[]',         -- JSON array of {name, prompt}
  goal TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Agent-team membership with hierarchy
CREATE TABLE IF NOT EXISTS team_agents (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT,
  level INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(team_id, agent_id)
);

-- Tasks
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  team_id TEXT REFERENCES teams(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'running', 'paused', 'completed', 'failed')),
  current_phase INTEGER NOT NULL DEFAULT 0,
  result TEXT,                               -- JSON
  orchestration_state TEXT NOT NULL DEFAULT '{}', -- JSONB
  regression_count INTEGER NOT NULL DEFAULT 0,
  iteration_count INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  working_directory TEXT NOT NULL DEFAULT '',
  task_type TEXT NOT NULL DEFAULT 'standard' CHECK (task_type IN ('standard', 'real_time')),
  task_config TEXT NOT NULL DEFAULT '{}',     -- JSON: real-time config
  source_scheduled_task_id TEXT,             -- links spawned runs back to their scheduled_tasks row
  run_input TEXT,                            -- optional per-run operator input injected into the prompt (manual "Run Now")
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);

-- Task checkpoints for long-running tasks
CREATE TABLE IF NOT EXISTS task_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  checkpoint_type TEXT NOT NULL,             -- PHASE_START, DELEGATION_COMPLETE, NOTE_ADDED, REGRESSION, etc.
  session_id TEXT,
  context_snapshot TEXT NOT NULL DEFAULT '{}', -- JSONB
  terminal_seq INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Real-time agent state tracking
CREATE TABLE IF NOT EXISTS agent_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'stopped',     -- working, stuck, escalated, waiting_delegation, stopped
  state_metadata TEXT NOT NULL DEFAULT '{}', -- JSON
  heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
  screen_fingerprint TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  last_signal_at TEXT,                       -- timestamp of last meaningful orchestration signal
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
  parent_agent_id TEXT NOT NULL REFERENCES agents(id),
  child_agent_id TEXT NOT NULL REFERENCES agents(id),
  parent_instance_id TEXT,
  child_instance_id TEXT,
  delegation_group_id TEXT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  prompt TEXT NOT NULL,
  result TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  -- Per-delegation working directory override. NULL = inherit the task's.
  working_directory TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_delegations_task_status ON delegations(task_id, status);
CREATE INDEX IF NOT EXISTS idx_delegations_parent_instance ON delegations(parent_instance_id, status);
CREATE INDEX IF NOT EXISTS idx_delegations_child_instance ON delegations(child_instance_id, status);

CREATE TABLE IF NOT EXISTS agent_instances (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  template_agent_id TEXT NOT NULL REFERENCES agents(id),
  parent_instance_id TEXT,
  root_instance_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'waiting_delegation', 'completed', 'failed', 'stopped')),
  process_pid INTEGER,
  session_id TEXT,
  state_metadata TEXT NOT NULL DEFAULT '{}',
  attempt INTEGER NOT NULL DEFAULT 1,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_instances_task ON agent_instances(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_instances_template ON agent_instances(template_agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_instances_status ON agent_instances(status, updated_at);

-- Internal sub-agents spawned by an agent via its own Agent/Task tool (invisible to
-- Skipper's delegation graph). One row per sub-agent keyed by tool-call id; total_tokens
-- is cumulative-monotonic in the stream so writers take MAX, not SUM. See schema.runtime.sql.
CREATE TABLE IF NOT EXISTS subagent_usage (
  tool_use_id       TEXT PRIMARY KEY,
  agent_instance_id TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  subagent_type     TEXT,
  description       TEXT,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  tool_uses         INTEGER,
  duration_ms       INTEGER,
  last_tool_name    TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subagent_usage_task ON subagent_usage(task_id);
CREATE INDEX IF NOT EXISTS idx_subagent_usage_instance ON subagent_usage(agent_instance_id);

CREATE TABLE IF NOT EXISTS delegation_groups (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  policy TEXT NOT NULL DEFAULT 'wait_all_mixed',
  expected_count INTEGER NOT NULL,
  settled_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_delegation_groups_task ON delegation_groups(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_delegation_groups_status ON delegation_groups(status, created_at);


-- Task notes for inter-agent knowledge sharing
-- created_at uses millisecond precision (strftime '%f') so that rapid-fire
-- notes from concurrent agents have a stable chronological order. The
-- secondary sort on id is still needed as a tiebreaker for sub-millisecond ties.
CREATE TABLE IF NOT EXISTS task_notes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'agent',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes(task_id, created_at);

-- Operator messages — plain-language progress updates written for the human, not
-- for other agents. Never injected back into an agent prompt (see src/messages).
CREATE TABLE IF NOT EXISTS task_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  agent_instance_id TEXT,
  content TEXT NOT NULL,
  -- Body format: 'text' | 'markdown' | 'html'. NULL = 'text' (the default).
  -- Enum enforced in MessageManager, not a CHECK.
  format TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_task_messages_task ON task_messages(task_id, created_at);

-- Escalation records
CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  runtime_agent_id TEXT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  type TEXT NOT NULL,                        -- agent_request, max_nudges, permission_required, etc.
  question TEXT NOT NULL,
  response TEXT,
  severity TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_escalations_task_status ON escalations(task_id, status);


-- Daemon check run history
CREATE TABLE IF NOT EXISTS manager_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  tasks_processed INTEGER NOT NULL DEFAULT 0,
  agents_checked INTEGER NOT NULL DEFAULT 0,
  errors TEXT                                -- JSON array of error descriptions
);

-- Stuck detection analysis records
CREATE TABLE IF NOT EXISTS stuck_detection_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  detection_type TEXT NOT NULL,              -- stuck, nudged, escalated
  screen_fingerprint TEXT,
  details TEXT,                              -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);


-- General event audit log
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',        -- JSON
  source_agent_id TEXT REFERENCES agents(id),
  task_id TEXT REFERENCES tasks(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);


-- Daemon state persistence (survives restarts)
CREATE TABLE IF NOT EXISTS daemon_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Skipper (lead agent) configuration
CREATE TABLE IF NOT EXISTS skipper_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Structured error log
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '{}',       -- JSON
  stack TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_error_log_category ON error_log(category);

-- Task artifacts (immutable versioned store)
CREATE TABLE IF NOT EXISTS task_artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL CHECK (kind IN ('transcript', 'summary', 'plan', 'other')),
  description TEXT,
  body TEXT NOT NULL,
  created_by_agent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  publish_key TEXT,
  published_at TEXT,
  -- Body format: 'html' | 'markdown'. NULL on legacy rows (resolved by heuristic
  -- at render time). Enum enforced in ArtifactManager, not a CHECK.
  format TEXT,
  UNIQUE(task_id, name, version)
);
CREATE INDEX IF NOT EXISTS idx_task_artifacts_task_kind ON task_artifacts(task_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_task_artifacts_task_name_latest ON task_artifacts(task_id, name, created_at DESC);

-- Real-time input streams
CREATE TABLE IF NOT EXISTS task_input_streams (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('audio', 'text')),
  source_ref TEXT,
  content_type TEXT NOT NULL DEFAULT 'text/plain',
  content_body TEXT NOT NULL,
  chunk_start_at TEXT,
  chunk_end_at TEXT,
  sequence INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  transcription_status TEXT NOT NULL DEFAULT 'pending' CHECK (transcription_status IN ('pending', 'transcribed', 'failed', 'not_applicable')),
  transcribed_text TEXT,
  summary_batch_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_input_streams_task_seq ON task_input_streams(task_id, sequence);
CREATE INDEX IF NOT EXISTS idx_task_input_streams_task_time ON task_input_streams(task_id, chunk_start_at);

-- Real-time rolling windows
CREATE TABLE IF NOT EXISTS task_windows (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  window_start_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL,
  policy_snapshot TEXT NOT NULL DEFAULT '{}',
  transcript_artifact_version INTEGER,
  summary_artifact_version INTEGER,
  trigger_decision TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_windows_task_time ON task_windows(task_id, window_start_at);

-- Artifact cross-references (lineage tracking)
CREATE TABLE IF NOT EXISTS task_artifact_refs (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES task_artifacts(id) ON DELETE CASCADE,
  window_id TEXT REFERENCES task_windows(id) ON DELETE SET NULL,
  input_stream_id TEXT REFERENCES task_input_streams(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_artifact_refs_artifact ON task_artifact_refs(artifact_id);
CREATE INDEX IF NOT EXISTS idx_task_artifact_refs_window ON task_artifact_refs(window_id);

-- Global real-time processing configuration (like skipper_config)
CREATE TABLE IF NOT EXISTS realtime_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  event_key TEXT PRIMARY KEY,
  audio_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Chronological timeline of processed entries for real-time tasks
CREATE TABLE IF NOT EXISTS realtime_timeline (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('summary', 'text', 'error')),
  content TEXT NOT NULL,
  source_segment_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of task_input_streams IDs that produced this
  fed_to_skipper INTEGER NOT NULL DEFAULT 0,       -- 0 = not yet fed, 1 = fed
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_realtime_timeline_task_fed ON realtime_timeline(task_id, fed_to_skipper, created_at);
CREATE INDEX IF NOT EXISTS idx_realtime_timeline_task_time ON realtime_timeline(task_id, created_at);

-- Pipeline state for real-time tasks (persistent across restarts)
CREATE TABLE IF NOT EXISTS realtime_pipeline_state (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  analyst_instance_id TEXT,
  analyst_session_id TEXT,
  analyst_status TEXT NOT NULL DEFAULT 'idle' CHECK (analyst_status IN ('idle', 'busy', 'waiting_action')),
  action_instance_id TEXT,
  action_status TEXT NOT NULL DEFAULT 'idle' CHECK (action_status IN ('idle', 'busy')),
  last_summary_version INTEGER NOT NULL DEFAULT 0,
  last_analyst_fed_version INTEGER NOT NULL DEFAULT 0,
  queued_summary_versions TEXT NOT NULL DEFAULT '[]',
  cadence_timer_active INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Task Templates (reusable prompt configurations per team)
CREATE TABLE IF NOT EXISTS task_templates (
  id TEXT PRIMARY KEY,
  template_name TEXT NOT NULL,
  team_id TEXT NOT NULL,
  skipper_prompt TEXT NOT NULL DEFAULT '',
  hooks TEXT NOT NULL DEFAULT '[]',
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_templates_team ON task_templates(team_id);

-- Task Template Phase Prompts (one row per phase per template)
CREATE TABLE IF NOT EXISTS task_template_phases (
  id TEXT PRIMARY KEY,
  task_template_id TEXT NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
  phase_name TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  override_prompt INTEGER NOT NULL DEFAULT 0,
  review_override TEXT DEFAULT NULL,
  consensus_override TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(task_template_id, phase_name)
);
CREATE INDEX IF NOT EXISTS idx_task_template_phases_template ON task_template_phases(task_template_id);

-- Tracks which task notes have been delivered to which agent instances
CREATE TABLE IF NOT EXISTS agent_note_receipts (
  agent_instance_id TEXT NOT NULL,
  note_id TEXT NOT NULL REFERENCES task_notes(id) ON DELETE CASCADE,
  delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_instance_id, note_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_note_receipts_instance ON agent_note_receipts(agent_instance_id);

-- Consensus worktrees for parallel agent isolation
CREATE TABLE IF NOT EXISTS consensus_worktrees (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  phase_index INTEGER NOT NULL,
  delegation_group_id TEXT NOT NULL,
  agent_instance_id TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','failed','cleaned')),
  diff_snapshot TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cleaned_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_consensus_worktrees_group ON consensus_worktrees(delegation_group_id);

-- Scheduled recurring tasks
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  team_id TEXT REFERENCES teams(id),
  working_directory TEXT NOT NULL DEFAULT '',
  -- NULL interval = manual-only recurring task: never auto-fires, only "Run Now".
  schedule_unit TEXT CHECK (schedule_unit IS NULL OR schedule_unit IN ('minutes', 'hours', 'days')),
  schedule_amount INTEGER,
  -- Weekly schedule matrix: JSON array of 7 arrays (index 0 = Monday) of 24
  -- ints (0/1); an enabled cell fires one run at the top of that local hour.
  -- Mutually exclusive with schedule_unit/schedule_amount (app-layer enforced).
  schedule_matrix TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  task_config TEXT NOT NULL DEFAULT '{}',
  next_run_at TEXT,
  last_run_at TEXT,
  -- Secret for the public webhook trigger URL relayed via Skipper Connect
  -- (NULL = webhook trigger disabled). Validated daemon-side, timing-safe.
  webhook_key TEXT,
  -- Webhook debounce (floor 1): a webhook arriving within this many minutes
  -- of the previous webhook is ignored. Every webhook (fired or ignored)
  -- stamps webhook_last_event_at; cron/manual runs do not.
  webhook_debounce_minutes INTEGER NOT NULL DEFAULT 1,
  webhook_last_event_at TEXT,
  -- Free-text contract for how runs use the cross-task global store (key
  -- names, payload shape, rolling-window markers). Injected into every
  -- spawned run's root prompt; doubles as the explicit authorization the
  -- global-store MCP tools require. NULL = no instructions.
  global_store_instructions TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status_next ON scheduled_tasks(status, next_run_at);

-- Typed key-value app settings (mutable runtime state, not JSON config)
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string' CHECK (value_type IN ('boolean', 'number', 'string', 'json')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- API keys for external MCP access
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Generic global key/value store shared across all task instances.
CREATE TABLE IF NOT EXISTS global_store (
  name                TEXT PRIMARY KEY,
  type                TEXT,
  data                TEXT,
  status              TEXT,
  updated_by_agent_id TEXT,
  task_id             TEXT,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_global_store_type   ON global_store(type);
CREATE INDEX IF NOT EXISTS idx_global_store_status ON global_store(status);

-- Unified "local teams" (runtime table). Flattened into the config tables
-- (teams/agents/team_agents) at boot + on mutation.
CREATE TABLE IF NOT EXISTS local_teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  skipper_prompt TEXT NOT NULL DEFAULT '',
  hooks TEXT NOT NULL DEFAULT '[]',
  phases TEXT NOT NULL DEFAULT '[]',
  agents TEXT NOT NULL DEFAULT '[]',
  team_config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- monkey_usage table moved to greg.db (see src/monkey/db.ts)


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
  -- Tools from registered MCP servers, as <slug>__<tool>. Separate namespace
  -- from enabled_mcp_tools (Skipper's own daemon tools).
  enabled_server_tools TEXT NOT NULL DEFAULT '[]',
  -- Operator-defined tools this agent always has. A team may grant more.
  enabled_custom_tools TEXT NOT NULL DEFAULT '[]',
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
