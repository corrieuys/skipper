import { formatSpeakerTranscript } from "../realtime/transcription";

/**
 * One live NeMo-Speech.cpp realtime session (`ws://.../v1/realtime`) for one
 * recording. The recognizer (and, with speaker labels, the Sortformer speaker
 * cache) keeps its state across every chunk pushed into it, so text flows
 * across chunk boundaries and speaker numbers stay stable for the whole
 * recording (up to 4 speakers). `finish()` commits, which finalizes the last
 * utterance and ends the stream.
 *
 * Protocol (NeMo-Speech.cpp `server/http/http_server.cpp`): `session.update`
 * before audio; binary frames of 16 kHz mono PCM16; finals arrive as
 * `conversation.item.input_audio_transcription.completed` (`transcript`, plus
 * `words[]` with `speaker` when diarization is on) whenever the recognizer ends
 * an utterance; `input_audio_buffer.commit` → last final + `.committed`.
 *
 * The server handles messages strictly in order and has no ping, so `sync()`
 * sends an event type it does not know: the error it answers with arrives only
 * after every earlier frame was recognized. That is the barrier that lets a
 * cadence tick collect the text for the audio it just pushed.
 */

const SYNC_EVENT = "skipper.sync";
const KEEPALIVE_MS = 10_000;
/** 64 KB (2 s of 16 kHz PCM16) per binary frame. */
const FRAME_BYTES = 64 * 1024;
/** Pushed audio kept to match the next chunk's repeat against (3 s). */
const TAIL_BYTES = 16_000 * 2 * 3;

export interface StreamTarget {
  url: string;
  speakerLabels: boolean;
}

interface ServerEvent {
  type?: string;
  transcript?: string;
  words?: Array<{ word?: string; speaker?: number }>;
  error?: { message?: string };
}

export class StreamTranscriber {
  readonly target: StreamTarget;
  private ws: WebSocket | null = null;
  private finals: string[] = [];
  private waiters: Array<{ match: (e: ServerEvent) => boolean; resolve: () => void; reject: (err: Error) => void }> = [];
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private audioBytes = 0;
  /** The last few seconds pushed, to find where the next chunk's repeat ends. */
  private tail = new Uint8Array(0);
  lastError: string | null = null;

  constructor(target: StreamTarget, private readonly WebSocketImpl: typeof WebSocket = WebSocket) {
    this.target = target;
  }

  /** Connect and configure the session. Rejects when the server refuses or does not answer. */
  async open(timeoutMs = 10_000): Promise<void> {
    const ws = new this.WebSocketImpl(this.target.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (ev) => this.onEvent(typeof ev.data === "string" ? ev.data : "");
    ws.onclose = () => this.onClose("speech stream closed");
    ws.onerror = () => { this.lastError ??= "speech stream error"; };

    await this.waitFor((e) => e.type === "session.created", timeoutMs);
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        sample_rate: 16_000,
        automatic_punctuation: true,
        word_timestamps: this.target.speakerLabels,
        speaker_diarization: this.target.speakerLabels,
      },
    }));
    await this.waitFor((e) => e.type === "session.updated", timeoutMs);
    // The server drops a socket that sends nothing for its read timeout (30 s by
    // default), longer than a quiet gap between chunks can be. An empty binary
    // frame is a no-op on the server side.
    this.keepalive = setInterval(() => {
      if (this.isOpen()) this.ws!.send(new Uint8Array(0));
    }, KEEPALIVE_MS);
  }

  isOpen(): boolean {
    return !this.closed && this.ws?.readyState === 1;
  }

  /** Audio bytes pushed so far (0 = nothing yet, so a first chunk has no overlap to drop). */
  pushedBytes(): number {
    return this.audioBytes;
  }

  /** Push 16 kHz mono PCM16 (little endian). */
  push(pcm: Uint8Array): void {
    if (!this.isOpen()) throw new Error(this.lastError ?? "speech stream is not open");
    for (let off = 0; off < pcm.byteLength; off += FRAME_BYTES) {
      this.ws!.send(pcm.subarray(off, Math.min(off + FRAME_BYTES, pcm.byteLength)));
    }
    this.audioBytes += pcm.byteLength;
    const keep = TAIL_BYTES;
    const joined = new Uint8Array(Math.min(keep, this.tail.byteLength + pcm.byteLength));
    const fromTail = joined.byteLength - Math.min(pcm.byteLength, joined.byteLength);
    joined.set(this.tail.subarray(this.tail.byteLength - fromTail), 0);
    joined.set(pcm.subarray(pcm.byteLength - (joined.byteLength - fromTail)), fromTail);
    this.tail = joined;
  }

  /** The chunk without the audio it repeats from what was already pushed. */
  trimRepeat(pcm: Uint8Array, overlapSeconds: number): { pcm: Uint8Array; matched: boolean } {
    if (this.audioBytes === 0) return { pcm, matched: false };
    const { bytes, matched } = overlapBytes(this.tail, pcm, overlapSeconds);
    return { pcm: bytes >= pcm.byteLength ? new Uint8Array(0) : pcm.subarray(bytes), matched };
  }

  /** Wait until the server has recognized everything pushed so far. */
  async sync(timeoutMs = 60_000): Promise<void> {
    if (!this.isOpen()) throw new Error(this.lastError ?? "speech stream is not open");
    const done = this.waitFor((e) => e.type === "error" && !!e.error?.message?.includes(SYNC_EVENT), timeoutMs);
    this.ws!.send(JSON.stringify({ type: SYNC_EVENT }));
    await done;
  }

  /** Finalized text since the last call ("Speaker N:" lines when speaker labels are on). */
  takeText(): string {
    const text = this.finals.join("\n");
    this.finals = [];
    return text;
  }

  /** Commit (finalizes the last utterance), collect the rest of the text, close. */
  async finish(timeoutMs = 60_000): Promise<string> {
    try {
      if (this.isOpen()) {
        const done = this.waitFor((e) => e.type === "input_audio_buffer.committed", timeoutMs);
        this.ws!.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        await done;
      }
    } finally {
      this.close();
    }
    return this.takeText();
  }

  close(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    if (this.closed) return;
    this.closed = true;
    try { this.ws?.close(); } catch { /* already closed */ }
    this.failWaiters(new Error(this.lastError ?? "speech stream closed"));
  }

  private onEvent(raw: string): void {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const labelled = this.target.speakerLabels && Array.isArray(event.words) ? formatSpeakerTranscript(event.words) : "";
      const text = (labelled || event.transcript || "").trim();
      if (text) this.finals.push(text);
    } else if (event.type === "error" && !event.error?.message?.includes(SYNC_EVENT)) {
      this.lastError = event.error?.message ?? "speech stream error";
    }
    for (const w of [...this.waiters]) {
      if (w.match(event)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  }

  private onClose(reason: string): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    this.closed = true;
    this.lastError ??= reason;
    this.failWaiters(new Error(this.lastError));
  }

  private failWaiters(err: Error): void {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w.reject(err);
  }

  private waitFor(match: (e: ServerEvent) => boolean, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.closed) {
        reject(new Error(this.lastError ?? "speech stream closed"));
        return;
      }
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("speech stream did not answer in time"));
      }, timeoutMs);
      const waiter = {
        match,
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (err: Error) => { clearTimeout(timer); reject(err); },
      };
      this.waiters.push(waiter);
    });
  }
}

/** Decode any recorded chunk (webm/opus, wav, m4a, ...) to 16 kHz mono PCM16 with ffmpeg. */
export async function decodeToPcm16(audioBase64: string, format: string): Promise<Uint8Array> {
  const tempPath = `/tmp/skipper-${crypto.randomUUID()}-in.${format.replace(/[^a-z0-9]/gi, "") || "bin"}`;
  await Bun.write(tempPath, Buffer.from(audioBase64, "base64"));
  try {
    const proc = Bun.spawn({
      cmd: ["ffmpeg", "-loglevel", "error", "-i", tempPath, "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", "pipe:1"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [pcm, stderr, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`ffmpeg decode failed with code ${code}: ${stderr.trim().slice(-300)}`);
    return new Uint8Array(pcm);
  } finally {
    try { (await import("node:fs")).unlinkSync(tempPath); } catch { /* best effort */ }
  }
}

/** 16 kHz mono PCM16 as a WAV file. */
export function pcm16ToWav(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const ascii = (off: number, t: string) => { for (let i = 0; i < t.length; i++) out[off + i] = t.charCodeAt(i); };
  ascii(0, "RIFF"); v.setUint32(4, 36 + pcm.byteLength, true); ascii(8, "WAVE");
  ascii(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16_000, true); v.setUint32(28, 32_000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, "data"); v.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

const SAMPLE_RATE = 16_000;
/** Length of the previous audio's end that is searched for in the next chunk. */
const MATCH_WINDOW_SAMPLES = SAMPLE_RATE * 1.5;
/** Below this normalized correlation the match is not trusted (e.g. silence). */
const MIN_MATCH_SCORE = 0.6;
const COARSE_STEP = 8;

function toSamples(pcm: Uint8Array): Int16Array {
  const copy = pcm.byteOffset % 2 === 0 ? pcm : pcm.slice();
  return new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 2));
}

function normalizedCorrelation(a: Int16Array, aStart: number, b: Int16Array, bStart: number, len: number, step: number): number {
  let sa = 0, sb = 0, n = 0;
  for (let i = 0; i < len; i += step) { sa += a[aStart + i]!; sb += b[bStart + i]!; n++; }
  const ma = sa / n, mb = sb / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < len; i += step) {
    const x = a[aStart + i]! - ma, y = b[bStart + i]! - mb;
    ab += x * y; aa += x * x; bb += y * y;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * How many leading bytes of a new chunk repeat audio already streamed. The
 * last 1.5 s already pushed (`previousTail`) is searched for in the chunk's
 * first `overlapSeconds + 4` s; everything up to the end of the match is a
 * repeat. This is exact for the app recorders' WAV chunks and also removes
 * what a fixed cut cannot: the web recorder puts its first MediaRecorder slice
 * (the WebM header, with ~1 s of the recording's first audio) in front of every
 * chunk, so a chunk is [header audio][overlap][new]. When no trusted match
 * exists (the tail is silence, too little audio), it falls back to the fixed
 * `overlapSeconds` cut.
 */
export function overlapBytes(previousTail: Uint8Array, chunk: Uint8Array, overlapSeconds: number): { bytes: number; matched: boolean } {
  const fixed = Math.min(chunk.byteLength, Math.round(Math.max(0, overlapSeconds) * SAMPLE_RATE) * 2);
  if (!(overlapSeconds > 0)) return { bytes: 0, matched: false };
  const tail = toSamples(previousTail);
  const next = toSamples(chunk);
  const win = Math.min(MATCH_WINDOW_SAMPLES, tail.length);
  if (win < SAMPLE_RATE / 2) return { bytes: fixed, matched: false };
  const ref = tail.length - win;
  const maxStart = Math.min(next.length - win, Math.round((overlapSeconds + 4) * SAMPLE_RATE));
  if (maxStart < 0) return { bytes: fixed, matched: false };

  // Coarse pass on every 8th sample and offset, then refine at full rate.
  let best = -1, bestAt = -1;
  for (let at = 0; at <= maxStart; at += COARSE_STEP) {
    const c = normalizedCorrelation(tail, ref, next, at, win, COARSE_STEP);
    if (c > best) { best = c; bestAt = at; }
  }
  if (bestAt < 0) return { bytes: fixed, matched: false };
  let fine = -1, fineAt = bestAt;
  for (let at = Math.max(0, bestAt - COARSE_STEP); at <= Math.min(maxStart, bestAt + COARSE_STEP); at++) {
    const c = normalizedCorrelation(tail, ref, next, at, win, 1);
    if (c > fine) { fine = c; fineAt = at; }
  }
  if (fine < MIN_MATCH_SCORE) return { bytes: fixed, matched: false };
  return { bytes: (fineAt + win) * 2, matched: true };
}
