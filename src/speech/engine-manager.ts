import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { getDataDir } from "../paths";
import { getRealtimeConfig, updateRealtimeConfig } from "../realtime/config";
import { findSpeechModel, resolveSpeechModel, SPEAKER_MODEL, SPEECH_MODELS, type SpeechEngineId, type SpeechModel, type SpeechModelFile } from "./catalogue";
import type { StreamTarget } from "./stream-transcriber";

/**
 * The local speech-to-text server Skipper manages for recording and dictation.
 * One engine runs at a time, chosen by the configured model (`realtime_config.
 * local_model`): whisper.cpp `whisper-server` for Whisper models, NVIDIA
 * NeMo-Speech.cpp `nemo-speech serve` for Nemotron / Parakeet models. Models
 * and the NeMo binary download into `<data dir>/speech/` (never the source tree,
 * so the compiled binary works); downloads are size + SHA-256 checked.
 *
 * whisper.cpp ships no macOS release binary, so on macOS the whisper binary is
 * the dev build (`vendor/whisper.cpp`, `scripts/setup-whisper.sh`) or a
 * `whisper-server` on PATH (`brew install whisper-cpp`). A Whisper model already
 * in `vendor/whisper.cpp/models` is used without downloading it again.
 *
 * Lifecycle matches the old whisper manager: ref-counted `acquire`/`release` by
 * recording owners, health poll, the transcription endpoint written to
 * `realtime_config.transcription_endpoint` on start and cleared on stop.
 */

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8080;
const READY_POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 120_000;
const NEMO_RELEASES_URL = "https://api.github.com/repos/NVIDIA/NeMo-Speech.cpp/releases?per_page=10";
const WHISPER_RELEASES_URL = "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30";
const VENDOR_WHISPER_DIR = resolve(import.meta.dir, "../../vendor/whisper.cpp");

export interface DownloadProgress {
  what: string;
  received: number;
  total: number | null;
}

export interface SpeechEngineStatus {
  modelId: string;
  engine: SpeechEngineId;
  /** Engine binary found (managed install, dev build, or PATH). */
  binaryInstalled: boolean;
  binaryPath: string | null;
  /** Skipper can download the engine binary for this platform. */
  binaryInstallable: boolean;
  /** How to get the binary when Skipper cannot download it. */
  binaryHint: string | null;
  modelInstalled: boolean;
  /** Speaker labels are on and the model supports them. */
  speakersWanted: boolean;
  speakerModelInstalled: boolean;
  running: boolean;
  starting: boolean;
  runningModelId: string | null;
  endpoint: string | null;
  download: DownloadProgress | null;
  lastError: string | null;
  /** Model ids (incl. the speaker model) present on disk, managed or vendored. */
  installedIds: string[];
  /** Models Skipper downloaded into its own dir (deletable), with their size on disk. */
  managedModels: Array<{ id: string; label: string; bytes: number }>;
}

export interface SpeechEngineOptions {
  host?: string;
  port?: number;
  /** Override the install root (tests). Default `<data dir>/speech`. */
  rootDir?: string;
  /** Override the vendored whisper.cpp dir (tests). */
  vendorWhisperDir?: string;
  nemoReleasesUrl?: string;
  whisperReleasesUrl?: string;
  fetchImpl?: typeof fetch;
  /** Override PATH lookup (tests). */
  which?: (name: string) => string | null;
}

interface BinaryRecord {
  tag: string;
  path: string;
}

interface ReleaseAsset {
  name?: string;
  browser_download_url?: string;
  size?: number;
}

interface Release {
  tag_name?: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: ReleaseAsset[];
}

/** NeMo-Speech.cpp release archive suffix for this platform, or null when none ships. */
export function nemoAssetSuffix(platform = process.platform, arch = process.arch): string | null {
  if (platform === "darwin" && arch === "arm64") return "macos-aarch64-metal.tar.gz";
  if (platform === "darwin" && arch === "x64") return "macos-x86_64-cpu.tar.gz";
  if (platform === "linux" && arch === "x64") return "linux-x86_64-cpu.tar.gz";
  if (platform === "linux" && arch === "arm64") return "linux-aarch64-cpu.tar.gz";
  return null;
}

/** whisper.cpp release archive for this platform, or null (no macOS build is published). */
export function whisperAssetName(platform = process.platform, arch = process.arch): string | null {
  if (platform === "linux" && arch === "x64") return "whisper-bin-ubuntu-x64.tar.gz";
  if (platform === "linux" && arch === "arm64") return "whisper-bin-ubuntu-arm64.tar.gz";
  return null;
}

export function engineEndpointPath(engine: SpeechEngineId): string {
  return engine === "nemo" ? "/v1/audio/transcriptions" : "/inference";
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

export class SpeechEngineManager {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private runningModelId: string | null = null;
  private runningEngine: SpeechEngineId | null = null;
  /** `<model id>|speakers|plain` of the live server, to spot a config change. */
  private runningKey: string | null = null;
  private starting: Promise<void> | null = null;
  private download: DownloadProgress | null = null;
  private lastError: string | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly rootDir: string;
  private readonly vendorWhisperDir: string;
  private readonly nemoReleasesUrl: string;
  private readonly whisperReleasesUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly which: (name: string) => string | null;
  // Ref-count of active recording owners (e.g. "web:<id>", "connect:<id>").
  // The engine is one shared server; it starts on the first owner and stops
  // only when the last one releases, so one client stopping cannot kill the
  // transcriber out from under another concurrent recorder.
  private recordingOwners = new Set<string>();

  constructor(options: SpeechEngineOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? (Number(process.env.WHISPER_PORT) || DEFAULT_PORT);
    this.rootDir = options.rootDir ?? join(getDataDir(), "speech");
    this.vendorWhisperDir = options.vendorWhisperDir ?? VENDOR_WHISPER_DIR;
    this.nemoReleasesUrl = options.nemoReleasesUrl ?? NEMO_RELEASES_URL;
    this.whisperReleasesUrl = options.whisperReleasesUrl ?? WHISPER_RELEASES_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.which = options.which ?? ((name) => Bun.which(name));
    process.on("exit", () => this.kill());
  }

  // ── paths ──────────────────────────────────────────────

  private modelsDir(): string {
    return join(this.rootDir, "models");
  }

  private binaryRecordPath(engine: SpeechEngineId): string {
    return join(this.rootDir, `${engine}.json`);
  }

  private readBinaryRecord(engine: SpeechEngineId): BinaryRecord | null {
    try {
      const rec = JSON.parse(readFileSync(this.binaryRecordPath(engine), "utf8")) as BinaryRecord;
      if (rec && typeof rec.path === "string" && existsSync(rec.path)) return rec;
    } catch {
      /* not installed */
    }
    return null;
  }

  /** Engine binary: managed install, then (whisper) the dev build, then PATH. */
  resolveBinary(engine: SpeechEngineId): string | null {
    const rec = this.readBinaryRecord(engine);
    if (rec) return rec.path;
    if (engine === "whisper") {
      for (const p of [join(this.vendorWhisperDir, "build/bin/whisper-server"), join(this.vendorWhisperDir, "build/bin/server")]) {
        if (existsSync(p)) return p;
      }
      return this.which("whisper-server");
    }
    return this.which("nemo-speech");
  }

  binaryInstallable(engine: SpeechEngineId): boolean {
    return engine === "nemo" ? nemoAssetSuffix() !== null : whisperAssetName() !== null;
  }

  private binaryHint(engine: SpeechEngineId): string | null {
    if (this.binaryInstallable(engine)) return null;
    if (engine === "whisper") {
      return process.platform === "darwin"
        ? "whisper.cpp publishes no macOS binary. Install it with `brew install whisper-cpp`, or build it with `bash scripts/setup-whisper.sh`."
        : `No prebuilt whisper.cpp binary for ${process.platform}/${process.arch}. Put whisper-server on PATH.`;
    }
    return `No prebuilt NeMo-Speech.cpp binary for ${process.platform}/${process.arch}. Put nemo-speech on PATH.`;
  }

  /** Where a model file lives: the managed download, or (Whisper) a vendored copy. */
  modelPath(model: SpeechModelFile): string {
    const managed = join(this.modelsDir(), model.file);
    if (existsSync(managed)) return managed;
    const vendored = join(this.vendorWhisperDir, "models", model.file);
    if (existsSync(vendored)) return vendored;
    return managed;
  }

  isModelInstalled(model: SpeechModelFile): boolean {
    return existsSync(this.modelPath(model));
  }

  /** The copy Skipper downloaded itself (never a vendored dev file). */
  private managedModelPath(model: SpeechModelFile): string {
    return join(this.modelsDir(), model.file);
  }

  /**
   * Delete a downloaded model to free disk space. Refuses while the live (or
   * starting) engine uses it, and never touches a vendored dev copy. Returns the
   * bytes freed.
   */
  deleteModel(model: SpeechModelFile): number {
    const path = this.managedModelPath(model);
    if (!existsSync(path)) throw new Error(`${model.label} is not downloaded`);
    if (this.download?.what === model.label) throw new Error(`${model.label} is still downloading`);
    const inUse = model.id === SPEAKER_MODEL.id
      ? !!this.runningKey?.endsWith("|speakers")
      : this.runningModelId === model.id;
    // runningModelId / runningKey are set as soon as a start spawns, so a start
    // in flight counts as in use too.
    if (inUse) {
      throw new Error(`${model.label} is in use by the running speech server. Stop the recording first.`);
    }
    const bytes = statSync(path).size;
    rmSync(path, { force: true });
    this.lastError = null;
    return bytes;
  }

  // ── status ─────────────────────────────────────────────

  /** Healthy and serving. False while a start is still waiting on /health. */
  isRunning(): boolean {
    return this.proc !== null && this.starting === null;
  }

  isStarting(): boolean {
    return this.starting !== null;
  }

  isDownloading(): boolean {
    return this.download !== null;
  }

  /** Surface a refused operator action (e.g. delete of an in-use model) in the status block. */
  noteError(message: string): void {
    this.lastError = message;
  }

  getRunningModelId(): string | null {
    return this.runningModelId;
  }

  getEndpoint(engine: SpeechEngineId | null = this.runningEngine): string {
    return `http://${this.host}:${this.port}${engineEndpointPath(engine ?? "whisper")}`;
  }

  /**
   * The live realtime socket to stream a recording into, or null when the
   * running engine is not NeMo with a streaming model (then chunks go through
   * the per-chunk HTTP endpoint as before).
   */
  getStreamTarget(): StreamTarget | null {
    if (!this.isRunning() || this.runningEngine !== "nemo") return null;
    if (!findSpeechModel(this.runningModelId)?.streaming) return null;
    return {
      url: `ws://${this.host}:${this.port}/v1/realtime`,
      speakerLabels: !!this.runningKey?.endsWith("|speakers"),
    };
  }

  getStatus(db?: Database): SpeechEngineStatus {
    const config = getRealtimeConfig(db);
    const model = resolveSpeechModel(config.local_model);
    const binaryPath = this.resolveBinary(model.engine);
    return {
      modelId: model.id,
      engine: model.engine,
      binaryInstalled: binaryPath !== null,
      binaryPath,
      binaryInstallable: this.binaryInstallable(model.engine),
      binaryHint: binaryPath ? null : this.binaryHint(model.engine),
      modelInstalled: this.isModelInstalled(model),
      speakersWanted: config.speaker_labels && model.speakers,
      speakerModelInstalled: this.isModelInstalled(SPEAKER_MODEL),
      running: this.isRunning(),
      starting: this.isStarting(),
      runningModelId: this.runningModelId,
      endpoint: this.isRunning() ? this.getEndpoint() : null,
      download: this.download,
      lastError: this.lastError,
      installedIds: [...SPEECH_MODELS, SPEAKER_MODEL].filter((m) => this.isModelInstalled(m)).map((m) => m.id),
      managedModels: [...SPEECH_MODELS, SPEAKER_MODEL]
        .filter((m) => existsSync(this.managedModelPath(m)))
        .map((m) => ({ id: m.id, label: m.label, bytes: statSync(this.managedModelPath(m)).size })),
    };
  }

  // ── install ────────────────────────────────────────────

  /**
   * Download everything the configured model needs that is missing: the engine
   * binary (when Skipper can install it), the model, and the speaker model when
   * speaker labels are on. Throws on the first failure (also kept as lastError).
   */
  async installForConfig(db?: Database): Promise<void> {
    const config = getRealtimeConfig(db);
    const model = resolveSpeechModel(config.local_model);
    const binaryMissing = !this.resolveBinary(model.engine);
    if (binaryMissing && this.binaryInstallable(model.engine)) await this.installBinary(model.engine);
    if (!this.isModelInstalled(model)) await this.installModel(model);
    if (config.speaker_labels && model.speakers && !this.isModelInstalled(SPEAKER_MODEL)) {
      await this.installModel(SPEAKER_MODEL);
    }
    // The models are in place; the binary is the operator's to install here.
    if (binaryMissing && !this.binaryInstallable(model.engine)) {
      const hint = this.binaryHint(model.engine)!;
      this.lastError = hint;
      throw new Error(hint);
    }
  }

  /** Download + unpack the engine binary from its GitHub releases into `<root>/bin/<engine>/<tag>`. */
  async installBinary(engine: SpeechEngineId): Promise<BinaryRecord> {
    if (this.download) throw new Error(`A download is already in progress (${this.download.what})`);
    const binaryName = engine === "nemo" ? "nemo-speech" : "whisper-server";
    const releasesUrl = engine === "nemo" ? this.nemoReleasesUrl : this.whisperReleasesUrl;
    const matches = engine === "nemo"
      ? (() => { const suffix = nemoAssetSuffix(); return suffix ? (name: string) => name.startsWith("nemo-speech-") && name.endsWith(suffix) : null; })()
      : (() => { const asset = whisperAssetName(); return asset ? (name: string) => name === asset : null; })();
    if (!matches) throw new Error(this.binaryHint(engine) ?? `No ${binaryName} binary for this platform`);

    this.lastError = null;
    this.download = { what: `${binaryName} release list`, received: 0, total: null };
    try {
      const res = await this.fetchImpl(releasesUrl, { headers: { Accept: "application/vnd.github+json", "User-Agent": "skipper" } });
      if (!res.ok) throw new Error(`GitHub releases request failed: ${res.status} ${res.statusText}`);
      const releases = await res.json() as Release[];
      let tag: string | null = null;
      let asset: ReleaseAsset | null = null;
      let checksumUrl: string | null = null;
      for (const rel of releases) {
        // NeMo prereleases stay opt-in; whisper.cpp's per-build `b<N>` tags carry the binaries.
        if (!rel.tag_name || rel.draft || (engine === "nemo" && rel.prerelease)) continue;
        const hit = (rel.assets ?? []).find((a) => typeof a.name === "string" && matches(a.name));
        if (hit?.browser_download_url) {
          tag = rel.tag_name;
          asset = hit;
          checksumUrl = (rel.assets ?? []).find((a) => a.name === `${hit.name}.sha256`)?.browser_download_url ?? null;
          break;
        }
      }
      if (!tag || !asset?.browser_download_url) throw new Error(`No ${binaryName} release asset found for ${process.platform}/${process.arch}`);

      let expectedSha: string | null = null;
      if (checksumUrl) {
        const sumRes = await this.fetchImpl(checksumUrl, { redirect: "follow", headers: { "User-Agent": "skipper" } });
        if (!sumRes.ok) throw new Error(`Checksum download failed: ${sumRes.status} ${sumRes.statusText}`);
        expectedSha = (await sumRes.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? null;
      }

      const installDir = join(this.rootDir, "bin", engine, tag);
      const tgz = join(this.rootDir, `${engine}-${tag}.tar.gz.part`);
      mkdirSync(this.rootDir, { recursive: true });
      this.download = { what: `${binaryName} ${tag}`, received: 0, total: typeof asset.size === "number" ? asset.size : null };
      const sha = await this.downloadTo(asset.browser_download_url, tgz);
      if (expectedSha && sha !== expectedSha) {
        rmSync(tgz, { force: true });
        throw new Error(`${binaryName} checksum mismatch: got ${sha}, expected ${expectedSha}`);
      }

      rmSync(installDir, { recursive: true, force: true });
      mkdirSync(installDir, { recursive: true });
      const tar = Bun.spawn({ cmd: ["tar", "-xzf", tgz, "-C", installDir], stdout: "ignore", stderr: "pipe" });
      const stderr = await new Response(tar.stderr).text();
      const code = await tar.exited;
      rmSync(tgz, { force: true });
      if (code !== 0) throw new Error(`tar failed (${code}): ${stderr.trim().slice(0, 300)}`);

      const binPath = findFileNamed(installDir, binaryName);
      if (!binPath) throw new Error(`${binaryName} not found inside the ${tag} archive`);
      try { chmodSync(binPath, 0o755); } catch { /* already executable */ }

      // Replace the previous build only after the new one is fully in place.
      const previous = this.readBinaryRecord(engine);
      const record: BinaryRecord = { tag, path: binPath };
      writeFileSync(this.binaryRecordPath(engine), JSON.stringify(record, null, 2));
      if (previous && previous.tag !== tag) {
        rmSync(join(this.rootDir, "bin", engine, previous.tag), { recursive: true, force: true });
      }
      return record;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.download = null;
    }
  }

  async installModel(model: SpeechModelFile): Promise<string> {
    if (this.download) throw new Error(`A download is already in progress (${this.download.what})`);
    if (this.isModelInstalled(model)) return this.modelPath(model);
    const dest = this.managedModelPath(model);

    this.lastError = null;
    this.download = { what: model.label, received: 0, total: model.bytes };
    try {
      mkdirSync(this.modelsDir(), { recursive: true });
      const part = `${dest}.part`;
      const sha = await this.downloadTo(model.url, part);
      const size = statSync(part).size;
      if (size !== model.bytes) {
        rmSync(part, { force: true });
        throw new Error(`${model.label} download size mismatch: got ${size} bytes, expected ${model.bytes}`);
      }
      if (sha !== model.sha256) {
        rmSync(part, { force: true });
        throw new Error(`${model.label} checksum mismatch: got ${sha}, expected ${model.sha256}`);
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

  /** Stream a URL to disk, tracking progress; returns the SHA-256 (hex) of the bytes written. */
  private async downloadTo(url: string, dest: string): Promise<string> {
    const res = await this.fetchImpl(url, { redirect: "follow", headers: { "User-Agent": "skipper" } });
    if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText} (${url})`);
    const lengthHeader = res.headers.get("content-length");
    if (this.download && lengthHeader && this.download.total === null) this.download.total = Number(lengthHeader);
    rmSync(dest, { force: true });
    const hasher = new Bun.CryptoHasher("sha256");
    const writer = Bun.file(dest).writer();
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        writer.write(value);
        hasher.update(value);
        if (this.download) this.download.received += value.byteLength;
      }
      await writer.end();
    } catch (err) {
      try { await writer.end(); } catch { /* ignore */ }
      rmSync(dest, { force: true });
      throw err;
    }
    return hasher.digest("hex");
  }

  // ── run ────────────────────────────────────────────────

  /** Ref-counted start: the engine starts on the first owner and stays up while any owner holds it. */
  async acquire(ownerKey: string, db?: Database): Promise<void> {
    this.recordingOwners.add(ownerKey);
    await this.ensureRunning(db);
  }

  /** Ref-counted stop: the engine stops only when the last owner releases. */
  release(ownerKey: string, db?: Database): void {
    this.recordingOwners.delete(ownerKey);
    if (this.recordingOwners.size === 0) this.stop(db);
  }

  /**
   * Start the configured model's engine, or restart it when the configured
   * model or speaker setting changed. Concurrent callers share one start.
   */
  async ensureRunning(db?: Database): Promise<void> {
    if (this.starting) await this.starting;
    if (this.proc && this.runningKey === this.configKey(db)) return;
    const starting = this.start(db);
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  /**
   * The configured local model's label when an acquire would first have to
   * start (or restart) the engine, which takes seconds; null when it is
   * already serving that model or transcription is not local.
   */
  pendingStartLabel(db?: Database): string | null {
    const config = getRealtimeConfig(db);
    if (config.transcription_provider !== "local") return null;
    if (this.isRunning() && this.runningKey === this.configKey(db)) return null;
    return resolveSpeechModel(config.local_model).label;
  }

  /** After a config change: restart a live engine onto the new model / speaker setting. */
  async restartIfRunning(db?: Database): Promise<void> {
    if (!this.proc && !this.starting) return;
    await this.ensureRunning(db);
  }

  private configKey(db?: Database): string {
    const config = getRealtimeConfig(db);
    const model = resolveSpeechModel(config.local_model);
    return `${model.id}|${config.speaker_labels && model.speakers ? "speakers" : "plain"}`;
  }

  /** Spawn + wait for /health. Prefer `ensureRunning` / `acquire`, which track the starting state. */
  async start(db?: Database): Promise<void> {
    const config = getRealtimeConfig(db);
    const model = resolveSpeechModel(config.local_model);
    const withSpeakers = config.speaker_labels && model.speakers;
    const cmd = this.buildCommand(model, withSpeakers);

    if (this.proc) this.stop(db);
    this.lastError = null;
    console.log(`[speech] starting ${model.engine} (${model.id}${withSpeakers ? ", speaker labels" : ""}) on ${this.host}:${this.port}`);

    const proc = Bun.spawn({
      cmd,
      stdout: "pipe",
      stderr: "pipe",
      // Keep any NeMo-side model fetch inside the managed dir.
      env: { ...process.env, NEMO_SPEECH_MODEL_DIR: this.modelsDir() },
    });
    this.proc = proc;
    this.runningModelId = model.id;
    this.runningEngine = model.engine;
    this.runningKey = `${model.id}|${withSpeakers ? "speakers" : "plain"}`;
    this.drain(proc.stdout);
    this.drain(proc.stderr);
    proc.exited.then((code) => {
      if (this.proc === proc) {
        console.error(`[speech] ${model.engine} server exited unexpectedly with code ${code}`);
        this.lastError = `${model.engine} server exited with code ${code}`;
        this.clearRunning();
      }
    });

    try {
      await this.waitForReady(proc);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.stop(db);
      throw err;
    }
    const endpoint = this.getEndpoint(model.engine);
    console.log(`[speech] ready at ${endpoint}`);
    updateRealtimeConfig({ transcription_endpoint: endpoint }, db);
  }

  /** The spawn command for a model; throws a user-facing error when something is missing. */
  buildCommand(model: SpeechModel, withSpeakers: boolean): string[] {
    const bin = this.resolveBinary(model.engine);
    if (!bin) {
      throw new Error(`${model.engine === "nemo" ? "NeMo-Speech.cpp" : "whisper.cpp"} is not installed. ${this.binaryInstallable(model.engine) ? "Download it from Config > Real-time transcription." : this.binaryHint(model.engine)}`);
    }
    if (!this.isModelInstalled(model)) {
      throw new Error(`Speech model ${model.label} is not downloaded. Download it from Config > Real-time transcription.`);
    }
    const modelFile = this.modelPath(model);
    if (model.engine === "whisper") {
      return [bin, "-m", modelFile, "--host", this.host, "--port", String(this.port), "--convert"];
    }
    const cmd = [bin, "serve", "--asr-model", modelFile, "--host", this.host, "--port", String(this.port), "--no-ui"];
    // A streaming model finalizes an utterance mid-stream only with endpointing
    // (off by default: every final would wait for the recording's commit).
    if (model.streaming) cmd.push("--endpointing");
    if (withSpeakers) {
      if (!this.isModelInstalled(SPEAKER_MODEL)) {
        throw new Error(`Speaker labels are on but ${SPEAKER_MODEL.label} is not downloaded. Download it from Config > Real-time transcription.`);
      }
      cmd.push("--asr.diar.model_path", this.modelPath(SPEAKER_MODEL));
    }
    return cmd;
  }

  stop(db?: Database): void {
    if (!this.proc) return;
    console.log("[speech] stopping speech server");
    this.kill();
    updateRealtimeConfig({ transcription_endpoint: "" }, db);
  }

  private kill(): void {
    const proc = this.proc;
    if (!proc) return;
    this.clearRunning();
    try { proc.kill(); } catch { /* already gone */ }
  }

  private clearRunning(): void {
    this.proc = null;
    this.runningModelId = null;
    this.runningEngine = null;
    this.runningKey = null;
  }

  private async waitForReady(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const started = Date.now();
    const url = `http://${this.host}:${this.port}/health`;
    while (Date.now() - started < READY_TIMEOUT_MS) {
      if (this.proc !== proc) throw new Error(this.lastError ?? "speech server exited during startup");
      try {
        const res = await fetch(url);
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
    }
    throw new Error(`speech server did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
  }

  private drain(stream: ReadableStream<Uint8Array> | null): void {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const read = (): void => {
      reader.read().then(({ done, value }) => {
        if (done) return;
        const text = decoder.decode(value, { stream: true }).trim();
        if (text) console.log(`[speech] ${text.slice(0, 200)}`);
        read();
      }).catch(() => { /* stream closed */ });
    };
    read();
  }
}

let shared: SpeechEngineManager | null = null;

/** The daemon's one speech engine (index.ts routes, recording lock, config routes). */
export function getSpeechEngine(): SpeechEngineManager {
  shared ??= new SpeechEngineManager();
  return shared;
}
