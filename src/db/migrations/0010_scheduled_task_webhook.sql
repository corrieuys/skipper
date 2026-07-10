-- Webhook trigger for recurring tasks via Skipper Connect: webhook_key is the
-- per-task secret embedded in the public trigger URL
-- (POST https://<integrator>/wh/<gid>/<scheduledTaskId>?key=<webhook_key>).
-- NULL means the webhook trigger is disabled. Regenerating the key revokes
-- previously shared URLs. The daemon validates the key; the integrator only relays.
ALTER TABLE scheduled_tasks ADD COLUMN webhook_key TEXT;
