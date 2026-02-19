ALTER TABLE realtime_timeline ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high'));
