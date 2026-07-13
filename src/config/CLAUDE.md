# src/config

JSON-backed config snapshot layer.

| file | use |
|---|---|
| `store.ts` | Load/persist `config/*.json` snapshots. Legacy DB → JSON migration bootstrap. Used by DB init + managers |
| `builtin-infra.ts` | Infra agents (`skipper`, `chat-skipper`), defined in code; models are fallbacks behind runtime model-settings |
| `builtin-realtime.ts` | Built-in Real Time team + librarian/summarizer agents, registered at boot |
| `app-settings.ts` | App-wide settings R/W (persisted in DB `app_settings`) |
| `model-settings.ts` | Machine-scoped provider+model overrides (config page "Agent Models"): skipper, chat, greg, dictation (experimental). `PROVIDER_ALLOWLIST` gates which agent types are selectable; `codex`, `opencode`, and `grok` are experimental providers, selectable only when `isExperimental()` |
| `feature-flags.ts` | Feature flag read |
| `teams.ts` | Team config persistence helpers |

## Snapshot files

See [../../config/CLAUDE.md](../../config/CLAUDE.md) for the JSON files.

Flow: startup → read JSON → seed in-memory config DB. Mutation via route → DB write → `store.ts` persists back to JSON.
