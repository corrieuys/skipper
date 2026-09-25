import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { updateRealtimeConfig } from "../realtime/config";
import { ArtifactManager } from "../orchestrator/artifact-manager";
import { RealtimeSessionManager } from "../orchestrator/realtime-session";
import { overlapBytes, StreamTranscriber } from "./stream-transcriber";

/**
 * A fake NeMo-Speech.cpp realtime socket with the real protocol shape: every
 * full second of PCM (32000 bytes) it received becomes one final with words
 * tagged speaker 1 / 2 alternately; commit finalizes the rest; an unknown event
 * type answers with an error (the sync barrier).
 */
function fakeNemo() {
  const received: number[] = [];
  const state = { bytes: 0, emittedSeconds: 0, sessions: 0, updates: [] as unknown[] };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        state.sessions++;
        ws.send(JSON.stringify({ type: "session.created", session: { sample_rate: 16000 } }));
      },
      message(ws, msg) {
        if (typeof msg !== "string") {
          const n = (msg as Uint8Array).byteLength;
          if (n === 0) return; // keep-alive
          received.push(n);
          state.bytes += n;
          while (Math.floor(state.bytes / 32000) > state.emittedSeconds) {
            state.emittedSeconds++;
            const speaker = state.emittedSeconds % 2 === 1 ? 1 : 2;
            ws.send(JSON.stringify({
              type: "conversation.item.input_audio_transcription.completed",
              transcript: `second ${state.emittedSeconds}`,
              words: [{ word: "second", speaker }, { word: String(state.emittedSeconds), speaker }],
            }));
          }
          return;
        }
        const event = JSON.parse(msg) as { type: string; session?: unknown };
        if (event.type === "session.update") {
          state.updates.push(event.session);
          ws.send(JSON.stringify({ type: "session.updated", session: event.session }));
        } else if (event.type === "input_audio_buffer.commit") {
          const rest = state.bytes - state.emittedSeconds * 32000;
          if (rest > 0) {
            ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "tail", words: [{ word: "tail", speaker: 1 }] }));
          }
          ws.send(JSON.stringify({ type: "input_audio_buffer.committed" }));
        } else {
          ws.send(JSON.stringify({ type: "error", error: { message: `unsupported realtime event type: ${event.type}`, type: "invalid_request_error" } }));
        }
      },
    },
  });
  return { server, url: `ws://127.0.0.1:${server.port}/v1/realtime`, state, received };
}

const pcmSeconds = (s: number) => new Uint8Array(Math.round(s * 16000) * 2);

/** A 16 kHz mono PCM16 WAV of `seconds`, base64 (the app recorders' chunk format). */
function wavBase64(seconds: number): string {
  const data = pcmSeconds(seconds);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.byteLength, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.byteLength, 40);
  return Buffer.concat([header, Buffer.from(data)]).toString("base64");
}

/** Deterministic "speech-like" noise (16 kHz PCM16), so correlation has something to match. */
function noise(seconds: number, seed: number): Uint8Array {
  const out = new Int16Array(Math.round(seconds * 16000));
  // mulberry32: no short period, so a window matches only where it really repeats.
  let a = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = (((t ^ (t >>> 14)) >>> 0) % 16000) - 8000;
  }
  return new Uint8Array(out.buffer);
}
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
};

describe("overlapBytes", () => {
  const previous = noise(8, 1);
  const tail = previous.subarray(previous.byteLength - 3 * 32000);
  const fresh = noise(6, 2);

  it("cuts exactly the repeated overlap (app WAV chunks)", () => {
    const chunk = cat(previous.subarray(previous.byteLength - 5 * 32000), fresh);
    expect(overlapBytes(tail, chunk, 5)).toEqual({ bytes: 5 * 32000, matched: true });
  });

  it("also cuts the web recorder's header audio in front of the overlap", () => {
    // [1.06 s of the recording's first audio][5 s overlap][new]
    const header = noise(1.06, 3);
    const chunk = cat(header, previous.subarray(previous.byteLength - 5 * 32000), fresh);
    expect(overlapBytes(tail, chunk, 5)).toEqual({ bytes: header.byteLength + 5 * 32000, matched: true });
  });

  it("falls back to the fixed cut when the tail is silence", () => {
    const chunk = cat(new Uint8Array(5 * 32000), fresh);
    expect(overlapBytes(new Uint8Array(3 * 32000), chunk, 5)).toEqual({ bytes: 5 * 32000, matched: false });
  });

  it("cuts nothing without an overlap", () => {
    expect(overlapBytes(tail, fresh, 0)).toEqual({ bytes: 0, matched: false });
  });
});

describe("StreamTranscriber", () => {
  let nemo: ReturnType<typeof fakeNemo>;
  beforeEach(() => { nemo = fakeNemo(); });
  afterEach(() => { nemo.server.stop(true); });

  it("configures the session, collects finals after a sync, and finishes with the tail", async () => {
    const stream = new StreamTranscriber({ url: nemo.url, speakerLabels: true });
    await stream.open();
    expect(nemo.state.updates[0]).toMatchObject({ sample_rate: 16000, speaker_diarization: true, word_timestamps: true });

    stream.push(pcmSeconds(2.5));
    await stream.sync();
    expect(stream.takeText()).toBe("Speaker 1: second 1\nSpeaker 2: second 2");
    expect(stream.takeText()).toBe("");

    expect(await stream.finish()).toBe("Speaker 1: tail");
    expect(stream.isOpen()).toBe(false);
  });

  it("uses the plain transcript without speaker labels", async () => {
    const stream = new StreamTranscriber({ url: nemo.url, speakerLabels: false });
    await stream.open();
    stream.push(pcmSeconds(1));
    await stream.sync();
    expect(stream.takeText()).toBe("second 1");
    stream.close();
  });

  it("rejects open when nothing listens", async () => {
    const stream = new StreamTranscriber({ url: "ws://127.0.0.1:1/v1/realtime", speakerLabels: false });
    await expect(stream.open(2000)).rejects.toThrow();
  });
});

describe("RealtimeSessionManager streaming", () => {
  let nemo: ReturnType<typeof fakeNemo>;
  let db: Database;
  let sessions: RealtimeSessionManager;
  const taskId = "task-stream";
  const hasFfmpeg = Bun.which("ffmpeg") !== null;

  beforeEach(() => {
    nemo = fakeNemo();
    db = new Database(":memory:");
    initializeDatabase(db);
    db.prepare("INSERT INTO teams (id, name) VALUES ('team-1', 'Team')").run();
    db.prepare("INSERT INTO tasks (id, title, team_id, status, mode, task_config) VALUES (?, 'Stream', 'team-1', 'active', 'conversational', '{}')").run(taskId);
    sessions = new RealtimeSessionManager(db, new ArtifactManager(db), null);
  });

  afterEach(() => {
    sessions.dispose();
    db.close();
    nemo.server.stop(true);
  });

  const rows = () => db
    .prepare("SELECT transcription_status AS status, transcribed_text AS text, metadata FROM task_input_streams WHERE task_id = ? ORDER BY sequence")
    .all(taskId) as Array<{ status: string; text: string | null; metadata: string }>;

  it.skipIf(!hasFfmpeg)("streams every chunk into one session, drops the overlap, and ends it on release", async () => {
    sessions.setSpeechStreamSource({ target: () => ({ url: nemo.url, speakerLabels: true }) });
    sessions.startSession(taskId);
    // 1 s chunk, then a 2 s chunk whose first 0.5 s repeats the previous tail.
    await sessions.ingestInput(taskId, { sourceType: "audio", contentType: "audio/wav", contentBody: wavBase64(1), metadata: { format: "wav", overlap_seconds: 0 } });
    await sessions.ingestInput(taskId, { sourceType: "audio", contentType: "audio/wav", contentBody: wavBase64(2), metadata: { format: "wav", overlap_seconds: 0.5 } });

    await sessions.transcribePendingForTask(taskId);
    expect(nemo.state.sessions).toBe(1);
    expect(nemo.state.bytes).toBe(32000 + 48000); // 1 s + (2 s − 0.5 s overlap)
    const afterTick = rows();
    expect(afterTick.slice(0, 2).map((r) => [r.status, r.text])).toEqual([["transcribed", ""], ["transcribed", ""]]);
    expect(afterTick[2]!.text).toBe("Speaker 1: second 1\nSpeaker 2: second 2");
    expect(JSON.parse(afterTick[2]!.metadata)).toEqual({ streamed: true });

    // A later chunk goes into the SAME session (speaker state carries over):
    // 1.25 s − 0.5 s overlap makes 3.25 s in total, so second 3 plus a tail
    // that only the release commit finalizes.
    await sessions.ingestInput(taskId, { sourceType: "audio", contentType: "audio/wav", contentBody: wavBase64(1.25), metadata: { format: "wav", overlap_seconds: 0.5 } });
    await sessions.drainAndTranscribe(taskId, { finalizeStream: true });
    expect(nemo.state.sessions).toBe(1);
    const texts = rows().map((r) => r.text).filter(Boolean);
    expect(texts).toEqual(["Speaker 1: second 1\nSpeaker 2: second 2", "Speaker 1: second 3", "Speaker 1: tail"]);
  });

  it.skipIf(!hasFfmpeg)("falls back to per-chunk transcription when the stream cannot open", async () => {
    sessions.setSpeechStreamSource({ target: () => ({ url: "ws://127.0.0.1:1/v1/realtime", speakerLabels: false }) });
    sessions.startSession(taskId);
    await sessions.ingestInput(taskId, { sourceType: "audio", contentType: "audio/wav", contentBody: wavBase64(1), metadata: { format: "wav", overlap_seconds: 0 } });
    await sessions.transcribePendingForTask(taskId);
    // No local endpoint in this test DB: the HTTP path ran and recorded why.
    const [row] = rows();
    expect(row!.status).toBe("failed");
  });

  it("tells the caller which model loads before recording starts, and why transcription failed", async () => {
    const loads: string[] = [];
    sessions.setWhisperControls({
      acquire: async () => { throw new Error("Speech model X is not downloaded"); },
      release: () => {},
      pendingStartLabel: () => "Model X",
    });
    const result = await sessions.acquireRecording(taskId, { id: "web:a", label: "web" }, { onPreparing: (m) => loads.push(m) });
    expect(loads).toEqual(["Model X"]);
    expect(result).toEqual({ ok: true, state: "active", warning: "Speech model X is not downloaded" });
  });

  it.skipIf(!hasFfmpeg)("per-chunk path: cuts the repeated audio before transcription", async () => {
    sessions.setSpeechStreamSource({ target: () => null });
    updateRealtimeConfig({ transcription_provider: "local", transcription_endpoint: "http://127.0.0.1:1/inference" }, db);
    const sent: number[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const file = (init?.body as FormData).get("file") as Blob;
      sent.push((file.size - 44) / 32000); // seconds of 16 kHz PCM16 in the WAV
      return Response.json({ text: `one two three four ${sent.length}` });
    }) as typeof fetch;
    try {
      sessions.startSession(taskId);
      const first = noise(4, 11);
      const second = cat(first.subarray(first.byteLength - 2 * 32000), noise(3, 12)); // 2 s overlap + 3 s new
      const wav = (pcm: Uint8Array) => {
        const h = Buffer.alloc(44);
        h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.byteLength, 4); h.write("WAVE", 8); h.write("fmt ", 12);
        h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
        h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.byteLength, 40);
        return Buffer.concat([h, Buffer.from(pcm)]).toString("base64");
      };
      await sessions.ingestInput(taskId, { sourceType: "audio", contentType: "audio/wav", contentBody: wav(first), metadata: { format: "wav", overlap_seconds: 0 } });
      await sessions.ingestInput(taskId, { sourceType: "audio", contentType: "audio/wav", contentBody: wav(second), metadata: { format: "wav", overlap_seconds: 2 } });
      await sessions.transcribePendingForTask(taskId);
      expect(sent.map((x) => Math.round(x * 100) / 100).sort()).toEqual([3, 4]);
      // Audio was matched, so the text dedup did not run: it would have cut the
      // words both answers share ("one two three four") from the second chunk.
      expect(rows().map((r) => [r.status, r.text?.startsWith("one two three four ")])).toEqual([["transcribed", true], ["transcribed", true]]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the per-chunk path when no streaming model runs", async () => {
    sessions.setSpeechStreamSource({ target: () => null });
    sessions.startSession(taskId);
    await sessions.ingestInput(taskId, { sourceType: "audio", contentType: "audio/wav", contentBody: wavBase64(1), metadata: { format: "wav" } });
    await sessions.transcribePendingForTask(taskId);
    expect(nemo.state.sessions).toBe(0);
    expect(rows()[0]!.status).toBe("failed");
  });
});
