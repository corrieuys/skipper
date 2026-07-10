-- Free-text contract for how runs of this recurring task use the cross-task
-- global store (key names, payload shape, rolling-window markers). Injected
-- into every spawned run's root prompt; doubles as the explicit authorization
-- the global-store MCP tools require. NULL = no instructions.
ALTER TABLE scheduled_tasks ADD COLUMN global_store_instructions TEXT;
