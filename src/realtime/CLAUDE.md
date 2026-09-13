# src/realtime

Realtime task pipeline. Audio/text ingest → transcribe → dedup → summarize. Session managed by `orchestrator/realtime-session.ts`.

| file | use |
|---|---|
| `config.ts` | Read/update realtime config — transcription provider, model, chunk cadence (`cadence_seconds`, 5..600, `clampCadenceSeconds`), overlap, and the global `summary_enabled` default (summarize each window vs feed the raw transcript) |
| `transcription.ts` | Provider impls — local whisper.cpp server + OpenAI API. Also `stripFillerMarkers()` (whisper `[pause]`/`[music]` markers), shared with dictation |
| `dedup.ts` | Dedup overlapping audio segments |
| `dictation.ts` | `cleanupTranscript()` — one-shot LLM rewrite of a dictated task description via `agents/oneshot.ts`. Provider+model from the config page (Dictation Rewriter row, experimental) |

Config persisted to `config/realtime_config.json`.

## Chunk cadence + summary switch

Resolution lives in `orchestrator/realtime-session.ts`:

- `effectiveCadenceSeconds(taskId)`: `task_config.window_seconds` (clamped) else
  the global `cadence_seconds`. Drives the session cadence timer, the stale-lock
  TTL, and the web recorder flush (the record button renders the effective
  value; `public/realtime-audio.js` clamps to 5..600).
- `summaryEnabledFor(taskId)`: `task_config.summary_enabled` if set, else the
  team's `realtime.summaryEnabled` (any local team, any mode), else the global
  `summary_enabled`. Off = `createRawTranscriptTimeline` writes the cleaned
  transcript as a **`transcript`** timeline entry (its own `entry_type`, added by
  `legacy-migrations.ts:migrateRealtimeTimelineTranscriptEntries`) and wakes the
  task like any input; no summarizer spawns. The summarizer's provider/model
  override still comes from the team config.

Surfaces: config page "Real-time transcription" panel (global cadence + summary
default, posts to `POST /api/realtime/config`), the task create form
(`summaryEnabled` on/off/blank + `windowSeconds`), Connect `tasks/create`
(`summaryEnabled`, `windowSeconds` or `taskConfig.window_seconds`), and the
TUI task form.
