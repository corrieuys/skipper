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
- **Internal root**: full tool set (notes, artifacts, delegation, escalation, phase control, consensus)
- **Internal delegated**: same minus phase-lifecycle tools
- **External** (API key): `create_task`, `list_tasks`, `approve_task`, `list_teams`, `list_templates`

## External access

External agents authenticate with API keys (managed via `/api/api-keys`). Configure in `.mcp.json`:
```json
{ "mcpServers": { "skipper": { "type": "streamableHttp", "url": "http://localhost:3000/mcp", "headers": { "Authorization": "Bearer <api-key>" } } } }
```
