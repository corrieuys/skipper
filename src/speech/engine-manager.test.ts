import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initializeDatabase } from "../db/connection";
import { getRealtimeConfig, updateRealtimeConfig } from "../realtime/config";
import { findSpeechModel, SPEAKER_MODEL, type SpeechModelFile } from "./catalogue";
import { nemoAssetSuffix, SpeechEngineManager, whisperAssetName } from "./engine-manager";

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "skipper-speech-"));
  db = new Database(":memory:");
  initializeDatabase(db);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function manager(extra: Partial<ConstructorParameters<typeof SpeechEngineManager>[0]> = {}): SpeechEngineManager {
  return new SpeechEngineManager({
    rootDir: join(tmp, "speech"),
    vendorWhisperDir: join(tmp, "vendor"),
    which: () => null,
    port: 18000 + Math.floor(Math.random() * 2000),
    ...extra,
  });
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** A fake engine: serves /health and records its argv, so the lifecycle runs for real. */
function fakeEngine(name: string): { bin: string; argsFile: string } {
  const argsFile = join(tmp, `${name}.args`);
  const server = join(tmp, `${name}-server.ts`);
  writeFileSync(server, `
    const args = process.argv.slice(2);
    await Bun.write(${JSON.stringify(argsFile)}, JSON.stringify(args));
    const port = Number(args[args.indexOf("--port") + 1]);
    Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  `);
  const bin = join(tmp, name);
  writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${server} "$@"\n`);
  chmodSync(bin, 0o755);
  return { bin, argsFile };
}

describe("platform assets", () => {
  it("maps each platform to its release archive", () => {
    expect(nemoAssetSuffix("darwin", "arm64")).toBe("macos-aarch64-metal.tar.gz");
    expect(nemoAssetSuffix("linux", "x64")).toBe("linux-x86_64-cpu.tar.gz");
    expect(nemoAssetSuffix("win32", "x64")).toBeNull();
    expect(whisperAssetName("linux", "arm64")).toBe("whisper-bin-ubuntu-arm64.tar.gz");
    // whisper.cpp publishes no macOS binary.
    expect(whisperAssetName("darwin", "arm64")).toBeNull();
  });
});

describe("binary + model resolution", () => {
  it("finds the whisper dev build, then PATH", () => {
    const onPath = manager({ which: (n) => (n === "whisper-server" ? "/usr/local/bin/whisper-server" : null) });
    expect(onPath.resolveBinary("whisper")).toBe("/usr/local/bin/whisper-server");

    mkdirSync(join(tmp, "vendor/build/bin"), { recursive: true });
    writeFileSync(join(tmp, "vendor/build/bin/whisper-server"), "");
    expect(onPath.resolveBinary("whisper")).toBe(join(tmp, "vendor/build/bin/whisper-server"));
    expect(manager().resolveBinary("nemo")).toBeNull();
  });

  it("uses a vendored Whisper model without downloading it", () => {
    const mgr = manager();
    const model = findSpeechModel("whisper-base.en")!;
    expect(mgr.isModelInstalled(model)).toBe(false);
    mkdirSync(join(tmp, "vendor/models"), { recursive: true });
    writeFileSync(join(tmp, "vendor/models/ggml-base.en.bin"), "x");
    expect(mgr.isModelInstalled(model)).toBe(true);
    expect(mgr.modelPath(model)).toBe(join(tmp, "vendor/models/ggml-base.en.bin"));
  });

  it("builds the whisper and NeMo commands, with the diarizer only when asked", () => {
    const mgr = manager({ which: (n) => `/bin/${n}` });
    mkdirSync(join(tmp, "speech/models"), { recursive: true });
    const whisper = findSpeechModel("whisper-base.en")!;
    const nemo = findSpeechModel("nemotron-3.5")!;
    writeFileSync(join(tmp, "speech/models", whisper.file), "x");
    writeFileSync(join(tmp, "speech/models", nemo.file), "x");

    expect(mgr.buildCommand(whisper, false)).toEqual([
      "/bin/whisper-server", "-m", join(tmp, "speech/models", whisper.file), "--host", "127.0.0.1", "--port", expect.any(String), "--convert",
    ]);
    const plain = mgr.buildCommand(nemo, false);
    expect(plain.slice(0, 4)).toEqual(["/bin/nemo-speech", "serve", "--asr-model", join(tmp, "speech/models", nemo.file)]);
    expect(plain).not.toContain("--asr.diar.model_path");
    // Streaming models finalize utterances mid-stream only with endpointing on.
    expect(plain).toContain("--endpointing");
    const parakeet = findSpeechModel("parakeet-tdt-v3")!;
    writeFileSync(join(tmp, "speech/models", parakeet.file), "x");
    expect(mgr.buildCommand(parakeet, false)).not.toContain("--endpointing");

    expect(() => mgr.buildCommand(nemo, true)).toThrow("Sortformer");
    writeFileSync(join(tmp, "speech/models", SPEAKER_MODEL.file), "x");
    const withSpeakers = mgr.buildCommand(nemo, true);
    expect(withSpeakers.slice(-2)).toEqual(["--asr.diar.model_path", join(tmp, "speech/models", SPEAKER_MODEL.file)]);
  });

  it("explains a missing binary and a missing model", () => {
    const mgr = manager();
    const nemo = findSpeechModel("nemotron-en")!;
    expect(() => mgr.buildCommand(nemo, false)).toThrow("NeMo-Speech.cpp is not installed");
    const withBin = manager({ which: (n) => `/bin/${n}` });
    expect(() => withBin.buildCommand(nemo, false)).toThrow("is not downloaded");
  });

  it("reports the configured model in the status", () => {
    const mgr = manager();
    updateRealtimeConfig({ local_model: "nemotron-3.5", speaker_labels: true }, db);
    const status = mgr.getStatus(db);
    expect(status.modelId).toBe("nemotron-3.5");
    expect(status.engine).toBe("nemo");
    expect(status.binaryInstalled).toBe(false);
    expect(status.modelInstalled).toBe(false);
    expect(status.speakersWanted).toBe(true);
    expect(status.running).toBe(false);

    updateRealtimeConfig({ local_model: "whisper-small.en" }, db);
    expect(mgr.getStatus(db).speakersWanted).toBe(false);
  });
});

describe("downloads", () => {
  const bytes = new TextEncoder().encode("fake model bytes");
  const testModel: SpeechModelFile = {
    id: "test-model",
    label: "Test model",
    file: "test-model.bin",
    url: "https://example.test/test-model.bin",
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    license: "MIT",
  };
  const serve = (body: Uint8Array) => (async () => new Response(body, { headers: { "content-length": String(body.byteLength) } })) as unknown as typeof fetch;

  it("downloads a model after checking its size and checksum", async () => {
    const mgr = manager({ fetchImpl: serve(bytes) });
    const path = await mgr.installModel(testModel);
    expect(path).toBe(join(tmp, "speech/models/test-model.bin"));
    expect(readFileSync(path, "utf8")).toBe("fake model bytes");
    expect(mgr.isDownloading()).toBe(false);
  });

  it("rejects a model whose checksum does not match and keeps nothing", async () => {
    const wrong = new TextEncoder().encode("fake model byteZ");
    const mgr = manager({ fetchImpl: serve(wrong) });
    await expect(mgr.installModel(testModel)).rejects.toThrow("checksum mismatch");
    expect(existsSync(join(tmp, "speech/models/test-model.bin"))).toBe(false);
    expect(existsSync(join(tmp, "speech/models/test-model.bin.part"))).toBe(false);
    expect(mgr.getStatus(db).lastError).toContain("checksum mismatch");
  });

  it("installs the NeMo binary from the release matching this platform, checksum verified", async () => {
    const suffix = nemoAssetSuffix();
    if (!suffix) return; // no NeMo build for this test host
    // Build a release archive shaped like the real one: nemo-speech/bin/nemo-speech.
    const pkg = join(tmp, "pkg");
    mkdirSync(join(pkg, "nemo-speech/bin"), { recursive: true });
    writeFileSync(join(pkg, "nemo-speech/bin/nemo-speech"), "#!/bin/sh\n");
    const tgz = join(tmp, "nemo.tgz");
    await Bun.spawn({ cmd: ["tar", "-czf", tgz, "-C", pkg, "nemo-speech"] }).exited;
    const archive = new Uint8Array(await Bun.file(tgz).arrayBuffer());
    const assetName = `nemo-speech-0.2.0-${suffix}`;

    const releases = [
      { tag_name: "v0.3.0-rc.1", prerelease: true, assets: [{ name: `nemo-speech-0.3.0-rc.1-${suffix}`, browser_download_url: "https://example.test/rc" }] },
      { tag_name: "v0.2.0", assets: [
        { name: assetName, browser_download_url: "https://example.test/archive", size: archive.byteLength },
        { name: `${assetName}.sha256`, browser_download_url: "https://example.test/sum" },
      ] },
    ];
    const requested: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      requested.push(u);
      if (u.startsWith("https://api.github.com")) return Response.json(releases);
      if (u === "https://example.test/sum") return new Response(`${sha256(archive)}  ${assetName}\n`);
      if (u === "https://example.test/archive") return new Response(archive);
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const mgr = manager({ fetchImpl });
    const rec = await mgr.installBinary("nemo");
    expect(rec.tag).toBe("v0.2.0");
    expect(rec.path).toBe(join(tmp, "speech/bin/nemo/v0.2.0/nemo-speech/bin/nemo-speech"));
    expect(mgr.resolveBinary("nemo")).toBe(rec.path);
    expect(requested).not.toContain("https://example.test/rc");
  });
});

describe("delete", () => {
  it("deletes a downloaded model and lists what is on disk", () => {
    const mgr = manager();
    const model = findSpeechModel("whisper-small.en")!;
    mkdirSync(join(tmp, "speech/models"), { recursive: true });
    writeFileSync(join(tmp, "speech/models", model.file), "12345");
    const before = mgr.getStatus(db);
    expect(before.managedModels).toEqual([{ id: model.id, label: model.label, bytes: 5 }]);
    expect(before.installedIds).toContain(model.id);

    expect(mgr.deleteModel(model)).toBe(5);
    expect(existsSync(join(tmp, "speech/models", model.file))).toBe(false);
    expect(mgr.getStatus(db).managedModels).toEqual([]);
    expect(() => mgr.deleteModel(model)).toThrow("is not downloaded");
  });

  it("never deletes a vendored dev copy", () => {
    const mgr = manager();
    const model = findSpeechModel("whisper-base.en")!;
    mkdirSync(join(tmp, "vendor/models"), { recursive: true });
    writeFileSync(join(tmp, "vendor/models", model.file), "x");
    expect(mgr.getStatus(db).installedIds).toContain(model.id);
    expect(mgr.getStatus(db).managedModels).toEqual([]);
    expect(() => mgr.deleteModel(model)).toThrow("is not downloaded");
    expect(existsSync(join(tmp, "vendor/models", model.file))).toBe(true);
  });

  it("refuses to delete the model the running engine uses", async () => {
    const whisper = fakeEngine("whisper-server");
    const mgr = manager({ which: (n) => (n === "whisper-server" ? whisper.bin : null) });
    const model = findSpeechModel("whisper-base.en")!;
    mkdirSync(join(tmp, "speech/models"), { recursive: true });
    writeFileSync(join(tmp, "speech/models", model.file), "x");
    await mgr.acquire("web:a", db);
    try {
      expect(() => mgr.deleteModel(model)).toThrow("in use");
      expect(existsSync(join(tmp, "speech/models", model.file))).toBe(true);
    } finally {
      mgr.release("web:a", db);
    }
    expect(mgr.deleteModel(model)).toBe(1);
  });
});

describe("lifecycle", () => {
  /** Place a (fake) downloaded model file where the manager looks for it. */
  function install(modelId: string): void {
    const model = findSpeechModel(modelId)!;
    mkdirSync(join(tmp, "speech/models"), { recursive: true });
    writeFileSync(join(tmp, "speech/models", model.file), "x");
  }

  it("starts on the first owner, writes the endpoint, and stops on the last release", async () => {
    const whisper = fakeEngine("whisper-server");
    const mgr = manager({ which: (n) => (n === "whisper-server" ? whisper.bin : null) });
    install("whisper-base.en");

    await mgr.acquire("web:a", db);
    await mgr.acquire("connect:b", db);
    expect(mgr.isRunning()).toBe(true);
    expect(getRealtimeConfig(db).transcription_endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/inference$/);

    mgr.release("web:a", db);
    expect(mgr.isRunning()).toBe(true);
    mgr.release("connect:b", db);
    expect(mgr.isRunning()).toBe(false);
    expect(getRealtimeConfig(db).transcription_endpoint).toBe("");
  });

  it("restarts onto the NeMo engine when the model changes", async () => {
    const whisper = fakeEngine("whisper-server");
    const nemo = fakeEngine("nemo-speech");
    const mgr = manager({ which: (n) => (n === "whisper-server" ? whisper.bin : n === "nemo-speech" ? nemo.bin : null) });
    install("whisper-base.en");
    install("nemotron-en");

    await mgr.acquire("web:a", db);
    expect(mgr.getRunningModelId()).toBe("whisper-base.en");

    updateRealtimeConfig({ local_model: "nemotron-en" }, db);
    await mgr.restartIfRunning(db);
    expect(mgr.isRunning()).toBe(true);
    expect(mgr.getRunningModelId()).toBe("nemotron-en");
    expect(getRealtimeConfig(db).transcription_endpoint).toMatch(/\/v1\/audio\/transcriptions$/);
    const args = JSON.parse(readFileSync(nemo.argsFile, "utf8")) as string[];
    expect(args[0]).toBe("serve");
    expect(args).toContain("--no-ui");

    mgr.release("web:a", db);
    expect(mgr.isRunning()).toBe(false);
  });

  it("names the model an acquire would have to load, and nothing once it runs", async () => {
    const whisper = fakeEngine("whisper-server");
    const mgr = manager({ which: (n) => (n === "whisper-server" ? whisper.bin : null) });
    install("whisper-base.en");
    install("whisper-small.en");
    expect(mgr.pendingStartLabel(db)).toBe("Whisper base.en");
    await mgr.acquire("web:a", db);
    expect(mgr.pendingStartLabel(db)).toBeNull();
    // A different configured model means a restart, which also loads.
    updateRealtimeConfig({ local_model: "whisper-small.en" }, db);
    expect(mgr.pendingStartLabel(db)).toBe("Whisper small.en");
    // OpenAI transcription loads nothing locally.
    updateRealtimeConfig({ transcription_provider: "openai" }, db);
    expect(mgr.pendingStartLabel(db)).toBeNull();
    mgr.release("web:a", db);
  });

  it("does not start anything on restartIfRunning when stopped", async () => {
    const mgr = manager();
    await mgr.restartIfRunning(db);
    expect(mgr.isRunning()).toBe(false);
  });
});
