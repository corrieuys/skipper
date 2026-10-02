-- Which operator messages (task_messages) have been handed to a task's root
-- Skipper. Agent messages go to the operator on the timeline; the root gets the
-- ones OTHER agents posted, once each, so it does not repeat what the operator
-- has already read. Keyed on the root's template agent id (one root per task),
-- and the message id carries the task. Mirrored in schema.runtime.sql and
-- schema.sql; see PromptBuilder.getUnseenAgentMessages.
CREATE TABLE IF NOT EXISTS agent_message_receipts (
  agent_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES task_messages(id) ON DELETE CASCADE,
  delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_message_receipts_message ON agent_message_receipts(message_id);
