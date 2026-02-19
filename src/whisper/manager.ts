import { existsSync } from "fs";
import { join, resolve } from "path";
import { updateRealtimeConfig } from "../realtime/config";
import type { Database } from "bun:sqlite";

const VENDOR_DIR = resolve(import.meta.dir, "../../vendor/whisper.cpp");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8080;
const READY_POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 30_000;

export interface WhisperManagerOptions {
  host?: string;
  port?: number;
  modelPath?: string;
  binaryPath?: string;
}

export class WhisperManager {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private stopped = false;
  private host: string;
  private port: number;
  private modelPath: string;
  private binaryPath: string;

  constructor(options: WhisperManagerOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? (Number(process.env.WHISPER_PORT) || DEFAULT_PORT);
    this.modelPath = options.modelPath ?? this.findModel();
    this.binaryPath = options.binaryPath ?? this.findBinary();

    // Kill any orphaned whisper-server on this port when the process exits
    // unexpectedly (e.g. uncaught exception, SIGKILL to parent).
    process.on("exit", () => this.stop());
  }

  async start(db?: Database): Promise<void> {
    if (this.proc) {
      throw new Error("Whisper server is already running");
    }

    if (!existsSync(this.binaryPath)) {
      throw new Error(
        `Whisper server binary not found at ${this.binaryPath}. Run: bash scripts/setup-whisper.sh`,
      );
    }

    if (!existsSync(this.modelPath)) {
      throw new Error(
        `Whisper model not found at ${this.modelPath}. Run: bash scripts/setup-whisper.sh`,
      );
    }

    console.log(`Starting whisper-server on ${this.host}:${this.port}...`);
    this.stopped = false;

    this.proc = Bun.spawn({
      cmd: [
        this.binaryPath,
        "-m", this.modelPath,
        "--host", this.host,
        "--port", String(this.port),
        "--convert",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    // Drain stdout/stderr to prevent buffer blocking
    this.drainStream(this.proc.stdout);
    this.drainStream(this.proc.stderr);

    // Handle unexpected exit
    this.proc.exited.then((code) => {
      if (this.proc) {
        console.error(`whisper-server exited unexpectedly with code ${code}`);
        this.proc = null;
      }
    });

    // Wait for the server to be ready
    await this.waitForReady();

    // Auto-configure the transcription endpoint
    const endpoint = `http://${this.host}:${this.port}/inference`;
    console.log(`whisper-server ready at ${endpoint}`);

    if (db) {
      updateRealtimeConfig({ transcription_endpoint: endpoint }, db);
    }
  }

  stop(db?: Database): void {
    if (!this.proc) return;

    console.log("Stopping whisper-server...");
    this.stopped = true;
    this.proc.kill();
    this.proc = null;

    if (db) {
      updateRealtimeConfig({ transcription_endpoint: "" }, db);
    }
  }

  isRunning(): boolean {
    return this.proc !== null;
  }

  getEndpoint(): string {
    return `http://${this.host}:${this.port}/inference`;
  }

  private async waitForReady(): Promise<void> {
    const start = Date.now();
    const url = `http://${this.host}:${this.port}/health`;

    while (Date.now() - start < READY_TIMEOUT_MS) {
      // Check if process died during startup
      if (!this.proc) {
        throw new Error("whisper-server process exited during startup");
      }

      try {
        const res = await fetch(url);
        if (res.ok) return;
      } catch {
        // Server not ready yet
      }

      await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
    }

    // Timed out — kill the process
    this.stop();
    throw new Error(
      `whisper-server did not become ready within ${READY_TIMEOUT_MS / 1000}s`,
    );
  }

  private findBinary(): string {
    const candidates = [
      join(VENDOR_DIR, "build/bin/whisper-server"),
      join(VENDOR_DIR, "build/bin/server"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    // Fall back to PATH
    return "whisper-server";
  }

  private findModel(): string {
    const modelDir = join(VENDOR_DIR, "models");
    const defaultModel = join(modelDir, "ggml-base.en.bin");
    if (existsSync(defaultModel)) return defaultModel;
    return process.env.WHISPER_MODEL ?? defaultModel;
  }

  private drainStream(
    stream: ReadableStream<Uint8Array> | null,
  ): void {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const read = (): void => {
      reader.read().then(({ done, value }) => {
        if (done || this.stopped) return;
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) {
          console.log(`[whisper] ${text.trim().slice(0, 200)}`);
        }
        read();
      }).catch(() => { });
    };
    read();
  }
}
