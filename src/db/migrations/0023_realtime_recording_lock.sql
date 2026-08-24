-- Cross-client single-writer audio recording lock for realtime tasks.
-- Only one audio source (web UI, iOS app, or a Skipper Connect consumer) may
-- record into a given realtime task at a time. The owner is claimed on
-- recording start and released on stop, disconnect, or lease expiry.
-- recording_activity_at drives the lease: a lock whose last audio chunk is
-- older than max(30s, 2*cadence) is considered stale and auto-released.
ALTER TABLE realtime_pipeline_state ADD COLUMN recording_owner TEXT;
ALTER TABLE realtime_pipeline_state ADD COLUMN recording_owner_label TEXT;
ALTER TABLE realtime_pipeline_state ADD COLUMN recording_activity_at TEXT;
