# src/single-agents

A **single agent** (operator-facing label: **headless CLI agent**): a standalone
agent (NOT the root Skipper) that runs one regular/recurring task by itself. No
delegation, no phases, but the full internal tool surface (notes, artifacts,
escalate, global store) plus `complete_task`. Experimental (`isExperimental()`).
Internal code names stay `single agent` / `SingleAgent` / `sa:` — only user-facing
copy says "headless CLI agent" (same rule as recurring vs `ScheduledTask*`).

| file | use |
|---|---|
| `store.ts` | `single_agents` runtime-table CRUD + the **team-of-one projection**. `SingleAgent`/`SingleAgentInput`/`SingleAgentConfig` types; `create/update/delete/get/listSingleAgents`; `flattenSingleAgentsIntoStore` (boot). Slack helpers `findSingleAgentBySlashCommand`, `isSlackEnabledForSingleAgent`, `getSingleAgentByTeamId`. Id helpers `singleAgentTeamId`/`singleAgentAgentId`/`isSingleAgentId`/`singleAgentIdFromProjected`. |

Two distinct prefixes, do not confuse them: `sa:<id>` is the SOLO projection (a
whole team-of-one, this agent runs a task alone — everything below). `single:<id>`
is the team-member REFERENCE token: the same record used as one member inside a
regular team, resolved live at team-flatten time
(`teams/local-teams.ts:resolveTeamAgentRefs`). Helpers `singleAgentRefType` /
`isSingleAgentRefType` / `singleAgentIdFromRefType`. Editing the record
re-projects referencing teams (`reflattenTeamsReferencingAgentType`, called from
the route); deleting one that a team references is blocked (409). See
[../teams/CLAUDE.md](../teams/CLAUDE.md).

"Solo" is a shared RUN CONTEXT, not just this entity. The generic projection +
detection live in [../agents/solo.ts](../agents/solo.ts) (`projectSoloIntoMaps`/
`upsertSoloIntoSharedTables`/`isSoloTeamId`, prefixes `sa:` single agent, `ca:`
custom agent run solo). This module builds the `sa:` spec and calls those helpers;
custom agents build a `ca:` spec the same way (see
[../custom-agents/CLAUDE.md](../custom-agents/CLAUDE.md)). Every solo consumer
(prompt variant, tool profile, iterate-resume, sidebar group) keys on `isSolo*`,
so single agents and custom-agents-run-solo share one code path.

## Projection (the whole trick)

There is **no** agent-keyed task pipeline. A single agent is PROJECTED into the
shared config layer as a team of one, so the entire team-keyed pipeline
(task-runner, recovery, health, Slack, recurring) runs it unchanged:

- shared `agents` row - id `sa:<id>`, type/model/instruction from the record
- shared `teams` row - id `sa:<id>`, `entrypoint_agent_id = sa:<id>`, **no skipper
  lead**, `phases: []`
- one `team_agents` row - the agent as the level-0 lead

A task is "assigned to a single agent" by setting `tasks.team_id = sa:<id>`. The
`sa:` prefix is the single signal every consumer keys on:

- **prompt** - `prompt-builder.ts` sees `agent.id` starts with `sa:` → uses
  `prompts/single-agent.md` (NOT `skipper.md`) + `prompts/mcp-tools-single.md`, and
  skips the team roster + delegation block.
- **tools** - `mcp/server.ts:isSingleAgentRuntime` (task's `team_id` starts with
  `sa:`) → `registerDaemonTools({ isSingleAgent: true })`: drops
  delegation/consensus/phase/recurring, keeps `complete_task` + notes/artifacts/
  escalate/global-store. See [../mcp/CLAUDE.md](../mcp/CLAUDE.md).
- **Slack** - a single-agent task carries no `local_teams` row, so
  `isSlackEnabledForTeam` would return false; `mcp/tools.ts` + `slack/push.ts`
  detect the `sa:` prefix and read the opt-in from the single_agents record
  instead. Slash-command trigger: `slack/commands.ts` (`findSingleAgentBySlashCommand`
  → create + approve a task with `team_id = sa:<id>`), conflict-checked by
  `slack/bindings.ts` (`kind: "agent"`).

Flattened into the store Maps at boot by `flattenSingleAgentsIntoStore`
(`db/connection.ts`, beside `flattenLocalTeamsIntoStore`) and re-projected on every
mutation, so edits take effect without a restart. Model/provider come from the
record (never Skipper's `SETTING_SKIPPER_*` override - `agents/manager.ts` gates
that override to the `skipper` template id).

Persisted in the runtime DB (`single_agents`, migration `0022`), never the shared
committed config tables - same rule as `local_teams`/`custom_agents`.

UI: single agents are browsed in the **combined agent library** at
`/agent-library` (nav "Agents"; `/single-agents` 302s there) - see
[../html/CLAUDE.md](../html/CLAUDE.md). Editor at `/single-agents/:id` +
`/single-agents/new`; CRUD under `/api/single-agents`
(`src/routes/single-agents.ts`). Assignable from the task form's team/agent
picker (`/fragments/task-form/team`, one "Agents" optgroup).
