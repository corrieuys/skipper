# src/global-store

Generic cross-task shared key/value store. Backed by the `global_store` runtime table.

| file | use |
|---|---|
| `manager.ts` | `GlobalStoreManager` — `set` (upsert by name, partial-update preserves untouched cols), `get`, `query` (filter by any field), `delete` |

Surfaced to agents via MCP tools (`set_global_value`, `get_global_value`, `query_global_store`, `delete_global_value` in `src/mcp/tools.ts`) and the `/global-store` admin page. Agents must only use the tools when a task/phase/template explicitly instructs them to.
