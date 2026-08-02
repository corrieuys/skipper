-- Operator messages: short, plain-language updates an agent posts for the human
-- watching the task. Separate from task_notes because the audience is different —
-- notes are written for the next agent and are injected into agent context;
-- messages are written for the operator and are never fed back to an agent.
-- created_at carries millisecond precision so rapid-fire posts from concurrent
-- agents keep a stable order, same as task_notes.
CREATE TABLE IF NOT EXISTS task_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  agent_instance_id TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_task_messages_task ON task_messages(task_id, created_at);
