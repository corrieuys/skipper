-- Per-team settings blob on the runtime local_teams record. Currently holds the
-- Slack opt-in ({ "slackEnabled": true }); a JSON column (like tasks.task_config)
-- so future team-scoped settings need no further migration. Only tasks spawned
-- from a team with slackEnabled get the Slack MCP tools.
ALTER TABLE local_teams ADD COLUMN team_config TEXT NOT NULL DEFAULT '{}';
