import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../paths";
import { findLocalEmbeddingModel, type LocalEmbeddingModel } from "./catalogue";

/**
 * The embeddings server Skipper manages itself: a prebuilt `llama-server` from
 * the llama.cpp GitHub releases plus a GGUF model from the catalogue, both
 * downloaded into `<data dir>/llama/` (never the source tree or the binary, so
 * it works the same from the compiled binary). Started lazily with
 * `--embedding` on the first embed request and serves OpenAI-compatible
 * `/v1/embeddings`, so the same client code talks to it and to a remote endpoint.
 *
 * Mirrors the whisper manager's lifecycle (spawn, health poll, kill on exit) but
 * unlike whisper it can install itself: `installBinary()` picks the newest
 * `b<build>` release for this OS/arch, `installModel()` fetches the GGUF.
 */

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8089;
const READY_POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 60_000;
const RELEASES_URL = "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30";

export interface DownloadProgress {
  what: string;
  received: number;
  total: number | null;
}

export interface LocalServerStatus {
  binaryInstalled: boolean;
  binaryTag: string | null;
  modelId: string;
  modelInstalled: boolean;
  running: boolean;
  /** A start is in flight (spawned, waiting for /health). */
  starting: boolean;
  endpoint: string | null;
  download: DownloadProgress | null;
  lastError: string | null;
  /** Whether prebuilt llama.cpp binaries exist for this OS/arch at all. */
  platformSupported: boolean;
}

export interface EmbeddingServerOptions {
  host?: string;
  port?: number;
  /** Override the install root (tests). Default `<data dir>/llama`. */
  rootDir?: string;
  /** Override the GitHub releases listing (tests). */
  releasesUrl?: string;
  fetchImpl?: typeof fetch;
}

interface BinaryRecord {
  tag: string;
  serverPath: string;
}

/** Release asset suffix for this platform, or null when llama.cpp ships none. */
export function llamaAssetSuffix(platform = process.platform, arch = process.arch): string | null {
  if (platform === "darwin" && arch === "arm64") return "bin-macos-arm64.tar.gz";
  if (platform === "darwin" && arch === "x64") return "bin-macos-x64.tar.gz";
  if (platform === "linux" && arch === "x64") return "bin-ubuntu-x64.tar.gz";
  if (platform === "linux" && arch === "arm64") return "bin-ubuntu-arm64.tar.gz";
  return null;
}

function findFileNamed(dir: string, name: string, depth = 0): string | null {
  if (depth > 6 || !existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const hit = findFileNamed(full, name, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export class EmbeddingServerManager {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private runningModelId: string | null = null;
  private starting: Promise<void> | null = null;
  private host: string;
  private port: number;
  private rootDir: string;
  private releasesUrl: string;
  private fetchImpl: typeof fetch;
  private download: DownloadProgress | null = null;
  private lastError: string | null = null;

  constructor(options: EmbeddingServerOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? (Number(process.env.SKIPPER_EMBED_PORT) || DEFAULT_PORT);
    this.rootDir = options.rootDir ?? join(getDataDir(), "llama");
    this.releasesUrl = options.releasesUrl ?? RELEASES_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    process.on("exit", () => this.stop());
  }

  // ── paths ──────────────────────────────────────────────

  private binaryRecordPath(): string {
    return join(this.rootDir, "binary.json");
  }

  private modelsDir(): string {
    return join(this.rootDir, "models");
  }

  modelPath(model: LocalEmbeddingModel): string {
    return join(this.modelsDir(), model.file);
  }

  private readBinaryRecord(): BinaryRecord | null {
    try {
      const rec = JSON.parse(readFileSync(this.binaryRecordPath(), "utf8")) as BinaryRecord;
      if (rec && typeof rec.serverPath === "string" && existsSync(rec.serverPath)) return rec;
    } catch {
      /* not installed */
    }
    return null;
  }

  // ── status ─────────────────────────────────────────────

  isBinaryInstalled(): boolean {
    return this.readBinaryRecord() !== null;
  }

  isModelInstalled(modelId: string): boolean {
    const model = findLocalEmbeddingModel(modelId);
    return !!model && existsSync(this.modelPath(model));
  }

  /** Healthy and serving. False while a start is still waiting on /health. */
  isRunning(): boolean {
    return this.proc !== null && this.starting === null;
  }

  isStarting(): boolean {
    return this.starting !== null;
  }

  /** Model id the live server was started with (null when stopped). */
  getRunningModelId(): string | null {
    return this.runningModelId;
  }

  /** OpenAI-compatible base URL (`.../v1`). */
  getBaseUrl(): string {
    return `http://${this.host}:${this.port}/v1`;
  }

  getStatus(modelId: string): LocalServerStatus {
    const rec = this.readBinaryRecord();
    return {
      binaryInstalled: rec !== null,
      binaryTag: rec?.tag ?? null,
      modelId,
      modelInstalled: this.isModelInstalled(modelId),
      running: this.isRunning(),
      starting: this.isStarting(),
      endpoint: this.isRunning() ? this.getBaseUrl() : null,
      download: this.download,
      lastError: this.lastError,
      platformSupported: llamaAssetSuffix() !== null,
    };
  }

  isDownloading(): boolean {
    return this.download !== null;
  }

  // ── install ────────────────────────────────────────────

  /**
   * Download + unpack the newest llama.cpp build for this platform. Releases are
   * tagged `b<build>` and marked prerelease, so the listing is scanned for the
   * first tag of that shape that carries our asset; the GitHub `latest` pointer
   * is a versioned tag with no binaries and is deliberately ignored.
   */
  async installBinary(): Promise<BinaryRecord> {
    const suffix = llamaAssetSuffix();
    if (!suffix) throw new Error(`No prebuilt llama.cpp binary for ${process.platform}/${process.arch}. Use a custom embeddings endpoint instead.`);
    if (this.download) throw new Error(`A download is already in progress (${this.download.what})`);

    this.lastError = null;
    this.download = { what: "llama-server release list", received: 0, total: null };
    try {
      const res = await this.fetchImpl(this.releasesUrl, { headers: { Accept: "application/vnd.github+json", "User-Agent": "skipper" } });
      if (!res.ok) throw new Error(`GitHub releases request failed: ${res.status} ${res.statusText}`);
      const releases = await res.json() as Array<{ tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string; size?: number }> }>;
      let tag: string | null = null;
      let url: string | null = null;
      let size: number | null = null;
      for (const rel of releases) {
        if (!rel.tag_name || !/^b\d+$/.test(rel.tag_name)) continue;
        const asset = (rel.assets ?? []).find((a) => typeof a.name === "string" && a.name.endsWith(suffix));
        if (asset?.browser_download_url) {
          tag = rel.tag_name;
          url = asset.browser_download_url;
          size = typeof asset.size === "number" ? asset.size : null;
          break;
        }
      }
      if (!tag || !url) throw new Error(`No llama.cpp release asset ending in ${suffix} found`);

      const installDir = join(this.rootDir, "bin", tag);
      const tgz = join(this.rootDir, `${tag}.tar.gz.part`);
      mkdirSync(this.rootDir, { recursive: true });
      this.download = { what: `llama-server ${tag}`, received: 0, total: size };
      await this.downloadTo(url, tgz);

      rmSync(installDir, { recursive: true, force: true });
      mkdirSync(installDir, { recursive: true });
      const tar = Bun.spawn({ cmd: ["tar", "-xzf", tgz, "-C", installDir], stdout: "ignore", stderr: "pipe" });
      const stderr = await new Response(tar.stderr).text();
      const code = await tar.exited;
      rmSync(tgz, { force: true });
      if (code !== 0) throw new Error(`tar failed (${code}): ${stderr.trim().slice(0, 300)}`);

      const serverPath = findFileNamed(installDir, "llama-server");
      if (!serverPath) throw new Error(`llama-server not found inside ${tag} archive`);
      try { chmodSync(serverPath, 0o755); } catch { /* already executable */ }

      // Replace the previous build only after the new one is fully in place.
      const previous = this.readBinaryRecord();
      const record: BinaryRecord = { tag, serverPath };
      writeFileSync(this.binaryRecordPath(), JSON.stringify(record, null, 2));
      if (previous && previous.tag !== tag) {
        rmSync(join(this.rootDir, "bin", previous.tag), { recursive: true, force: true });
      }
      return record;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.download = null;
    }
  }

  async installModel(modelId: string): Promise<string> {
    const model = findLocalEmbeddingModel(modelId);
    if (!model) throw new Error(`Unknown local embedding model: ${modelId}`);
    if (this.download) throw new Error(`A download is already in progress (${this.download.what})`);
    const dest = this.modelPath(model);
    if (existsSync(dest)) return dest;

    this.lastError = null;
    this.download = { what: model.label, received: 0, total: model.bytes };
    try {
      mkdirSync(this.modelsDir(), { recursive: true });
      const part = `${dest}.part`;
      await this.downloadTo(model.url, part);
      const size = statSync(part).size;
      if (model.bytes > 0 && size !== model.bytes) {
        rmSync(part, { force: true });
        throw new Error(`Model download size mismatch: got ${size} bytes, expected ${model.bytes}`);
      }
      renameSync(part, dest);
      return dest;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.download = null;
    }
  }

  private async downloadTo(url: string, dest: string): Promise<void> {
    const res = await this.fetchImpl(url, { redirect: "follow", headers: { "User-Agent": "skipper" } });
    if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText} (${url})`);
    const lengthHeader = res.headers.get("content-length");
    if (this.download && lengthHeader && this.download.total === null) this.download.total = Number(lengthHeader);
    rmSync(dest, { force: true });
    const writer = Bun.file(dest).writer();
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        writer.write(value);
        if (this.download) this.download.received += value.byteLength;
      }
      await writer.end();
    } catch (err) {
      try { await writer.end(); } catch { /* ignore */ }
      rmSync(dest, { force: true });
      throw err;
    }
  }

  // ── run ────────────────────────────────────────────────

  /**
   * Start (or restart onto a different model). Concurrent callers share one
   * start; a second start for the same model while it is up is a no-op.
   */
  async ensureRunning(modelId: string): Promise<void> {
    if (this.starting) {
      await this.starting;
    }
    if (this.proc && this.runningModelId === modelId) return;
    const starting = this.start(modelId);
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  /** Spawn + wait for /health. Prefer `ensureRunning`, which also tracks the starting state. */
  async start(modelId: string): Promise<void> {
    const model = findLocalEmbeddingModel(modelId);
    if (!model) throw new Error(`Unknown local embedding model: ${modelId}`);
    const rec = this.readBinaryRecord();
    if (!rec) throw new Error("Local embedding server is not installed. Download it from Config > Task Memory.");
    const modelFile = this.modelPath(model);
    if (!existsSync(modelFile)) throw new Error(`Embedding model ${model.id} is not downloaded. Download it from Config > Task Memory.`);

    if (this.proc) this.stop();
    this.lastError = null;
    console.log(`[task-memory] starting llama-server (${rec.tag}, ${model.id}) on ${this.host}:${this.port}`);

    const proc = Bun.spawn({
      cmd: [
        rec.serverPath,
        "-m", modelFile,
        "--embedding",
        "--pooling", model.pooling,
        "-c", String(model.ctx),
        "-ub", String(model.ctx),
        "-b", String(model.ctx),
        "--host", this.host,
        "--port", String(this.port),
        "--no-webui",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;
    this.runningModelId = model.id;
    this.drain(proc.stdout);
    this.drain(proc.stderr);
    proc.exited.then((code) => {
      if (this.proc === proc) {
        console.error(`[task-memory] llama-server exited unexpectedly with code ${code}`);
        this.proc = null;
        this.runningModelId = null;
      }
    });

    try {
      await this.waitForReady(proc);
      console.log(`[task-memory] llama-server ready at ${this.getBaseUrl()}`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.stop();
      throw err;
    }
  }

  stop(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.runningModelId = null;
    try { proc.kill(); } catch { /* already gone */ }
  }

  private async waitForReady(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const started = Date.now();
    const url = `http://${this.host}:${this.port}/health`;
    while (Date.now() - started < READY_TIMEOUT_MS) {
      if (this.proc !== proc) throw new Error("llama-server exited during startup");
      try {
        const res = await fetch(url);
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
    }
    throw new Error(`llama-server did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
  }

  private drain(stream: ReadableStream<Uint8Array> | null): void {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const read = (): void => {
      reader.read().then(({ done, value }) => {
        if (done) return;
        const text = decoder.decode(value, { stream: true }).trim();
        if (text && process.env.SKIPPER_EMBED_LOG) console.log(`[llama-server] ${text.slice(0, 200)}`);
        read();
      }).catch(() => { /* stream closed */ });
    };
    read();
  }
}
