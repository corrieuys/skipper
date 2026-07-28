# src/teams

| file | use |
|---|---|
| `manager.ts` | Team CRUD. Phase mgmt. Membership + constraints. Execution-shape resolution. Skipper enforced as entrypoint |

Phases live on team. Each phase names agents + optional consensus config.

Membership is flat. `team_agents` carries `role` + `level` only — there is no
reporting hierarchy, and the delegate roster an agent is given
(`agents/prompt-builder.ts:getTeamRoster`) lists every member of the task's team.

UI: the config-page form (`src/html/pages/local-team-form.page.ts`) is the current
editor. Behind `--experimental` there is also a standalone team map at `/teams`
— see [../html/CLAUDE.md](../html/CLAUDE.md). Both write the same
`/api/teams` endpoints, so a team edited in one shows up in the other.

Teams persist in the runtime `local_teams` table (`src/teams/local-teams.ts`),
flattened into the shared config `teams`/`team_agents` at boot + on mutation. The
`team_config` JSON column holds per-team settings: `slackEnabled`
(`isSlackEnabledForTeam`), gating the Slack MCP tools for that team's tasks, and
`slashCommand` (`findTeamBySlashCommand`), binding a Slack slash command that
creates + auto-approves a task on this team. See [../slack/CLAUDE.md](../slack/CLAUDE.md).
