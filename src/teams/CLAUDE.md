# src/teams

| file | use |
|---|---|
| `manager.ts` | Team CRUD. Phase mgmt. Membership hierarchy + constraints. Execution-shape resolution. Skipper enforced as entrypoint |

Phases live on team. Each phase names agents + optional consensus config.

Teams persist in the runtime `local_teams` table (`src/teams/local-teams.ts`),
flattened into the shared config `teams`/`team_agents` at boot + on mutation. The
`team_config` JSON column holds per-team settings: `slackEnabled`
(`isSlackEnabledForTeam`), gating the Slack MCP tools for that team's tasks, and
`slashCommand` (`findTeamBySlashCommand`), binding a Slack slash command that
creates + auto-approves a task on this team. See [../slack/CLAUDE.md](../slack/CLAUDE.md).
