import { describe, it, expect } from "bun:test";
import { rejectForeignRequest, allowedHostnames, hostnameOf } from "./server";

// The foreign-request gate in isolation: headers in, 403 or pass-through out.
// src/server.test.ts covers its placement in front of the router and the
// WebSocket upgrade handlers.

function req(method: string, headers: Record<string, string>, path = "/api/tasks"): Request {
  return new Request(`http://127.0.0.1:5005${path}`, { method, headers });
}

function wsUpgrade(headers: Record<string, string>): Request {
  return req("GET", { upgrade: "websocket", connection: "Upgrade", ...headers }, "/connect/local");
}

describe("rejectForeignRequest: Origin (CSRF, cross-site WebSocket)", () => {
  it("refuses a cross-site form POST with a foreign Origin", async () => {
    const res = rejectForeignRequest(req("POST", { host: "127.0.0.1:5005", origin: "https://evil.example" }));
    expect(res?.status).toBe(403);
    // Generic body: nothing about why.
    expect(await res?.json()).toEqual({ error: "Forbidden" });
  });

  it("refuses a write from another local origin (different port)", () => {
    expect(rejectForeignRequest(req("POST", { host: "localhost:5005", origin: "http://localhost:3000" }))?.status).toBe(403);
  });

  it("refuses Origin null (sandboxed frame, no-referrer form)", () => {
    expect(rejectForeignRequest(req("POST", { host: "localhost:5005", origin: "null" }))?.status).toBe(403);
  });

  it("refuses PUT, PATCH and DELETE from a foreign Origin too", () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect(rejectForeignRequest(req(method, { host: "localhost:5005", origin: "https://evil.example" }))?.status).toBe(403);
    }
  });

  it("allows a same-origin POST (the web UI)", () => {
    expect(rejectForeignRequest(req("POST", { host: "localhost:5005", origin: "http://localhost:5005", "sec-fetch-site": "same-origin" }))).toBeNull();
    expect(rejectForeignRequest(req("POST", { host: "127.0.0.1:5005", origin: "http://127.0.0.1:5005" }))).toBeNull();
    expect(rejectForeignRequest(req("POST", { host: "[::1]:5005", origin: "http://[::1]:5005" }))).toBeNull();
  });

  it("allows a POST with no Origin (TUI, Mac app, agent MCP clients, curl)", () => {
    expect(rejectForeignRequest(req("POST", { host: "localhost:5005" }))).toBeNull();
    expect(rejectForeignRequest(req("POST", { host: "localhost:5005" }, "/mcp"))).toBeNull();
  });

  it("refuses a POST marked Sec-Fetch-Site: cross-site even without an Origin", () => {
    expect(rejectForeignRequest(req("POST", { host: "127.0.0.1:5005", "sec-fetch-site": "cross-site" }))?.status).toBe(403);
  });

  it("does not Origin-check plain reads (the browser keeps their responses from the other site)", () => {
    expect(rejectForeignRequest(req("GET", { host: "localhost:5005", origin: "https://evil.example" }, "/health"))).toBeNull();
    expect(rejectForeignRequest(req("GET", { host: "localhost:5005", "sec-fetch-site": "cross-site" }, "/health"))).toBeNull();
    expect(rejectForeignRequest(req("OPTIONS", { host: "localhost:5005", origin: "https://evil.example" }))).toBeNull();
  });

  it("refuses a WebSocket upgrade with a foreign Origin", () => {
    expect(rejectForeignRequest(wsUpgrade({ host: "127.0.0.1:5005", origin: "https://evil.example" }))?.status).toBe(403);
    expect(rejectForeignRequest(wsUpgrade({ host: "127.0.0.1:5005", origin: "null" }))?.status).toBe(403);
    expect(rejectForeignRequest(wsUpgrade({ host: "127.0.0.1:5005", "sec-fetch-site": "cross-site" }))?.status).toBe(403);
  });

  it("allows a WebSocket upgrade with no Origin (native clients) or the same origin (web UI)", () => {
    expect(rejectForeignRequest(wsUpgrade({ host: "127.0.0.1:5005" }))).toBeNull();
    expect(rejectForeignRequest(wsUpgrade({ host: "localhost:5005", origin: "http://localhost:5005" }))).toBeNull();
  });

  it("refuses an Origin when the Host header is missing (it cannot be matched)", () => {
    const noHost = new Request("http://127.0.0.1:5005/api/tasks", { method: "POST", headers: { origin: "http://127.0.0.1:5005" } });
    expect(noHost.headers.get("host")).toBeNull();
    expect(rejectForeignRequest(noHost)?.status).toBe(403);
  });

  it("normalizes default ports when comparing Origin to Host", () => {
    const allowed = allowedHostnames("skipper.example.com");
    expect(rejectForeignRequest(req("POST", { host: "skipper.example.com:443", origin: "https://skipper.example.com" }), allowed)).toBeNull();
    expect(rejectForeignRequest(req("POST", { host: "skipper.example.com", origin: "https://skipper.example.com" }), allowed)).toBeNull();
  });
});

describe("rejectForeignRequest: Host (DNS rebinding)", () => {
  it("refuses a rebound hostname, for reads too", () => {
    expect(rejectForeignRequest(req("GET", { host: "evil.example" }, "/api/tasks"))?.status).toBe(403);
    expect(rejectForeignRequest(req("GET", { host: "evil.example:5005" }, "/"))?.status).toBe(403);
  });

  it("refuses a rebound hostname even when its Origin matches (the page is same-origin after rebinding)", () => {
    expect(rejectForeignRequest(req("POST", { host: "evil.example:5005", origin: "http://evil.example:5005" }))?.status).toBe(403);
    expect(rejectForeignRequest(wsUpgrade({ host: "evil.example:5005", origin: "http://evil.example:5005" }))?.status).toBe(403);
  });

  it("allows localhost and IP literals", () => {
    for (const host of ["localhost:5005", "localhost", "LOCALHOST:5005", "127.0.0.1:5005", "10.0.2.2:5005", "192.168.1.20:5005", "[::1]:5005", "[::1]"]) {
      expect(rejectForeignRequest(req("GET", { host }, "/health"))).toBeNull();
    }
  });

  it("refuses names that only resolve to loopback and malformed Host values", () => {
    for (const host of ["127.0.0.1.nip.io:5005", "sub.localhost:5005", "evil@127.0.0.1:5005", "127.0.0.1:5005/x", "[evil.example]:5005"]) {
      expect(rejectForeignRequest(req("GET", { host }, "/health"))?.status).toBe(403);
    }
  });

  it("allows a request with no Host header (not a browser)", () => {
    const noHost = new Request("http://127.0.0.1:5005/api/tasks", { method: "POST" });
    expect(noHost.headers.get("host")).toBeNull();
    expect(rejectForeignRequest(noHost)).toBeNull();
  });

  it("allows an allowlisted hostname, case-insensitively", () => {
    const allowed = allowedHostnames("my-mac.local");
    expect(rejectForeignRequest(req("GET", { host: "my-mac.local:5005" }, "/"), allowed)).toBeNull();
    expect(rejectForeignRequest(req("POST", { host: "My-Mac.local:5005", origin: "http://my-mac.local:5005" }), allowed)).toBeNull();
    expect(rejectForeignRequest(req("GET", { host: "other.local:5005" }, "/"), allowed)?.status).toBe(403);
  });
});

describe("allowedHostnames", () => {
  it("parses a comma-separated list, lowercased, ports ignored, blanks skipped", () => {
    expect([...allowedHostnames(" My-Mac.local , skipper.example.com:8443,,")].sort()).toEqual(["my-mac.local", "skipper.example.com"]);
  });

  it("includes the bind hostname when it is a name", () => {
    expect(allowedHostnames(undefined, "my-mac.local").has("my-mac.local")).toBe(true);
    // An IPv6 wildcard bind is not a hostname and adds nothing.
    expect(allowedHostnames(undefined, "::").size).toBe(0);
  });

  it("is empty when nothing is configured", () => {
    expect(allowedHostnames(undefined).size).toBe(0);
    expect(allowedHostnames("").size).toBe(0);
  });
});

// The name syntax the gate matches, shared with the config page's validation.
describe("hostnameOf", () => {
  it("returns the lowercased name without its port", () => {
    expect(hostnameOf(" My-Mac.local:5005 ")).toBe("my-mac.local");
    expect(hostnameOf("build_box")).toBe("build_box");
    expect(hostnameOf("10.0.0.5:5005")).toBe("10.0.0.5"); // IPv4 parses as a name
  });

  it("is null for IPv6 literals and anything malformed", () => {
    for (const value of ["[::1]:5005", "::1", "", ":5005", "a b", "user@host", "host/path", "*.local", "http://host"]) {
      expect(hostnameOf(value)).toBeNull();
    }
  });
});
