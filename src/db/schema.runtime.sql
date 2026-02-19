-- Runtime/local database schema (ephemeral and machine-specific)

-- Tasks
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  team_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'running', 'completed', 'failed')),
  current_phase INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  orchestration_state TEXT NOT NULL DEFAULT '{}',
  regression_count INTEGER NOT NULL DEFAULT 0,
  iteration_count INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  working_directory TEXT NOT NULL DEFAULT '',
  task_type TEXT NOT NULL DEFAULT 'standard' CHECK (task_type IN ('standard', 'real_time')),
  task_config TEXT NOT NULL DEFAULT '{}',
  source_scheduled_task_id TEXT,
  -- Set to 1 by handleAgentExit when a single_instance scheduled task's
  -- Skipper exits cleanly. The next scheduled fire prepends a context-
  -- compaction instruction to Skipper's prompt and clears the flag.
  pending_compact INTEGER NOT NULL DEFAULT 0,
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
  last_signal_at TEXT,
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
  parent_instance_id TEXT,
  child_instance_id TEXT,
  delegation_group_id TEXT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  prompt TEXT NOT NULL,
  result TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Runtime process/session identities for parallel ephemeral workers
CREATE TABLE IF NOT EXISTS agent_instances (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  template_agent_id TEXT NOT NULL,
  parent_instance_id TEXT,
  root_instance_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'waiting_delegation', 'completed', 'failed', 'stopped')),
  process_pid INTEGER,
  session_id TEXT,
  state_metadata TEXT NOT NULL DEFAULT '{}',
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_instances_task ON agent_instances(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_instances_template ON agent_instances(template_agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_instances_status ON agent_instances(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_delegations_task_status ON delegations(task_id, status);
CREATE INDEX IF NOT EXISTS idx_delegations_parent_instance ON delegations(parent_instance_id, status);
CREATE INDEX IF NOT EXISTS idx_delegations_child_instance ON delegations(child_instance_id, status);

-- Delegation barrier for parallel fan-out completion
CREATE TABLE IF NOT EXISTS delegation_groups (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_instance_id TEXT NOT NULL,
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



-- Task notes for inter-agent knowledge sharing — millisecond-precision created_at
CREATE TABLE IF NOT EXISTS task_notes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes(task_id, created_at);

-- Escalation records
CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  runtime_agent_id TEXT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  type TEXT NOT NULL,
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

-- Conversational Skipper chat conversations (template_agent_id has no FK in runtime mode)
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New Conversation',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  agent_instance_id TEXT,
  session_id TEXT,
  template_agent_id TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'bypassPermissions'
    CHECK (permission_mode IN ('default', 'plan', 'bypassPermissions')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status, updated_at DESC);

-- Chat messages for conversational Skipper
CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv ON conversation_messages(conversation_id, created_at);

-- Tracks which task notes have been delivered to which agent instances
CREATE TABLE IF NOT EXISTS agent_note_receipts (
  agent_instance_id TEXT NOT NULL,
  note_id TEXT NOT NULL REFERENCES task_notes(id) ON DELETE CASCADE,
  delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_instance_id, note_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_note_receipts_instance ON agent_note_receipts(agent_instance_id);

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
  team_id TEXT,
  working_directory TEXT NOT NULL DEFAULT '',
  schedule_unit TEXT NOT NULL CHECK (schedule_unit IN ('minutes', 'hours', 'days')),
  schedule_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  task_config TEXT NOT NULL DEFAULT '{}',
  next_run_at TEXT,
  last_run_at TEXT,
  -- single_instance=1: each fire respawns Skipper against ONE persistent
  -- tasks row instead of creating a new task per fire. End-of-fire sets
  -- tasks.pending_compact=1 so the next fire's prompt starts with a
  -- context-compaction instruction.
  single_instance INTEGER NOT NULL DEFAULT 0,
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

