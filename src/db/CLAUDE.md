# src/db

SQLite via `bun:sqlite`. Split architecture.

## Files

| file | use |
|---|---|
| `connection.ts` | `initializeDatabase()`, `getDb()`, `closeDb()`, `resetDb()`. Split or single mode, `seedAgentTypes()` |
| `legacy-migrations.ts` | One-shot guarded schema migrations (`migrateLegacySchema()`), run on every init. New migrations go in `migrations/` unless they need a table rebuild. Table rebuilds (copy → drop → rename inside a transaction, FKs off, indexes recreated) live here: tasks (unified model), scheduled_tasks, task_notes, team_agents, and the two file-artifact ones: `task_artifacts` (kind CHECK gains `upload`; guarded on the stored CREATE lacking `'upload'`) and `realtime_timeline` (entry_type CHECK gains `image`/`file`; guarded on `'image'`). The file-artifact metadata columns (`storage`, `mime`, `bytes`, `sha256`, `width`, `height`, `source`, timeline `artifact_id`) arrive via `ensureColumn` first, so the rebuild SELECT can read them. Legacy runs BEFORE the numbered migrations, so a rebuild must carry every column a later numbered migration would ADD (the runner tolerates the resulting `duplicate column` and marks that version applied) |
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

Schema + migration `.sql` are **embedded assets** (read via `assetTextSync`, not
`readFileSync`), so the compiled binary carries them and `bun run gen:assets`
picks up new files automatically (any `src/db/**/*.sql`). See root [CLAUDE.md](../../CLAUDE.md) Package section.
