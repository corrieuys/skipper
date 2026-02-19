import { unlinkSync, writeFileSync } from "fs";
import type { RealtimeConfig } from "./config";

export interface TranscriptionAdapter {
  /** Whether this adapter has enough configuration to operate */
  isConfigured(): boolean;
  /** Human-readable reason why the adapter is not configured */
  notConfiguredReason(): string;
  /** Transcribe base64-encoded audio data and return text */
  transcribe(audioData: string, format: string): Promise<string>;
}

/**
 * Local whisper-server adapter.
 * Converts audio to WAV via ffmpeg, then POSTs to a local whisper-server endpoint.
 */
export class LocalWhisperAdapter implements TranscriptionAdapter {
  constructor(private endpoint: string) {}

  isConfigured(): boolean {
    return !!this.endpoint;
  }

  notConfiguredReason(): string {
    return "Whisper not running. Start recording to activate whisper.";
  }

  async transcribe(audioData: string, format: string): Promise<string> {
    const tempId = crypto.randomUUID();
    const tempPath = `/tmp/skipper-${tempId}.${format}`;
    const wavPath = `/tmp/skipper-${tempId}.wav`;

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
      formData.append("response_format", "json");

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

      const json = (await res.json()) as { text?: string };
      const result = json.text ?? "";
      console.log(`[transcription:local] result — ${result.length} chars: "${result.slice(0, 120)}${result.length > 120 ? "…" : ""}"`);
      return result;
    } finally {
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
 */
export function createTranscriptionAdapter(config: RealtimeConfig): TranscriptionAdapter {
  switch (config.transcription_provider) {
    case "openai":
      return new OpenAIAdapter(config.openai_transcription_model);
    case "local":
    default:
      return new LocalWhisperAdapter(config.transcription_endpoint);
  }
}
