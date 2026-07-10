import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { isExperimental } from "../config/feature-flags";
import { getRealtimeConfig } from "../realtime/config";
import { createTranscriptionAdapter, stripFillerMarkers } from "../realtime/transcription";
import { cleanupTranscript } from "../realtime/dictation";

// Dictation for task-description fields: one-shot transcription of a recorded
// clip, plus an LLM cleanup pass ("raw now, rewrite later" — the UI inserts the
// raw transcript, then swaps in the cleaned version). Reuses the realtime
// transcription adapter; the whisper server lifecycle stays client-driven via
// the existing /api/whisper/start|stop routes (see src/html/public/dictation.js).
// Experimental-only: routes 404 when the flag is off, matching the hidden UI.

// A dictation clip is a single recording, not a stream — cap it well below
// anything a few minutes of opus can produce so a bad client can't buffer-bomb.
const MAX_AUDIO_BASE64_BYTES = 10 * 1024 * 1024;

function experimentalGate(): Response | null {
  if (!isExperimental()) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

export function registerDictationRoutes(): void {
  addRoute("POST", "/api/dictation/transcribe", async (req) => {
    const gate = experimentalGate();
    if (gate) return gate;

    let body: { audio?: unknown; format?: unknown };
    try {
      body = await req.json() as { audio?: unknown; format?: unknown };
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const audio = typeof body.audio === "string" ? body.audio : "";
    const format = typeof body.format === "string" && body.format ? body.format : "webm";
    if (!audio) {
      return Response.json({ error: "Missing audio (base64)" }, { status: 400 });
    }
    if (audio.length > MAX_AUDIO_BASE64_BYTES) {
      return Response.json({ error: "Audio payload too large" }, { status: 413 });
    }

    const db = getDb();
    const adapter = createTranscriptionAdapter(getRealtimeConfig(db));
    if (!adapter.isConfigured()) {
      return Response.json({ error: adapter.notConfiguredReason() }, { status: 503 });
    }

    try {
      const text = stripFillerMarkers(await adapter.transcribe(audio, format));
      return Response.json({ text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `Transcription failed: ${message}` }, { status: 500 });
    }
  });

  addRoute("POST", "/api/dictation/cleanup", async (req) => {
    const gate = experimentalGate();
    if (gate) return gate;

    let body: { text?: unknown };
    try {
      body = await req.json() as { text?: unknown };
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      return Response.json({ error: "Missing text" }, { status: 400 });
    }

    // Never fails hard: a cleanup failure just hands back the raw transcript.
    const cleaned = await cleanupTranscript(getDb(), text);
    return Response.json({ text: cleaned ?? text, cleaned: cleaned !== null });
  });
}
