# src

Server code. TS, Bun runtime.

## Top-level files

| file | use |
|---|---|
| `server.ts` | tiny HTTP router. `addRoute()`, path-param match, static from embedded `public/*` assets, `/health`. Per-request `[http]` log skips high-frequency UI poll paths (`shouldLogRequest` / `QUIET_LOG_PATTERNS`) unless error/slow; `SKIPPER_HTTP_LOG=all` logs everything |
| `logging.ts` | DB-backed error log (`error_log`), console fallback |
| `paths.ts` | resolve data/config/pid/log paths. Data dir (`~/.skipper`) for mutable state; `getConfigDir()` + `ensureConfigSeeded()` relocate + seed config in the binary |
| `assets.ts` | embedded-asset access (`assetTextSync`, `assetFile`, `listAssets`, `isCompiledBinary`) over the generated manifest baked in by `bun build --compile`. See root [CLAUDE.md](../CLAUDE.md) Package section |
| `generated/` | `embedded-assets.js` (+ `.d.ts`) — auto-generated asset manifest. Do not edit; run `bun run gen:assets` |

## Subdirs

See [../CLAUDE.md](../CLAUDE.md) module map for full pointer table.

Core flow: `routes/*` → `agents/manager-daemon.ts` (facade) → `orchestrator/*` modules → `agents/manager.ts` (process spawn + signal parse) → `events/bus.ts` → orchestrator handlers.

DB access through `db/connection.ts:getDb()`. Split mode: runtime on disk, config in-memory ATTACH as `shared`.
