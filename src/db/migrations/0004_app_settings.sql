-- Typed key-value app settings (mutable runtime state, not JSON config)
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string' CHECK (value_type IN ('boolean', 'number', 'string', 'json')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
