-- Per-delegation working directory override. NULL = inherit the task's
-- working_directory (the default). When set by the `delegate` MCP tool it is both
-- the path named in the child's prompt header and the cwd its process starts in.
-- Stored rather than passed in memory because a delegation retry respawns the
-- child from this row long after the original tool call is gone.
ALTER TABLE delegations ADD COLUMN working_directory TEXT;
