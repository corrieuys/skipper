-- Webhook trigger debounce for recurring tasks. Every incoming webhook stamps
-- webhook_last_event_at; a webhook arriving within webhook_debounce_minutes of
-- the previous webhook is ignored (and still restamps, so sustained fires keep
-- extending the quiet window). Floor 1: the trigger can never run more than
-- once per minute. Cron and manual runs neither stamp nor consume the window.
ALTER TABLE scheduled_tasks ADD COLUMN webhook_debounce_minutes INTEGER NOT NULL DEFAULT 1;
ALTER TABLE scheduled_tasks ADD COLUMN webhook_last_event_at TEXT;
