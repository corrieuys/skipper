# src/teams

| file | use |
|---|---|
| `manager.ts` | Team CRUD. Phase mgmt. Membership + constraints. Execution-shape resolution. Skipper enforced as entrypoint |
| `team-input.ts` | `toTeamInput` — coerce raw create/update/import bodies (JSON or team-map form payloads) into `LocalTeamInput`. Shared by `/api/teams` and `/data/teams` |

Phases live on team. Each phase carries a prompt + optional review gate.

Each member may also carry `customTools` — operator-defined tool names granted to
that agent on that team (`src/custom-tools`). This is the only route by which a
CLI agent gets one; a custom agent can additionally carry its own always-on list,
and a session receives the union. The team's Skipper (implicit entrypoint, no
member row) is granted via `team_config.skipperCustomTools`, edited on the team
map's Skipper card.

Membership is flat. `team_agents` carries `role` + `level` only — there is no
reporting hierarchy, and the delegate roster an agent is given
(`agents/prompt-builder.ts:getTeamRoster`) lists every member of the task's team.

Each inline member may also carry a chosen identity — `color` (hex) + creature
`character` (`html/atoms/creature.ts`) — stored on `LocalTeamAgent` (rides the
`local_teams.agents` JSON array, no migration), whitelisted in
`team-input.ts:coerceAgent`, and projected into `agents.config` via `toSharedAgent`
so the orb + timeline read it. A library-reference member (`single:`/`custom:`)
inherits the referenced record's identity at flatten time (`resolveTeamAgentRefs`).
Edited on the team map's agent modal (a cloned identity-picker template).

UI: the team map at `/teams` — see [../html/CLAUDE.md](../html/CLAUDE.md). It
writes the `/api/teams` endpoints, which also accept form and import bodies. The
provider dropdown offers **raw CLIs only**. Saved agents (headless CLI + custom)
are added through the crew's "+ From library" control (experimental) as **live
references**, not copies: the member stores just a ref token + display name/role
(`single:<id>` for a headless CLI agent, `custom:<id>` for a custom agent) and
`local-teams.ts:resolveTeamAgentRefs` resolves the record's provider, model,
prompt, capabilities and tools at flatten time. So editing the library agent
updates every team that references it — `single:<id>` edits re-project via
`reflattenTeamsReferencingAgentType` (called from the single-agents route);
`custom:<id>` resolves in-process at run time. A referenced member exposes only
name + role in its modal (the record owns the rest). Deleting a library agent
that a team still references is **blocked** (409, `teamsReferencingAgentType`),
and a save carrying a dangling `single:<id>` ref is rejected (`validateInput`).

Teams persist in the runtime `local_teams` table (`src/teams/local-teams.ts`),
flattened into the shared config `teams`/`team_agents` at boot + on mutation. The
`team_config` JSON column holds per-team settings: `slackEnabled`
(`isSlackEnabledForTeam`), gating the Slack MCP tools for that team's tasks, and
`slashCommand` (`findTeamBySlashCommand`), binding a Slack slash command that
creates + auto-approves a task on this team. See [../slack/CLAUDE.md](../slack/CLAUDE.md).

`team_config` also carries the team **icon**: `icon` (a Lucide icon id) + `iconColor`
(hex), edited on the team map's Team settings modal (core, not experimental — a
shared `icon-identity-picker` seeded via `window.SkipperIcons`), coerced in
`team-input.ts:coerceTeamConfig`, and surfaced to the sidebar Teams board by
`data/command-center.ts:fetchStandardTaskTeams` (which `json_extract`s it from
`local_teams.team_config`). Raw strings are stored; the render layer
(`html/atoms/lucide:entityIcon`) validates the id and clamps the color.

`team_config` also carries the team **mode**: `mode: 'workflow' | 'conversational'`
(absent = workflow; legacy stored values `'regular'`/`'realtime'` are read as
aliases via `normalizeTeamMode`, predicate `isConversationalTeam`). The mode
only sets the DEFAULT task autopilot (presented as "Autopilot default" in the
team settings modal); both modes support phases (0..n — the old phase-count
guard is gone). Teams may expose
`config.realtime = { summaryEnabled, summaryProvider, summaryModel }` — the
per-team transcription-summary config the input pipeline reads
(`orchestrator/realtime-session.ts:getRealtimeSummaryConfig`). Team pickers are
UNIFIED: `config/teams.ts:listAssignableTeams()` lists every visible team
regardless of mode (the old `listRealtimeTeams`/`listTeamsForStandardTasks`
mode split is gone — any team runs any task); the provider list for the
summary model comes from
`model-settings.ts:listModelOptions` (never a hardcoded model). The built-in
"Real Time" team predates this and keeps its legacy summarizer default.
