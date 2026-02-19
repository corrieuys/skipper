# src/db

SQLite via `bun:sqlite`. Split architecture.

## Files

| file | use |
|---|---|
| `connection.ts` | `initializeDatabase()`, `getDb()`, `closeDb()`, `resetDb()`. Split or single mode, legacy migrations, `seedAgentTypes()` |
| `schema.sql` | Monolith schema. Tests only (explicit DB path) |
| `schema.config.sql` | Config tables — applied to in-memory ATTACH |
| `schema.runtime.sql` | Runtime tables — applied to on-disk DB |
| `migrations/` | Numbered SQL migrations + README |

## Split mode (default)

- Runtime DB → on disk (`skipper-runtime.db` or `SKIPPER_RUNTIME_DB_PATH`). Tasks, instances, delegations, escalations, events, logs, artifacts, realtime pipeline.
- Config DB → `:memory:`, ATTACHed as `shared`. Loaded from `config/*.json` at startup, persisted back on change. Agent types, agents, teams, memberships, skipper config.

`getDb()` returns runtime DB with SQL rewrite so queries on shared tables transparently route to ATTACHed in-memory config DB.

## Migrations

Add new file `00X_<name>.sql` under `migrations/`. Applied on init in numeric order.
