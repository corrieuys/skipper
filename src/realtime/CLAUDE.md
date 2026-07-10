# src/realtime

Realtime task pipeline. Audio/text ingest → transcribe → dedup → summarize. Session managed by `orchestrator/realtime-session.ts`.

| file | use |
|---|---|
| `config.ts` | Read/update realtime config — transcription provider, model, cadence, overlap |
| `transcription.ts` | Provider impls — local whisper.cpp server + OpenAI API. Also `stripFillerMarkers()` (whisper `[pause]`/`[music]` markers), shared with dictation |
| `dedup.ts` | Dedup overlapping audio segments |
| `dictation.ts` | `cleanupTranscript()` — one-shot LLM rewrite of a dictated task description via `agents/oneshot.ts`. Provider+model from the config page (Dictation Rewriter row, experimental) |

Config persisted to `config/realtime_config.json`.
