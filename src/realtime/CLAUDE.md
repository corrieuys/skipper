# src/realtime

Realtime task pipeline. Audio/text ingest → transcribe → dedup → summarize. Session managed by `orchestrator/realtime-session.ts`.

| file | use |
|---|---|
| `config.ts` | Read/update realtime config — transcription provider, model, cadence, overlap |
| `transcription.ts` | Provider impls — local whisper.cpp server + OpenAI API |
| `dedup.ts` | Dedup overlapping audio segments |

Config persisted to `config/realtime_config.json`.
