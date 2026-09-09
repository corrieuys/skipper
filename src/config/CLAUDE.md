# src/config

JSON-backed config snapshot layer.

| file | use |
|---|---|
| `store.ts` | Load/persist `config/*.json` snapshots. Legacy DB → JSON migration bootstrap. Used by DB init + managers |
| `builtin-infra.ts` | Infra agent (`skipper`), defined in code; model is a fallback behind runtime model-settings |
| `builtin-realtime.ts` | Built-in Real Time team + librarian/summarizer agents, registered at boot |
| `app-settings.ts` | App-wide settings R/W (persisted in DB `app_settings`) |
| `model-settings.ts` | Machine-scoped provider+model overrides (config page "Agent Models"): skipper, greg, dictation (experimental), and `task_title` (Task Title Generator, ungated). `PROVIDER_ALLOWLIST` gates which agent types are selectable; `codex`, `opencode`, and `grok` are experimental providers, selectable only when `isExperimental()`. `task_title` uses the Skipper-style override shape (undefined when unset) plus `isTaskTitleGeneratorConfigured(db)` — the gate the task-create routes use to decide whether a blank title is allowed; it is clearable (empty provider unsets it, keeping the title required). See [../tasks/CLAUDE.md](../tasks/CLAUDE.md) `title-generator.ts` |
| `feature-flags.ts` | Feature flag read |
| (task memory) | Embeddings endpoint settings live in `../task-memory/settings.ts` (`task_memory_*` app_settings keys), surfaced on the config page's Task Memory panel |
| `slack-settings.ts` | Slack credentials + Socket Mode config (runtime `app_settings`). Bot token/default channel, app-level token (`slack_app_token`), socket toggle (`slack_socket_enabled`), and auth allowlist (`slack_allowed_users`, fail-closed). `getSlackBotToken`, `isSlackConfigured`, `isSocketModeConfigured`, `isSlackSocketEnabled`, `isSlackUserAllowed`, `saveSlackConfig`. No push toggle — outbound escalations/reviews are gated by the per-team `slackEnabled` opt-in, not a global switch. Credentials only — per-team opt-in + slash-command bindings live on the team / scheduled-task records. See [../slack/CLAUDE.md](../slack/CLAUDE.md) |
| `teams.ts` | Team config persistence helpers |

## Snapshot files

See [../../config/CLAUDE.md](../../config/CLAUDE.md) for the JSON files.

Flow: startup → read JSON → seed in-memory config DB. Mutation via route → DB write → `store.ts` persists back to JSON.
