# src/whisper

Local whisper.cpp server lifecycle.

| file | use |
|---|---|
| `manager.ts` | Start/stop whisper-server subprocess. Toggled via UI button on RT tasks (`POST /api/whisper/start`, `/stop`, `GET /api/whisper/status`). Auto-killed on app shutdown |

Vendor source: `vendor/whisper.cpp`. Setup: `scripts/setup-whisper.sh`.
