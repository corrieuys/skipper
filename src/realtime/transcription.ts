import { unlinkSync, writeFileSync } from "fs";
import type { RealtimeConfig } from "./config";
import { findSpeechModel } from "../speech/catalogue";

export interface TranscriptionAdapter {
  isConfigured(): boolean;
  notConfiguredReason(): string;
  /** Transcribe base64-encoded audio data and return text */
  transcribe(audioData: string, format: string): Promise<string>;
}

/** Strip whisper filler/pause markers ([pause], [silence], [blank_audio], [music]). */
export function stripFillerMarkers(text: string): string {
  return text
    .replace(/\[pause\]/gi, "")
    .replace(/\[silence\]/gi, "")
    .replace(/\[blank_audio\]/gi, "")
    .replace(/\[music\]/gi, "")
    .trim();
}

interface SpeakerWord {
  word?: string;
  speaker?: number | string;
}

/**
 * Turn a word list tagged with speakers (NeMo `verbose_json` with diarization)
 * into one line per speaker turn: "Speaker 1: ...". Words without a speaker
 * join the current turn. Returns "" when no word carries a speaker.
 */
export function formatSpeakerTranscript(words: SpeakerWord[]): string {
  const turns: Array<{ speaker: string; words: string[] }> = [];
  let sawSpeaker = false;
  for (const w of words) {
    const text = typeof w.word === "string" ? w.word.trim() : "";
    if (!text) continue;
    const speaker = w.speaker === undefined || w.speaker === null ? null : String(w.speaker);
    if (speaker !== null) sawSpeaker = true;
    const last = turns[turns.length - 1];
    if (last && (speaker === null || speaker === last.speaker)) {
      last.words.push(text);
    } else {
      turns.push({ speaker: speaker ?? "?", words: [text] });
    }
  }
  if (!sawSpeaker) return "";
  return turns.map((t) => `Speaker ${t.speaker}: ${t.words.join(" ")}`).join("\n");
}

/**
 * Local speech server adapter (whisper.cpp `/inference` or NeMo-Speech.cpp
 * `/v1/audio/transcriptions`; both take a multipart `file` and answer `{ text }`).
 * Converts audio to 16 kHz mono WAV via ffmpeg, then POSTs it to the endpoint the
 * managed engine wrote to `realtime_config.transcription_endpoint`. With
 * `speakerLabels` it asks for `verbose_json` + `diarization` and renders the
 * speaker-tagged words as "Speaker N:" lines (NeMo engine with a diarizer only).
 */
export class LocalWhisperAdapter implements TranscriptionAdapter {
  constructor(private endpoint: string, private opts: { speakerLabels?: boolean } = {}) {}

  isConfigured(): boolean {
    return !!this.endpoint;
  }

  notConfiguredReason(): string {
    return "Whisper not running. Start recording to activate whisper.";
  }

  async transcribe(audioData: string, format: string): Promise<string> {
    const tempId = crypto.randomUUID();
    // Distinct names: the app recorders send "wav", and an input path equal to
    // the output path makes ffmpeg refuse ("same as Input").
    const tempPath = `/tmp/skipper-${tempId}-in.${format}`;
    const wavPath = `/tmp/skipper-${tempId}-16k.wav`;

    console.log(`[transcription:local] converting audio — ${format}: ${tempPath} → wav: ${wavPath}`);
    console.log(`[transcription:local] will POST to whisper endpoint: ${this.endpoint}`);

    try {
      const buffer = Buffer.from(audioData, "base64");
      writeFileSync(tempPath, buffer);

      const ffmpeg = Bun.spawn({
        cmd: [
          "ffmpeg",
          "-i", tempPath,
          "-ar", "16000",
          "-ac", "1",
          "-c:a", "pcm_s16le",
          "-y", wavPath,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const ffmpegCode = await ffmpeg.exited;
      if (ffmpegCode !== 0) {
        const stderrText = await new Response(ffmpeg.stderr).text();
        throw new Error(
          `ffmpeg conversion failed with code ${ffmpegCode}: ${stderrText.slice(-500)}`,
        );
      }

      const wavBuffer = await Bun.file(wavPath).arrayBuffer();
      const formData = new FormData();
      formData.append(
        "file",
        new Blob([wavBuffer], { type: "audio/wav" }),
        "audio.wav",
      );
      if (this.opts.speakerLabels) {
        formData.append("response_format", "verbose_json");
        formData.append("diarization", "true");
      } else {
        formData.append("response_format", "json");
      }

      const res = await fetch(this.endpoint, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(
          `Whisper server returned ${res.status}: ${body.slice(0, 200)}`,
        );
      }

      const json = (await res.json()) as { text?: string; words?: SpeakerWord[] };
      const labelled = this.opts.speakerLabels && Array.isArray(json.words) ? formatSpeakerTranscript(json.words) : "";
      const result = labelled || (json.text ?? "");
      console.log(`[transcription:local] result — ${result.length} chars: "${result.slice(0, 120)}${result.length > 120 ? "…" : ""}"`);
      return result;
    } finally {
      // Best effort: temp audio cleanup — files may not exist if conversion failed.
      try { unlinkSync(tempPath); } catch {}
      try { unlinkSync(wavPath); } catch {}
    }
  }
}

const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";

/**
 * OpenAI REST API adapter.
 * POSTs audio directly to OpenAI's /v1/audio/transcriptions endpoint.
 * Supports webm, mp3, wav, etc. natively — no ffmpeg conversion needed.
 */
export class OpenAIAdapter implements TranscriptionAdapter {
  private apiKey: string;
  private model: string;

  constructor(model: string) {
    this.apiKey = process.env.OPENAI_API_KEY ?? "";
    this.model = model;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  notConfiguredReason(): string {
    return "OPENAI_API_KEY environment variable not set";
  }

  async transcribe(audioData: string, format: string): Promise<string> {
    const mimeType = format === "wav" ? "audio/wav"
      : format === "mp3" ? "audio/mpeg"
      : `audio/${format}`;

    console.log(`[transcription:openai] sending ${format} audio to OpenAI (model: ${this.model})`);

    const buffer = Buffer.from(audioData, "base64");
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([buffer], { type: mimeType }),
      `audio.${format}`,
    );
    formData.append("model", this.model);
    formData.append("response_format", "json");

    const res = await fetch(OPENAI_TRANSCRIPTION_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `OpenAI transcription API returned ${res.status}: ${body.slice(0, 300)}`,
      );
    }

    const json = (await res.json()) as { text?: string };
    const result = json.text ?? "";
    console.log(`[transcription:openai] result — ${result.length} chars: "${result.slice(0, 120)}${result.length > 120 ? "…" : ""}"`);
    return result;
  }
}

/**
 * Factory: create the appropriate transcription adapter based on config.
 * Speaker labels apply only to a local model that supports them and only when
 * the caller allows them (dictation passes `speakerLabels: false`).
 */
export function createTranscriptionAdapter(
  config: RealtimeConfig,
  opts: { speakerLabels?: boolean } = {},
): TranscriptionAdapter {
  switch (config.transcription_provider) {
    case "openai":
      return new OpenAIAdapter(config.openai_transcription_model);
    case "local":
    default: {
      const speakerLabels = (opts.speakerLabels ?? true)
        && config.speaker_labels
        && !!findSpeechModel(config.local_model)?.speakers;
      return new LocalWhisperAdapter(config.transcription_endpoint, { speakerLabels });
    }
  }
}
