# config

JSON config snapshots. Loaded into in-memory config DB at startup. Persisted back on change via `src/config/store.ts`.

| file | use |
|---|---|
| `agent_types.json` | Agent type defs (claude-code, codex, opencode, oz, custom). Re-seeded by `db/connection.ts` if missing |
| `agents.json` | User-defined agent instances (id, name, type, model, prompt, tools) |
| `teams.json` | Team defs incl. phases + membership |
| `skipper_config.json` | Skipper prompt + realtime_prompt |
| `realtime_config.json` | Transcription provider, model, cadence, overlap |
| `appearance.json` | UI appearance tweaks |

Edit via API/UI normally — direct edits picked up only on restart.
