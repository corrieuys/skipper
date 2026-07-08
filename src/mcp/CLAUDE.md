# src/mcp

Model Context Protocol server. Alternative to stdout signal parsing — agents call typed tools.

| file | use |
|---|---|
| `server.ts` | `DaemonMcpServer`. Streamable HTTP transport (POST `/mcp` msg, GET `/mcp` SSE, DELETE `/mcp` end). Bearer token = agent runtimeId or API key |
| `auth.ts` | Token → `AgentIdentity` resolve. Union type: `InternalAgentIdentity` (running agents) or `ExternalIdentity` (API keys) |
| `tools.ts` | Tool definitions + impl. Three session modes: root (all tools), delegated (no phase-control), external (task management only) |
| `tools-registration.test.ts` | tests |
| `signal-bridge.ts` | Convert MCP tool calls → `agent:signal` events (so handlers stay one path) |

Role-based tool visibility locked at session create. Three identity types:
- **Internal root**: full tool set (notes, artifacts, delegation, escalation, phase control, consensus, global store)
- **Internal delegated**: same minus phase-lifecycle tools. Also applies to **one-off runs** — an instance flagged `state_metadata.oneshot=true` (operator resume on a completed task) is treated as delegated by `server.ts:isDelegatedRuntime`, so phase/task-lifecycle tools are omitted.

Global-store tools (`set_global_value`, `get_global_value`, `query_global_store`, `delete_global_value`) read/write the cross-task `global_store` table via `GlobalStoreManager` (`src/global-store/`). Available to root + delegated. Prompts instruct agents to use them only when a task/phase/template explicitly asks.
- **External** (API key): `create_task`, `list_tasks`, `approve_task`, `list_teams`

## External access

External agents authenticate with API keys (managed via `/api/api-keys`). Configure in `.mcp.json`:
```json
{ "mcpServers": { "skipper": { "type": "streamableHttp", "url": "http://localhost:3000/mcp", "headers": { "Authorization": "Bearer <api-key>" } } } }
```
