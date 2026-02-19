# src/config

JSON-backed config snapshot layer.

| file | use |
|---|---|
| `store.ts` | Load/persist `config/*.json` snapshots. Legacy DB → JSON migration bootstrap. Used by DB init + managers |
| `app-settings.ts` | App-wide settings R/W (persisted in DB `app_settings`) |
| `feature-flags.ts` | Feature flag read |
| `teams.ts` | Team config persistence helpers |

## Snapshot files

See [../../config/CLAUDE.md](../../config/CLAUDE.md) for the JSON files.

Flow: startup → read JSON → seed in-memory config DB. Mutation via route → DB write → `store.ts` persists back to JSON.
