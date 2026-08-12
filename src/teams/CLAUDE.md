# src/teams

| file | use |
|---|---|
| `manager.ts` | Team CRUD. Phase mgmt. Membership + constraints. Execution-shape resolution. Skipper enforced as entrypoint |
| `team-input.ts` | `toTeamInput` — coerce raw create/update/import bodies (JSON or team-map form payloads) into `LocalTeamInput`. Shared by `/api/teams` and `/data/teams` |

Phases live on team. Each phase names agents + optional consensus config.

Each member may also carry `customTools` — operator-defined tool names granted to
that agent on that team (`src/custom-tools`). This is the only route by which a
CLI agent gets one; a custom agent can additionally carry its own always-on list,
and a session receives the union.

Membership is flat. `team_agents` carries `role` + `level` only — there is no
reporting hierarchy, and the delegate roster an agent is given
(`agents/prompt-builder.ts:getTeamRoster`) lists every member of the task's team.

UI: the team map at `/teams` — see [../html/CLAUDE.md](../html/CLAUDE.md). It
writes the `/api/teams` endpoints, which also accept form and import bodies.

Teams persist in the runtime `local_teams` table (`src/teams/local-teams.ts`),
flattened into the shared config `teams`/`team_agents` at boot + on mutation. The
`team_config` JSON column holds per-team settings: `slackEnabled`
(`isSlackEnabledForTeam`), gating the Slack MCP tools for that team's tasks, and
`slashCommand` (`findTeamBySlashCommand`), binding a Slack slash command that
creates + auto-approves a task on this team. See [../slack/CLAUDE.md](../slack/CLAUDE.md).
