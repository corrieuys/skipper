-- Latest glyph (Canvas) screen per task, so the overlay survives a daemon
-- restart: the frame as the renderer last left it, the per-register cursor it
-- had consumed, and the model session to resume. Written by GlyphEngine after
-- every successful render/patch; the row goes with the task.
CREATE TABLE IF NOT EXISTS glyph_screens (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  frame TEXT NOT NULL,
  cursor TEXT NOT NULL DEFAULT '{}',
  session_id TEXT,
  calls INTEGER NOT NULL DEFAULT 0,
  -- Fingerprint of the task summary (status, phase, review flag) at the last
  -- wake, so a restart can tell a quiet task from one whose status moved.
  summary_fp TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
