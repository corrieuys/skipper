-- Generic global key/value store shared across all task instances.
-- Agents decide the meaning of type/data/status; Skipper owns name (PK) + updated_at.
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
