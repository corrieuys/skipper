# src/custom-agents

Custom agents (experimental). Agent definitions Skipper executes **inside the
daemon process** instead of spawning a vendor CLI.

| file | use |
|---|---|
| `store.ts` | CRUD over the runtime `custom_agents` table. `resolveSecret`/`resolveHeaders` (`${ENV_VAR}`), `registerCustomAgentTypes(db)`, `customAgentTypeName`, `getCustomAgentByType` |
| `runner.ts` | `runCustomAgent()` — one `generateText` call per spawn. `InProcessHandle` (the process stand-in), `NOOP_STDIN`, `buildSystemPrompt`, message load/save for resume |
| `model.ts` | definition → AI SDK model (`createOpenAICompatible`). `probeEndpoint()` for the agent editor's Test button |
| `mcp-tools.ts` | Loopback MCP client → AI SDK tool map, filtered to the enabled list. `wrapMcpTools()` is shared with the server bridge |
| `servers.ts` | CRUD for the MCP server registry. Slug rules, `<slug>__<tool>` naming, tool-catalogue cache, `listImportableServers()` |
| `server-tools.ts` | Connects registered servers (stdio + HTTP). `refreshServerCatalogue()` for the MCP Servers panel, `connectServerTools()` for a run |
| `mcp-catalogue.ts` | The Skipper MCP tools the agent editor offers, grouped. Presentation only — a test asserts every id is really registered |
| `skills.ts` | Skills index for the system prompt + the `load_skill` tool, over `config-readers/skills.ts` |
| `tools/registry.ts` | `LOCAL_TOOLS` — the tools Skipper implements itself. Adding one is a single entry |
| `tools/{read-file,search-replace,list-dir,glob,grep}.ts` | the local tools |
| `tools/paths.ts` | `resolveWithinWorkingDir()` — the only containment these tools have |
| `tools/walk.ts` | bounded BFS file walk + glob→RegExp, shared by glob and grep |

## Why it plugs in without touching the orchestrator

A definition registers an `agent_types` row named `custom:<id>`, so
`getAgentTypeDefinition` resolves it like any other type. On a team a custom agent
is NOT offered in the provider dropdown (that is raw CLIs only now); it is added
from the "+ From library" control as a `custom:<id>` reference member (name + role
only, the record owns the rest). Deleting a definition that a team still
references is blocked (409, `teams/local-teams.ts:teamsReferencingAgentType`).
Those rows are written
into the **in-memory** config DB only: `config/store.ts` seeds the shared tables
from `config/*.json` and never writes them back, so no definition — and no API
key — can reach a committed snapshot. Call `registerCustomAgentTypes` after any
mutation; `index.ts` calls it once at boot.

Custom types are `supports_stdin: false`, `supports_resume: true`, and
`agentTypeUsesInlinePrompt` returns true for them (`agents/types.ts`), so every
spawn site — task-runner, delegation, phase, consensus, idle-poke — already takes
the `initialPrompt` branch and never calls `sendInput`. None of them know custom
agents exist.

Because they are non-streaming, `manager-daemon.ts:hasCompletedTurnOutput` fails a
clean exit that left no `result`/`turn.completed`/`step_finish` frame in
`terminal_outputs`. A CLI emits one every turn; the in-process runner writes plain
text, so `runner.ts` emits a synthetic `step_finish` frame on a clean finish
(skipped when truncated at the step cap). Without it, a turn that ends WITHOUT
calling `complete_task` (e.g. a small model that just answers in prose) is wrongly
failed instead of parked idle for a poke.

`isAllowedProvider` (`config/model-settings.ts`) is deliberately **not** widened:
it gates the config page's Skipper/Greg/Dictation pickers, and a custom agent is
not a root Skipper. That gate does not touch the spawn path, so it does not block
a custom agent from being a task **entrypoint**.

## Running a custom agent SOLO

A custom agent can run a whole task by itself, not only as a team member. Each is
projected as a `ca:<id>` **team-of-one** (`store.ts:flattenCustomAgentsAsSoloTeams`
at boot, `refreshCustomAgentSolo` on mutation) via the shared solo helpers
(`src/agents/solo.ts`): a shared `agents` row `ca:<id>` (type `custom:<id>`) and a
`teams` row whose entrypoint is that agent, no Skipper, no phases. A task assigned
`team_id = ca:<id>` then runs the custom agent as its sole executor - the same
"solo" run context single agents use (`isSoloTeamId`). Written to the shared
**tables only**, never the in-memory config Maps: a `custom:<id>` type is DB-local,
and seeding it into the Maps (which reseed every attached DB) would FK-break
sibling databases.

In a solo run the prompt-builder adds the solo framing as the **user** message
(no delegation, no phases, `complete_task`) on top of the agent's own system
prompt (`buildSystemPrompt`), and the runner auto-includes the solo essential
daemon tools (`complete_task`, `escalate`, notes, artifacts) so the sole executor
can close its own task even if its definition did not tick them. Team-member use
is unchanged: an inline member is namespaced `<teamId>:<authorId>`, not `ca:`, so
it is not solo. See [../single-agents/CLAUDE.md](../single-agents/CLAUDE.md).

## The process that is not a process

`AgentManager` tracks live agents through `AgentProcessHandle` (`pid`, `kill`,
`exited`) and `AgentStdin`; `Bun.Subprocess` satisfies both structurally, so CLI
agents are unchanged. `InProcessHandle` has `pid: null`, `kill()` aborts the model
call, and `exited` settles once with the run's exit code — which drives
`handleProcessExit`, `agent:exit`, and phase advancement exactly as a CLI's exit
does.

Instances write `process_pid = NULL` plus `state_metadata.in_process = true`, which
is what lets health and UI code tell "no pid because in-process" from "no pid
because the spawn has not landed" (a ghost to reap). Guarded sites:
`orchestrator/recovery-manager.ts` (startup liveness probe) and
`agents/manager-daemon.ts` (steer-eligibility). `health-monitor.ts` needs no change
— its pid-null path already defers to the in-memory runtime.

Giving in-process runtimes the daemon's own pid was considered and rejected: it
would make every liveness probe correct and every orphan-kill path lethal.

## The run

One `generateText` per spawn, step-capped, mirroring a CLI's one-invocation-one-
exit-code shape. Output splits three ways:

| path | scanned for signals | buffered |
|---|---|---|
| assistant prose → `ingestSyntheticStdout` | yes | stdout |
| tool calls/results → `appendSyntheticOutput` | no | no |
| failures → `ingestSyntheticStderr` | no | stderr (reaches `agent:exit`) |

Tool renderings are not scanned because a marker inside a tool argument is not the
agent signalling. A tool call the agent was not granted is refused and **said so**
on stderr — silence there reads as "the edit worked".

Resume: custom agents have no vendor session store, so Skipper keeps its own in
`custom_agent_messages`, keyed by the session id threaded through
`agent_instances.session_id`.

## Tools

Local tools come from `LOCAL_TOOLS`; contracts for the file tools are ported from
xAI's grok-build (Apache-2.0) — `read_file` (offset/limit, every line prefixed
`N→`) and `search_replace`, which is **both write and edit**: `old_string` must
match exactly once, and an empty `old_string` creates a file but will not
overwrite an existing non-empty one. There is no `bash` tool.

### MCP servers

Beyond Skipper's own tools, an agent can be granted tools from MCP servers
registered on the Custom Agents page (`custom_agent_mcp_servers`). Both transports:
stdio (command + args + env, spawned per run) and streamable HTTP (url +
headers). `env` and `headers` take `${ENV_VAR}` like everything else here.

Tools are namespaced `<slug>__<tool>` — two servers may both offer `search`, and
the prefix is what keeps them apart in one tool map. The slug is derived from the
name, unique, and capped at 24 chars so the qualified name stays inside the
64-char limit providers put on function names.

Discovery is **cached, not live**: `refreshServerCatalogue()` connects on save
and on the panel's Refresh button, storing the tool list on the row. The agent
form renders from that cache, so an unreachable stdio server cannot hang the
page. A failed refresh keeps the previous list and records the error alongside
it, rather than silently stripping an agent's checkboxes.

At run time only servers with at least one enabled tool are contacted, so an
agent that uses none spawns nothing. A server that will not connect contributes
its enabled names to a stderr line and the run continues. `close()` runs in the
runner's `finally` — closing a stdio client kills its child, so a cancelled run
does not leave servers behind.

Importing from the Claude/Codex configs (`config-readers/mcp.ts`) **copies** the
values in. Editing Skipper's copy never writes back to a file we do not own.

### Skipper's own tools

Skipper's own tools are reached over the daemon's `/mcp` on localhost with the
instance id as the bearer token, rather than by calling `mcp/tools.ts` directly.
That keeps one set of rules: the daemon still decides root vs delegated
visibility, and `signal-bridge` dedup still applies. An unreachable daemon
degrades to local tools with a note, rather than failing the task at spawn.

**Enabling is a filter on the tool map**, not `activeTools` — a disabled tool is
never serialised into the request, so the model cannot see or name it.

Daemon tools are exposed to the model as `mcp__skipper-daemon__<tool>`
(`mcp-tools.ts:daemonToolName`), matching what a CLI agent sees and what the
injected prompt templates say. The enabled list, the daemon wire name, and the
signal bridge all stay on the bare name; only the model-facing key is prefixed
(bare fallback if the prefixed name would pass the 64-char provider cap).

### Operator-defined tools

A custom agent can also be granted tools from `src/custom-tools`, ticked on its
own page (always-on) or on its team agent card (per team). Those execute over the
same loopback as Skipper's own tools — see
[../custom-tools/CLAUDE.md](../custom-tools/CLAUDE.md).

## Providers

OpenAI-compatible chat completions only, which covers the commercial APIs (OpenAI,
xAI, Groq, OpenRouter, Together, Azure) and the local runners (LM Studio,
llama.cpp's `llama-server`, Ollama, vLLM). The differences are config:

- local servers need no key — an empty `apiKey` sends **no** Authorization header
  rather than an empty bearer, which some servers reject
- Azure wants an `api-key` header and `api-version` in the query string, hence
  `headers` and `queryParams`
- any value in `apiKey`, `headers` or `queryParams` may be `${ENV_VAR}`, resolved
  at call time, so the real secret can stay out of the database

Anthropic's Messages API is a different wire format; it would need
`@ai-sdk/anthropic` plus a format selector on the definition.

## UI + routes

`/custom-agents` (list) and `/custom-agents/:id` (editor) — `/agents` is already
the agent-terminal page. API under `/api/custom-agents`, plus
`POST /api/custom-agents/probe`, which hits `GET {baseUrl}/models` to verify the
endpoint and populate the model picker.

The server registry lives on `/custom-agents` (`html/pages/custom-agents.page.ts:mcpServersPanel`)
under `/api/custom-agent-servers`; every mutation returns the re-rendered panel
for an htmx swap, like the API-keys panel. Everything 404s without
`--experimental`.

Secrets are never sent to the browser: the API redacts them to `__stored__`, the
editor renders that as a blank field, and blank on save means unchanged (same
contract as the Slack bot token).
