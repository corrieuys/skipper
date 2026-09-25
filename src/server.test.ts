import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startServer, addRoute, routes, setWebSocketUpgradeHandlers, setWebSocketHandlers, setConfiguredAllowedHosts } from "./server";
import type { Server } from "bun";

let server: Server;
let baseUrl: string;

beforeAll(() => {
  server = startServer(0); // port 0 = random available port
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("Health check", () => {
  it("returns 200 with status ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
    expect(typeof body.uptime).toBe("number");
  });
});

describe("Static file serving", () => {
  it("serves index.html", async () => {
    const res = await fetch(`${baseUrl}/index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html");
    const text = await res.text();
    expect(text).toContain("Skipper Orchestrator");
  });
});

describe("404 handling", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not Found");
  });
});

describe("Route registration", () => {
  it("supports dynamic route params", async () => {
    const initialLength = routes.length;
    addRoute("GET", "/api/test/:id", (_req, params) => {
      return Response.json({ id: params.id });
    });
    expect(routes.length).toBe(initialLength + 1);

    const res = await fetch(`${baseUrl}/api/test/abc123`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("abc123");
  });
});

// The foreign-request gate sits in front of the router and every WebSocket
// upgrade handler (header rules: src/server-origin.test.ts).
describe("Foreign request gate", () => {
  let writes = 0;
  let upgrades = 0;
  let opens = 0;

  beforeAll(() => {
    addRoute("POST", "/api/test/gate-write", () => {
      writes++;
      return Response.json({ ok: true });
    });
    setWebSocketUpgradeHandlers([
      (req, s) => {
        if (new URL(req.url).pathname !== "/ws/gate-test") return false;
        upgrades++;
        return s.upgrade(req, { data: { type: "connect-local" } });
      },
    ]);
    setWebSocketHandlers({ "connect-local": { open: () => { opens++; } } });
  });

  afterAll(() => {
    setWebSocketUpgradeHandlers([]);
    setWebSocketHandlers({});
  });

  /** Resolves "open" or "refused" for a WebSocket to the test path. */
  function tryWebSocket(headers?: Record<string, string>): Promise<"open" | "refused"> {
    return new Promise((resolve) => {
      const url = `ws://127.0.0.1:${server.port}/ws/gate-test`;
      // Bun's WebSocket takes request headers as a second-argument option.
      const ws = headers ? new WebSocket(url, { headers } as unknown as string[]) : new WebSocket(url);
      ws.addEventListener("open", () => {
        resolve("open"); // before close(): Bun can fire "close" synchronously
        ws.close();
      });
      ws.addEventListener("error", () => resolve("refused"));
      ws.addEventListener("close", () => resolve("refused"));
    });
  }

  it("refuses a cross-site POST before the route handler runs", async () => {
    const before = writes;
    const res = await fetch(`${baseUrl}/api/test/gate-write`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(writes).toBe(before);
  });

  it("lets a POST with no Origin through", async () => {
    const before = writes;
    const res = await fetch(`${baseUrl}/api/test/gate-write`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(writes).toBe(before + 1);
  });

  it("refuses a rebound Host on a plain GET", async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { Host: `evil.example:${server.port}` } });
    expect(res.status).toBe(403);
  });

  it("refuses a WebSocket upgrade with a foreign Origin before any upgrade handler runs", async () => {
    const before = upgrades;
    expect(await tryWebSocket({ Origin: "https://evil.example" })).toBe("refused");
    expect(upgrades).toBe(before);
  });

  it("opens a WebSocket with no Origin (native clients)", async () => {
    const before = opens;
    expect(await tryWebSocket()).toBe("open");
    expect(opens).toBe(before + 1);
  });
});

// The Host allowlist is the union of the boot names (SKIPPER_ALLOWED_HOSTS, the
// bind hostname) and the config page's list, which a running server picks up on
// its next request.
describe("Host allowlist sources", () => {
  it("unions SKIPPER_ALLOWED_HOSTS with the config page's list, live, without a restart", async () => {
    const previous = process.env.SKIPPER_ALLOWED_HOSTS;
    process.env.SKIPPER_ALLOWED_HOSTS = "env-box.test";
    const envServer = startServer(0);
    if (previous === undefined) delete process.env.SKIPPER_ALLOWED_HOSTS;
    else process.env.SKIPPER_ALLOWED_HOSTS = previous;
    const statusAs = async (host: string) =>
      (await fetch(`http://127.0.0.1:${envServer.port}/health`, { headers: { Host: `${host}:${envServer.port}` } })).status;
    try {
      expect(await statusAs("env-box.test")).toBe(200);
      expect(await statusAs("page-box.test")).toBe(403);

      setConfiguredAllowedHosts(["page-box.test"]);
      expect(await statusAs("page-box.test")).toBe(200);
      expect(await statusAs("env-box.test")).toBe(200);

      setConfiguredAllowedHosts([]);
      expect(await statusAs("page-box.test")).toBe(403);
      expect(await statusAs("env-box.test")).toBe(200);
    } finally {
      setConfiguredAllowedHosts([]);
      envServer.stop(true);
    }
  });
});
