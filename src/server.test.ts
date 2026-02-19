import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startServer, addRoute, routes } from "./server";
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
