import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EmbeddingServerManager, llamaAssetSuffix } from "./local-server";
import { LOCAL_EMBEDDING_MODELS, DEFAULT_LOCAL_EMBEDDING_MODEL_ID, findLocalEmbeddingModel } from "./catalogue";

describe("llamaAssetSuffix", () => {
  it("maps the supported platforms and rejects the rest", () => {
    expect(llamaAssetSuffix("darwin", "arm64")).toBe("bin-macos-arm64.tar.gz");
    expect(llamaAssetSuffix("darwin", "x64")).toBe("bin-macos-x64.tar.gz");
    expect(llamaAssetSuffix("linux", "x64")).toBe("bin-ubuntu-x64.tar.gz");
    expect(llamaAssetSuffix("linux", "arm64")).toBe("bin-ubuntu-arm64.tar.gz");
    expect(llamaAssetSuffix("win32", "x64")).toBeNull();
  });
});

describe("catalogue", () => {
  it("has a default that exists and consistent entries", () => {
    expect(findLocalEmbeddingModel(DEFAULT_LOCAL_EMBEDDING_MODEL_ID)).not.toBeNull();
    for (const m of LOCAL_EMBEDDING_MODELS) {
      expect(m.url.startsWith("https://huggingface.co/")).toBe(true);
      expect(m.url.endsWith(m.file)).toBe(true);
      expect(m.docMaxChars).toBeLessThanOrEqual(m.ctx * 4);
    }
    expect(findLocalEmbeddingModel("nope")).toBeNull();
  });
});

describe("EmbeddingServerManager", () => {
  const dirs: string[] = [];
  const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), "skipper-embed-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("reports not installed on a fresh root and refuses to start", async () => {
    const mgr = new EmbeddingServerManager({ rootDir: scratch(), port: 18089 });
    const status = mgr.getStatus(DEFAULT_LOCAL_EMBEDDING_MODEL_ID);
    expect(status.binaryInstalled).toBe(false);
    expect(status.modelInstalled).toBe(false);
    expect(status.running).toBe(false);
    expect(status.starting).toBe(false);
    expect(status.endpoint).toBeNull();
    expect(mgr.getBaseUrl()).toBe("http://127.0.0.1:18089/v1");
    await expect(mgr.start(DEFAULT_LOCAL_EMBEDDING_MODEL_ID)).rejects.toThrow("not installed");
    await expect(mgr.start("nope")).rejects.toThrow("Unknown local embedding model");
    mgr.stop(); // no-op
  });

  it("requires the model file once the binary record exists", async () => {
    const root = scratch();
    const fakeServer = join(root, "bin", "b1", "llama-server");
    mkdirSync(join(root, "bin", "b1"), { recursive: true });
    writeFileSync(fakeServer, "#!/bin/sh\nexit 0\n");
    writeFileSync(join(root, "binary.json"), JSON.stringify({ tag: "b1", serverPath: fakeServer }));
    const mgr = new EmbeddingServerManager({ rootDir: root, port: 18090 });
    expect(mgr.isBinaryInstalled()).toBe(true);
    expect(mgr.getStatus(DEFAULT_LOCAL_EMBEDDING_MODEL_ID).binaryTag).toBe("b1");
    await expect(mgr.start(DEFAULT_LOCAL_EMBEDDING_MODEL_ID)).rejects.toThrow("not downloaded");
  });

  it("installBinary picks the newest b-tag carrying this platform's asset", async () => {
    const root = scratch();
    const suffix = llamaAssetSuffix();
    if (!suffix) return;
    // A real tar.gz containing a llama-server script, served by the fake fetch.
    const stage = join(root, "stage", "build", "bin");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "llama-server"), "#!/bin/sh\nexit 0\n");
    const tgz = join(root, "asset.tar.gz");
    const tar = Bun.spawn({ cmd: ["tar", "-czf", tgz, "-C", join(root, "stage"), "build"] });
    expect(await tar.exited).toBe(0);
    const tgzBytes = await Bun.file(tgz).arrayBuffer();

    const releases = [
      { tag_name: "v0.4.0", assets: [{ name: "nightly-tag.txt", browser_download_url: "https://x/nightly" }] },
      { tag_name: "b777", assets: [{ name: `llama-b777-${suffix}`, browser_download_url: "https://x/b777", size: tgzBytes.byteLength }] },
      { tag_name: "b700", assets: [{ name: `llama-b700-${suffix}`, browser_download_url: "https://x/b700" }] },
    ];
    const fetched: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      fetched.push(u);
      if (u.includes("releases")) return new Response(JSON.stringify(releases), { status: 200 });
      if (u === "https://x/b777") return new Response(tgzBytes, { status: 200, headers: { "content-length": String(tgzBytes.byteLength) } });
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;

    const mgr = new EmbeddingServerManager({ rootDir: root, port: 18091, releasesUrl: "https://x/releases", fetchImpl });
    const rec = await mgr.installBinary();
    expect(rec.tag).toBe("b777");
    expect(rec.serverPath.endsWith("llama-server")).toBe(true);
    expect(mgr.isBinaryInstalled()).toBe(true);
    expect(fetched).toEqual(["https://x/releases", "https://x/b777"]);
    expect(mgr.getStatus(DEFAULT_LOCAL_EMBEDDING_MODEL_ID).download).toBeNull();
  });

  it("installModel verifies the byte count and leaves nothing behind on mismatch", async () => {
    const root = scratch();
    const fetchImpl = (async () => new Response(new Uint8Array(10), { status: 200 })) as unknown as typeof fetch;
    const mgr = new EmbeddingServerManager({ rootDir: root, port: 18092, fetchImpl });
    await expect(mgr.installModel(DEFAULT_LOCAL_EMBEDDING_MODEL_ID)).rejects.toThrow("size mismatch");
    expect(mgr.isModelInstalled(DEFAULT_LOCAL_EMBEDDING_MODEL_ID)).toBe(false);
    expect(mgr.getStatus(DEFAULT_LOCAL_EMBEDDING_MODEL_ID).lastError).toContain("size mismatch");
  });
});

describe("embedResilient (via a stub endpoint)", () => {
  it("shrinks a value the endpoint reports as too large and keeps the rest", async () => {
    const { resolveEmbedder, isEmbedder } = await import("./embeddings");
    const { Database } = await import("bun:sqlite");
    const { initializeDatabase } = await import("../db/connection");
    const { saveTaskMemoryConfig } = await import("./settings");
    const seen: number[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.json() as { input: string[] | string };
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        for (const t of inputs) {
          seen.push(t.length);
          if (t.length > 100) return Response.json({ error: { code: 500, message: "input (702 tokens) is too large to process" } }, { status: 500 });
        }
        return Response.json({ object: "list", data: inputs.map((_, i) => ({ object: "embedding", index: i, embedding: [1, 0] })), model: "stub", usage: { prompt_tokens: 1, total_tokens: 1 } });
      },
    });
    try {
      const db = new Database(":memory:");
      initializeDatabase(db);
      saveTaskMemoryConfig(db, { endpoint: "custom", customBaseUrl: `http://127.0.0.1:${server.port}/v1`, customModel: "stub" });
      const embedder = resolveEmbedder(db, { isBinaryInstalled: () => false } as never);
      expect(isEmbedder(embedder)).toBe(true);
      if (!isEmbedder(embedder)) return;
      const vecs = await embedder.embedDocuments(["short", "y".repeat(300)]);
      expect(vecs.length).toBe(2);
      expect(vecs[1]![0]).toBeCloseTo(1, 5);
      // batch rejected, then "short" alone, then 300 -> 150 -> 75 for the long one
      expect(Math.min(...seen)).toBeLessThanOrEqual(100);
      db.close();
    } finally {
      server.stop(true);
    }
  }, 15_000);
});
