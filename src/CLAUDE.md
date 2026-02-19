# src

Server code. TS, Bun runtime.

## Top-level files

| file | use |
|---|---|
| `server.ts` | tiny HTTP router. `addRoute()`, path-param match, static from `html/public/`, `/health`, logs |
| `logging.ts` | DB-backed error log (`error_log`), console fallback |
| `paths.ts` | resolve project paths |

## Subdirs

See [../CLAUDE.md](../CLAUDE.md) module map for full pointer table.

Core flow: `routes/*` → `agents/manager-daemon.ts` (facade) → `orchestrator/*` modules → `agents/manager.ts` (process spawn + signal parse) → `events/bus.ts` → orchestrator handlers.

DB access through `db/connection.ts:getDb()`. Split mode: runtime on disk, config in-memory ATTACH as `shared`.
