# src/mcp

Model Context Protocol server. Alternative to stdout signal parsing — agents call typed tools.

| file | use |
|---|---|
| `server.ts` | `DaemonMcpServer`. Streamable HTTP transport (POST `/mcp` msg, GET `/mcp` SSE, DELETE `/mcp` end). Bearer token = agent runtimeId or API key |
| `auth.ts` | Token → `AgentIdentity` resolve. Union type: `InternalAgentIdentity` (running agents) or `ExternalIdentity` (API keys). Internal-instance validity is **task-scoped**: an instance token resolves while `ai.status='running'` OR its **task** is still `running` — the instance id belongs to the task for the task's lifetime, so a live process is not 401'd when a concurrent exit handler momentarily parks `agent_instances.status` off `running` (the old "token expired mid-run" race — a root awaiting delegations while resolving an escalation). `describeTokenState()` snapshots the row states for the `mcp_auth_reject` log emitted by `server.ts` on every 401 (previously silent) |
| `tools.ts` | Internal tool definitions + impl. Three session modes: root (all tools), delegated (no phase-control), external (task management only). Delegates the task-management surface to `task-tools.ts` |
| `task-tools.ts` | Audience-tagged task-management tool registry. Each spec carries `audience: "internal" \| "external" \| "both"`; `registerTaskTools(server, deps, getIdentity, audience)` registers the matching subset. One knob controls visibility — flip a spec's audience, no other wiring. Called with `"external"` from `registerExternalTools` and `"internal"` at the end of `registerDaemonTools` (registers nothing today — all specs are external). `taskToolNamesFor(audience)` lists the names |
| `tools-registration.test.ts` | which tools each session mode gets |
| `slack-tools.test.ts` | what the Slack tools *do* when invoked: origin capture (which ts anchors), plus `escalate`'s `slack_warning` gates. Stubs the Slack Web API by swapping `globalThis.fetch` |
| `signal-bridge.ts` | Convert MCP tool calls → `agent:signal` events (so handlers stay one path) |

Role-based tool visibility locked at session create. Three identity types:
- **Internal root**: full tool set (notes, artifacts, delegation, escalation, phase control, consensus, global store)
- **Internal delegated**: same minus phase-lifecycle tools. Also applies to **one-off runs** — an instance flagged `state_metadata.oneshot=true` (operator resume on a completed task) is treated as delegated by `server.ts:isDelegatedRuntime`, so phase/task-lifecycle tools are omitted.

Global-store tools (`set_global_value`, `get_global_value`, `query_global_store`, `delete_global_value`) read/write the cross-task `global_store` table via `GlobalStoreManager` (`src/global-store/`). Available to root + delegated. Prompts instruct agents to use them only when a task/phase/template explicitly asks.

Slack tools (`slack_send_message`, `slack_send_dm`, `slack_read_channel`) post/read as the Skipper Slack app via the bot token. **Root-only**, like the phase-lifecycle tools — only Skipper talks via Slack, so a task's thread stays one voice; delegated children reach the operator by escalating, which the push forwards into the same thread. Registered on a session only when not delegated + `isExperimental()` + `isSlackConfigured(db)` + the task's team has `slackEnabled` (see [../slack/CLAUDE.md](../slack/CLAUDE.md)). The two **send** tools also `stampTaskSlackOrigin` — a task with no Slack origin yet adopts the thread the agent just posted into, so its escalations/reviews/completion notice follow (first write wins; a slash-command origin is never replaced). When a send is the one that captured the origin, its result carries `thread_ts` + a `note` explaining what the thread now means — the live agent's only way to learn this, since prompts aren't rebuilt mid-turn. A run with an origin gets a `SLACK ORIGIN` block on later prompt builds. `escalate` returns a `slack_warning` when the question exceeds `SLACK_ESCALATION_SOFT_LIMIT` **and** the task has a Slack origin — Slack clips the escalation block at `ESCALATION_TEXT_LIMIT` and agents put the ask last, so the operator would answer a fragment. Both constants come from `slack/blocks.ts`; nothing here restates them as a literal. It warns rather than rejects (an escalating agent is already stuck, and the full text is readable in the web UI) and is the only surface that reaches an agent whose prompt predates the origin.
- **External** (API key): task management + discovery only — `create_task`, `get_task`, `list_tasks`, `list_active_tasks`, `update_task` (draft-only edit), `approve_task`, `pause_task`, `resume_task` (paused→running), `cancel_task`, `complete_task`, `list_teams`, plus recurring tasks: `list_recurring_tasks`, `run_recurring_task` (one-off "Run Now" on an approved recurring task, optional `prompt` → the run's `run_input`; mirrors the Slack slash-command path — impl via `ScheduledTaskScheduler.runTaskNow`, the internal class name). All defined in `task-tools.ts`, tagged `audience: "external"`, so none are exposed to internal agents. The two task-list tools return **newest-first, paginated** results — `{ tasks, pagination: { page, page_size, total, total_pages, has_more } }`, `page` 1-based, `page_size` default 20 / max 100 — so a caller with hundreds of tasks pages through bounded chunks.

## External access

External agents authenticate with API keys (managed via `/api/api-keys`, or the API Keys panel on `/config` under `--experimental`). Configure in `.mcp.json`:
```json
{ "mcpServers": { "skipper": { "type": "streamableHttp", "url": "http://localhost:5005/mcp", "headers": { "Authorization": "Bearer <api-key>" } } } }
```

The same keys authenticate the JSON data API — every `/data/*` route requires `Authorization: Bearer <api-key>` (see [../routes/CLAUDE.md](../routes/CLAUDE.md)). Key validation is shared via `auth.ts:resolveApiKey()`.
