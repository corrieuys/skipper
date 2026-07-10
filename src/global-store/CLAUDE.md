# src/global-store

Generic cross-task shared key/value store. Backed by the `global_store` runtime table.

| file | use |
|---|---|
| `manager.ts` | `GlobalStoreManager` — `set` (upsert by name, partial-update preserves untouched cols), `get`, `query` (filter by any field incl. `name_prefix`), `delete` |

Surfaced to agents via MCP tools (`set_global_value`, `get_global_value`, `query_global_store`, `delete_global_value` in `src/mcp/tools.ts`), the `/global-store` admin page, and the JSON data API (`/data/global-store`, key-authenticated — see `src/routes/data/global-store.ts`). Agents must only use the tools when a task/phase/template explicitly instructs them to. Recurring tasks carry a sanctioned instruction source: `scheduled_tasks.global_store_instructions`, injected into every run's root prompt as the GLOBAL STORE INSTRUCTIONS section (see `src/tasks/scheduled-scheduler.ts` + `src/agents/prompt-builder.ts`).
