# src/mcp

Model Context Protocol server. Alternative to stdout signal parsing — agents call typed tools.

| file | use |
|---|---|
| `server.ts` | `DaemonMcpServer`. Streamable HTTP transport (POST `/mcp` msg, GET `/mcp` SSE, DELETE `/mcp` end). Bearer token = agent runtimeId or API key |
| `auth.ts` | Token → `AgentIdentity` resolve. Union type: `InternalAgentIdentity` (running agents) or `ExternalIdentity` (API keys). Internal-instance validity is **task-scoped**: an instance token resolves while `ai.status='running'` OR its **task** is still `running` — the instance id belongs to the task for the task's lifetime, so a live process is not 401'd when a concurrent exit handler momentarily parks `agent_instances.status` off `running` (the old "token expired mid-run" race — a root awaiting delegations while resolving an escalation). `describeTokenState()` snapshots the row states for the `mcp_auth_reject` log emitted by `server.ts` on every 401 (previously silent) |
| `tools.ts` | Tool definitions + impl. Three session modes: root (all tools), delegated (no phase-control), external (task management only) |
| `tools-registration.test.ts` | tests |
| `signal-bridge.ts` | Convert MCP tool calls → `agent:signal` events (so handlers stay one path) |

Role-based tool visibility locked at session create. Three identity types:
- **Internal root**: full tool set (notes, artifacts, delegation, escalation, phase control, consensus, global store)
- **Internal delegated**: same minus phase-lifecycle tools. Also applies to **one-off runs** — an instance flagged `state_metadata.oneshot=true` (operator resume on a completed task) is treated as delegated by `server.ts:isDelegatedRuntime`, so phase/task-lifecycle tools are omitted.

Global-store tools (`set_global_value`, `get_global_value`, `query_global_store`, `delete_global_value`) read/write the cross-task `global_store` table via `GlobalStoreManager` (`src/global-store/`). Available to root + delegated. Prompts instruct agents to use them only when a task/phase/template explicitly asks.

Slack tools (`slack_send_message`, `slack_send_dm`, `slack_read_channel`) post/read as the Skipper Slack app via the bot token. Registered on a session only when `isExperimental()` + `isSlackConfigured(db)` + the task's team has `slackEnabled` (see [../slack/CLAUDE.md](../slack/CLAUDE.md)). A slash-command-triggered run gets a `SLACK ORIGIN` block in its prompt telling it to reply via `slack_send_message` with the origin channel + `thread_ts`.
- **External** (API key): `create_task`, `list_tasks`, `approve_task`, `list_teams`

## External access

External agents authenticate with API keys (managed via `/api/api-keys`, or the API Keys panel on `/config` under `--experimental`). Configure in `.mcp.json`:
```json
{ "mcpServers": { "skipper": { "type": "streamableHttp", "url": "http://localhost:5005/mcp", "headers": { "Authorization": "Bearer <api-key>" } } } }
```

The same keys authenticate the JSON data API — every `/data/*` route requires `Authorization: Bearer <api-key>` (see [../routes/CLAUDE.md](../routes/CLAUDE.md)). Key validation is shared via `auth.ts:resolveApiKey()`.
