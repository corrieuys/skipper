-- Per-task memory: a copy of every operator-facing exchange on a task (agent
-- messages, operator text input, audio summaries, agent + operator notes), each
-- stamped with who said it and when, plus an embedding so agents can query it
-- semantically through the query_task_memory MCP tool. Written by the daemon
-- only (TaskMemoryManager listens on the bus); agents never write here.
-- ref_id is the source row id, so a backfill re-run is idempotent.
CREATE TABLE IF NOT EXISTS task_memory (
  id TEXT PRIMARY KEY,
  -- Owner: 'task:<id>' (one-off task or per-run mode) or 'series:<scheduled_task_id>'
  -- (shared across a recurring task's runs). Rows belong to the scope, not the
  -- run: no FK on task_id, so recurring-run retention cannot erase shared memory.
  scope_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  -- Run title + start time captured at write time, so attribution survives run deletion.
  run_label TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'input', 'summary', 'note')),
  author TEXT NOT NULL CHECK (author IN ('agent', 'user')),
  agent_id TEXT,
  content TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  embedding BLOB,
  embedding_model TEXT,
  -- Soft delete by an agent (delete_task_memory): hidden from queries, kept for audit.
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_memory_scope_ref ON task_memory(scope_id, ref_id);
CREATE INDEX IF NOT EXISTS idx_task_memory_scope_time ON task_memory(scope_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_memory_task ON task_memory(task_id);
