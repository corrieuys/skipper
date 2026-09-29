-- Improvements: configuration changes a root Skipper stages at the end of a run
-- (phase prompts, agent instructions, team lead instructions, a recurring task's
-- description) plus skill suggestions. Nothing is applied until the operator
-- approves it on the Improvements page. See src/improvements/manager.ts.
--
-- No FKs: a proposal outlives the run that staged it (retention deletes settled
-- runs) and must survive team / recurring-task edits, which is how a conflict
-- is detected (live text revision != base_revision).
CREATE TABLE IF NOT EXISTS improvements (
  id TEXT PRIMARY KEY,
  -- phase_prompt | agent_instruction | lead_instructions | recurring_description | skill_suggestion
  kind TEXT NOT NULL,
  -- pending | approved | rejected
  status TEXT NOT NULL DEFAULT 'pending',
  -- Groups proposals on the same target (e.g. two runs editing one phase).
  target_key TEXT NOT NULL,
  -- Display label captured at staging time.
  target_label TEXT NOT NULL,
  team_id TEXT,
  scheduled_task_id TEXT,
  phase_index INTEGER,
  phase_name TEXT,
  -- Team member id (inline), 'single:<id>' / 'custom:<id>' (library agent), or
  -- the skill's agent for a skill suggestion.
  agent_ref TEXT,
  skill_name TEXT,
  -- Live text the proposal was written against, and its revision (hash).
  before_text TEXT NOT NULL DEFAULT '',
  base_revision TEXT NOT NULL DEFAULT '',
  proposed_text TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_task_id TEXT,
  source_task_title TEXT,
  edited_at TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_improvements_status ON improvements(status, created_at);
CREATE INDEX IF NOT EXISTS idx_improvements_target ON improvements(target_key, status);
