# src/custom-tools

Operator-defined tools (experimental). A name, a description, parameters, and a
JavaScript body Skipper runs when an agent calls it.

| file | use |
|---|---|
| `store.ts` | CRUD over the runtime `custom_tools` table. Name/parameter validation, reserved-name guard, `toolZodShape()` |
| `runtime.ts` | `executeCustomTool()` — runs a body in a terminated-on-timeout Worker. `formatExecution()` builds the tool-result text |
| `registration.ts` | `resolveSessionCustomTools()` (who gets what) and `registerCustomTools()` (put them on an MCP session) |

## Who gets a tool

Two independent grants, and a session receives the **union**:

| surface | scope | reaches |
|---|---|---|
| custom agent definition (`/custom-agents/:id`) → `custom_agents.enabled_custom_tools` | that agent, wherever it is used | custom agents |
| team agent card (the team map's agent modal) → `local_teams.agents[].customTools` | that agent, on that team | **any** agent, CLI ones included |

The team grant is the only way a `claude-code` or `codex` agent gets a custom
tool. Union rather than override because the two answer different questions, and
an operator who ticked either box meant it.

`resolveSessionCustomTools` reads the instance's own resolved provider
(`state_metadata.provider_type`, not the template row — a machine-scoped override
makes those differ) and the task's team. A granted name whose tool has since been
deleted is simply dropped.

## Why the MCP server, not the runner's tool map

Tools are registered on the daemon's MCP session (`mcp/tools.ts`, last, so a name
that slipped past the reserved-name guard cannot shadow a built-in). That is what
lets a CLI agent have one at all — it reaches the tool over `/mcp` like any other.
A custom agent gets it through the loopback client it already uses for
`create_note`, so both agent kinds execute by the identical path.

The runner resolves the names with `resolveSessionCustomTools` rather than reading
`agent.enabledCustomTools`, or a tool granted by the **team** would be registered
on the session and then filtered back out client-side.

External (API-key) sessions get none: those are not an agent on a task, so there
is nothing to resolve a grant from.

## Execution

The body is compiled with `AsyncFunction` and given exactly four names — `args`,
`ctx` (`taskId`, `agentId`, `instanceId`, `workingDir`), `console` (captured and
attached to the tool result) and `fetch` — then `await`ed. It must `return` its
result; objects are JSON-serialised.

**It runs in a Worker, not on the daemon's event loop.** A tool with an infinite
loop cannot be interrupted in-thread, and hanging the orchestrator is far worse
than a tool call failing; on timeout the worker is terminated outright, which does
stop a busy loop. The worker source is an inline string over a blob URL rather
than a separate module, so `bun build --compile` has nothing to resolve and the
compiled binary behaves like the dev run.

This is isolation from the daemon's state and event loop, **not a security
sandbox**: the code is the operator's own and can still reach the network. Treat a
custom tool like any other script run on that machine.

Failures — a throw, a syntax error, a timeout — come back as tool-result text, not
as an exception. A model can read that and try something else; killing the turn
teaches it nothing. The worker builds the error string itself (`name: message`
plus a few frames) because a worker's `err.stack` can arrive with no message on
the first line, leaving the model a trace with no reason in it.

## Schema

Parameter rows (`{name, type, description, required}`) are the single source of
truth; `toolZodShape()` derives the Zod raw shape at registration. It must be a
Zod shape — `McpServer.tool` rejects a plain JSON Schema object, which is also why
Skipper's own tools pass zod.

Names are validated against what a provider accepts as a function name, and
checked against `RESERVED_NAMES` so a custom tool cannot quietly replace
`create_note` or `read_file` on a session.

## UI + routes

The **Custom Tools** panel on `/custom-agents` (`html/pages/custom-agents.page.ts:customToolsPanel`)
lists one editor per tool plus a new-tool form, over `/api/custom-tools`.
`POST /api/custom-tools/test` runs a body from the form's current values through
the same worker and timeout, so a typo surfaces while writing the tool rather than
mid-task. Everything 404s without `--experimental`.
