-- Indexes on child columns that task deletes cascade through. Without them each
-- cascade step (and the retention sweep) scans the whole child table:
--   tasks -> task_checkpoints.task_id
--   tasks -> task_notes -> agent_note_receipts.note_id
--   tasks -> task_input_streams -> task_artifact_refs.input_stream_id (SET NULL)
-- (task_id, sequence) also serves the next-sequence MAX() on every checkpoint
-- write. schema.runtime.sql carries the same three for fresh DBs.
CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task_seq ON task_checkpoints(task_id, sequence);
CREATE INDEX IF NOT EXISTS idx_agent_note_receipts_note ON agent_note_receipts(note_id);
CREATE INDEX IF NOT EXISTS idx_task_artifact_refs_input_stream ON task_artifact_refs(input_stream_id);

-- A recurring task's runs, newest first: the sidebar run strip
-- (fetchRecentScheduledRuns, on every command-center build), the series run
-- list and the per-series active-run count. Only here, not in
-- schema.runtime.sql: that file runs before legacy-migrations adds
-- source_scheduled_task_id to an old tasks table.
CREATE INDEX IF NOT EXISTS idx_tasks_source_scheduled ON tasks(source_scheduled_task_id, created_at);

-- Every agent_note_receipts lookup leads with agent_instance_id, which the
-- (agent_instance_id, note_id) primary key already indexes.
DROP INDEX IF EXISTS idx_agent_note_receipts_instance;
