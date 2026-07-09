import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { startServer } from "../server";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { registerApiKeyRoutes } from "./api-keys";
import { resolveApiKey, hashApiKey } from "../mcp/auth";

let server: Server<unknown>;
let baseUrl: string;

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);
  registerApiKeyRoutes();
  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  resetDb();
});

describe("resolveApiKey", () => {
  it("resolves a stored key by hash and rejects unknown/short tokens", () => {
    const db = getDb();
    const key = `sk-${crypto.randomUUID().replace(/-/g, "")}`;
    db.prepare("INSERT INTO api_keys (id, name, key_hash) VALUES ('k1', 'resolver', ?)")
      .run(hashApiKey(key));

    expect(resolveApiKey(db, key)?.name).toBe("resolver");
    expect(resolveApiKey(db, "sk-unknown-key-12345")).toBeNull();
    expect(resolveApiKey(db, "short")).toBeNull();
  });
});

describe("POST /api/api-keys", () => {
  it("returns the plaintext key as JSON for API callers", async () => {
    const res = await fetch(`${baseUrl}/api/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "json-key" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; key: string };
    expect(body.name).toBe("json-key");
    expect(body.key.startsWith("sk-")).toBe(true);
    // Stored hashed, resolvable
    expect(resolveApiKey(getDb(), body.key)?.name).toBe("json-key");
  });

  it("returns the panel HTML with the one-time key for htmx form posts", async () => {
    const form = new URLSearchParams({ name: "htmx-key" });
    const res = await fetch(`${baseUrl}/api/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "HX-Request": "true" },
      body: form.toString(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("sk-api-keys-panel");
    expect(html).toContain("htmx-key");
    // Plaintext key revealed exactly once in the banner
    expect(html).toMatch(/sk-[a-f0-9]{32}/);
  });
});

describe("configPage API keys section", () => {
  it("renders the panel only under --experimental", async () => {
    const { configPage } = await import("../html/pages/config.page");
    const vm = {
      teams: [],
      notificationPreferences: [],
      logRetentionHours: 24,
      daemonState: "running",
      daemonUptime: 0,
      escalationCount: 0,
      skipperConnectHasKey: false,
      skipperConnectUrl: "",
      apiKeys: [{ id: "k", name: "visible-key", created_at: "2026-07-09" }],
      modelSettings: { skipper: {}, chat: {}, greg: {}, options: [] },
    } as never;

    expect(configPage(vm)).not.toContain("sk-api-keys-panel");

    process.argv.push("--experimental");
    try {
      const html = configPage(vm);
      expect(html).toContain("sk-api-keys-panel");
      expect(html).toContain("visible-key");
    } finally {
      const i = process.argv.indexOf("--experimental");
      if (i !== -1) process.argv.splice(i, 1);
    }
  });
});

describe("DELETE /api/api-keys/:id", () => {
  it("htmx delete re-renders the panel without any plaintext key", async () => {
    const created = await (await fetch(`${baseUrl}/api/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "doomed" }),
    })).json() as { id: string };

    const res = await fetch(`${baseUrl}/api/api-keys/${created.id}`, {
      method: "DELETE",
      headers: { "HX-Request": "true" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("sk-api-keys-panel");
    expect(html).not.toContain("doomed");
    expect(html).not.toMatch(/sk-[a-f0-9]{32}/);
  });
});
