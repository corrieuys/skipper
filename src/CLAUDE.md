# src

Server code. TS, Bun runtime.

## Top-level files

| file | use |
|---|---|
| `server.ts` | tiny HTTP router. `addRoute()`, path-param match, static from embedded `public/*` assets, `/health`. Every request (routes and WS upgrades) first passes `rejectForeignRequest`: 403 for a non-local `Host` (DNS rebinding; `SKIPPER_ALLOWED_HOSTS` and the config page's Allowed Hosts list extend it, the latter swapped into the running gate by `setConfiguredAllowedHosts` on save, never read from the DB per request) or, on writes and upgrades, a foreign `Origin` / `Sec-Fetch-Site: cross-site` (CSRF). Per-request `[http]` log skips high-frequency UI poll paths (`shouldLogRequest` / `QUIET_LOG_PATTERNS`) unless error/slow; `SKIPPER_HTTP_LOG=all` logs everything |
| `logging.ts` | DB-backed error log (`error_log`), console fallback |
| `paths.ts` | resolve data/config/pid/log paths. Data dir (`~/.skipper`) for mutable state; `getConfigDir()` + `ensureConfigSeeded()` relocate + seed config in the binary |
| `assets.ts` | embedded-asset access (`assetTextSync`, `assetFile`, `listAssets`, `isCompiledBinary`) over the generated manifest baked in by `bun build --compile`. See root [CLAUDE.md](../CLAUDE.md) Package section |
| `generated/` | `embedded-assets.js` (+ `.d.ts`) — auto-generated asset manifest. Do not edit; run `bun run gen:assets` |

## Subdirs

See [../CLAUDE.md](../CLAUDE.md) module map for full pointer table.

Core flow: `routes/*` → `agents/manager-daemon.ts` (facade) → `orchestrator/*` modules → `agents/manager.ts` (process spawn + signal parse) → `events/bus.ts` → orchestrator handlers.

One branch in that flow does not spawn anything: a **custom agent** runs inside
this process (`custom-agents/runner.ts`) and reports through the same handle,
events and signal paths as a CLI. See [custom-agents/CLAUDE.md](custom-agents/CLAUDE.md).

DB access through `db/connection.ts:getDb()`. Split mode: runtime on disk, config in-memory ATTACH as `shared`.
