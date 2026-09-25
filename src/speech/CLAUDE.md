# src/speech

Local speech-to-text engine for recording and dictation. One engine runs at a
time, picked by the configured model (`realtime_config.local_model`, default
`whisper-base.en`); `speaker_labels` asks a model that supports it to tag who spoke.

| file | use |
|---|---|
| `catalogue.ts` | `SPEECH_MODELS`: curated models, each pinned to a Hugging Face revision with size + SHA-256. `whisper` engine: Whisper base.en / small.en / medium.en / large-v3-turbo (q5_0 + full). `nemo` engine (NVIDIA NeMo-Speech.cpp GGUF): Nemotron 3.5 ASR (40 locales), Nemotron Speech EN, Parakeet TDT v3, Parakeet CTC 1.1B. `speakers: true` (the two Nemotron models) can load `SPEAKER_MODEL` (Sortformer 4-speaker v2) for speaker labels. `resolveSpeechModel` falls back to the default for an unknown id |
| `engine-manager.ts` | `SpeechEngineManager` (one per daemon via `getSpeechEngine()`; index.ts). Install root `<data dir>/speech/` (models in `models/`, binaries in `bin/<engine>/<tag>/`, `<engine>.json` records). **Binary**: managed install, then (whisper) the dev build `vendor/whisper.cpp/build/bin/whisper-server`, then PATH (`whisper-server`, `nemo-speech`). `installBinary("nemo")` takes the newest non-prerelease NeMo-Speech.cpp GitHub release asset for this platform (`nemoAssetSuffix`: macOS arm64 Metal, macOS x64 / Linux CPU), verifies its `.sha256`, untars. whisper.cpp ships no macOS binary: the status shows a hint (`brew install whisper-cpp` or `scripts/setup-whisper.sh`); Linux takes `whisper-bin-ubuntu-*`. **Models**: `installModel` streams with progress, checks size + SHA-256; a Whisper model already in `vendor/whisper.cpp/models` counts as installed. `installForConfig` fetches whatever the configured model still needs. `deleteModel` removes a managed download (never a vendored copy), refused while the running or starting engine uses it; `getStatus` lists `installedIds` + deletable `managedModels`. **Run**: ref-counted `acquire`/`release` (recording lock owners), `ensureRunning` (restarts when the model or speaker setting changed), `restartIfRunning` (config route), health poll on `/health` (120 s), writes `transcription_endpoint` (`/inference` for whisper, `/v1/audio/transcriptions` for NeMo) on start and clears it on stop. whisper: `whisper-server -m <model> --convert`; NeMo: `nemo-speech serve --asr-model <gguf> --no-ui [--asr.diar.model_path <sortformer>]`, `NEMO_SPEECH_MODEL_DIR` pinned to the managed models dir. Port `WHISPER_PORT` (default 8080) |

| `stream-transcriber.ts` | `StreamTranscriber`: one NeMo realtime session (`ws://…/v1/realtime`) per recording. `open` (session.update: 16 kHz, punctuation, word timestamps + diarization when speaker labels are on), `push` (PCM16 binary frames, 64 KB each), `sync` (barrier: sends the unknown event `skipper.sync`; the server answers each message in order, so its error reply means every earlier frame was recognized), `takeText` (finals since the last call, "Speaker N:" lines with labels), `finish` (commit → last final + `committed`, close). Empty binary keep-alive every 10 s (the server drops a socket idle for its 30 s read timeout). `decodeToPcm16` (ffmpeg → 16 kHz mono s16le). `trimRepeat` / `overlapBytes`: find where a new chunk stops repeating audio already streamed by matching the last 1.5 s pushed (kept as a 3 s tail) inside the chunk's first `overlap + 4` s (normalized correlation, coarse every 8th sample then full rate, trusted at ≥ 0.6) and cut up to the end of the match; else fall back to the fixed `overlap_seconds` cut. Needed because the web recorder prepends its first MediaRecorder slice (WebM header + ~1 s of the recording's first audio) to every chunk, so a chunk is [header audio][overlap][new] and a fixed cut leaves ~1 s of foreign audio at each joint |

**Streaming** (catalogue `streaming: true`: the two Nemotron models; Parakeet is
offline-only). `SpeechEngineManager.getStreamTarget()` returns the realtime URL
while such a model runs (+ whether it was started with the diarizer).
`RealtimeSessionManager` (`setSpeechStreamSource`, index.ts) then routes a
recording's chunks through `streamPendingSegments` instead of one HTTP request per
chunk: each pending chunk is decoded, the audio it repeats cut (`trimRepeat`; not
for the stream's first chunk), pushed, and marked transcribed with empty text;
after a `sync` the finalized text becomes ONE `transcribed` row with metadata
`{streamed:true}` and no audio, which the summarizer / raw-transcript path reads
like any chunk. Text still being spoken at a tick lands in a later tick. Release
of the recording lock and `stopSession` pass `finalizeStream` (commit, store the
tail, close). A stream whose target changed (engine restarted on another model or
speaker setting) or that dropped is ended and a new one opened (speaker numbers
restart). If a stream cannot open or a push fails, the pending chunks go through
the per-chunk HTTP path.

**Per-chunk path overlap** (`RealtimeSessionManager.trimChunkOverlap`): before a
chunk is transcribed on the HTTP path (any provider), it is decoded and the audio
it repeats from the previous chunk is cut with the same `overlapBytes` matching
(the last 3 s of the previous decoded chunk is kept per task, cleared when the
recording ends), and sent as 16 kHz WAV. A matched chunk skips the text dedup
(`realtime/dedup.ts`), which stays as the fallback (no previous chunk, no trusted
match, decode failure). A chunk with under 0.1 s left is stored empty without a
request.

**Speaker labels** (`realtime/transcription.ts`): on the per-chunk path the
local adapter sends `response_format=verbose_json` + `diarization=true` and
renders the words' `speaker` tags as "Speaker N: ..." lines
(`formatSpeakerTranscript`); speaker numbers are then per chunk. On the
streaming path they hold for the whole recording. Dictation always transcribes
without labels (HTTP path).

**Surfaces** (experimental): config page Real-time transcription panel
(`html/fragments/speech-config.fragment.ts`): provider (local / OpenAI + model),
local model, speaker labels, status + Download, and a downloaded-models list with
Delete. Model and speaker choices post to `POST /api/realtime/config` (restarts a
live engine); `GET /api/config/speech/status` (polled while busy),
`POST /api/config/speech/download` and `POST /api/config/speech/delete` (field
`model`) live in `routes/speech.ts`. **Loading state**: `pendingStartLabel(db)` names the model an
acquire would first have to load (null when it already serves it or transcription
is not local); `acquireRecording(..., { onPreparing })` passes it on before the
load, and the web socket sends `recording.preparing { model }`, so
`realtime-audio.js` shows "Loading <model>…" on a disabled, pulsing Record until
the lock is granted. A failed start still grants the recording but returns
`warning` (in the `recording.start` ack), shown as "Recording, but transcription is
unavailable: …". Their responses carry the model select as an
`hx-swap-oob` element, so its "downloaded" markers follow without a reload. `/api/whisper/start|stop|status` (dictation warm-up) drive
this engine too.

**Temp audio**: ffmpeg input/output files are `/tmp/skipper-<uuid>-in.<format>`
and `-16k.wav`, deleted in a `finally` after each decode or request; a
transcribed or failed chunk row has its `content_body` blanked. Boot
(`RealtimeSessionManager.cleanupStaleTempFiles`) removes such files older than
10 min, left by a crash.

**Debug** (dev): with `SKIPPER_SPEECH_DEBUG_DIR` set, the streaming path writes
each chunk's decoded and pushed audio there (`<task>-<seq>-decoded.pcm` /
`-pushed.pcm`, 16 kHz mono s16le) so chunk joints can be measured; the per-chunk
path writes each chunk as received (`<task>-<seq>-chunk.<format>`).
