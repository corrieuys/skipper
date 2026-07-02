-- Public artifact links via Skipper Connect: publish_key is generated once per
-- artifact version and never rotated; published_at NULL means not published.
ALTER TABLE task_artifacts ADD COLUMN publish_key TEXT;
ALTER TABLE task_artifacts ADD COLUMN published_at TEXT;
