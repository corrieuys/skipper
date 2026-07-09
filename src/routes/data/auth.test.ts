import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import type { ManagerDaemon } from "../../agents/manager-daemon";
import { startServer, routes } from "../../server";
import { getDb, initializeDatabase, resetDb } from "../../db/connection";
import { registerDataRoutes } from "./index";
import { createTestApiKey } from "./test-helpers";

let server: Server<unknown>;
let baseUrl: string;
let authHeaders: { Authorization: string };

const fakeDaemon = {
  getRealtimeSessionManager: () => ({}),
  getAgentManager: () => ({ getRunningAgents: () => new Map() }),
  getPhaseManager: () => ({}),
  getStatus: () => ({ state: "running", uptime: 0 }),
} as unknown as ManagerDaemon;

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);
  registerDataRoutes(db, fakeDaemon);
  authHeaders = createTestApiKey(db).headers;
  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  resetDb();
});

describe("data API auth", () => {
  it("rejects every /data/* route without a key (401)", async () => {
    // Walk the live route table so a route registered with raw addRoute
    // (bypassing addDataRoute) fails this test.
    const dataRoutes = routes.filter((r) => r.pathPattern.startsWith("/data/"));
    expect(dataRoutes.length).toBeGreaterThan(30);

    for (const route of dataRoutes) {
      const path = route.pathPattern.replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, "x");
      const res = await fetch(`${baseUrl}${path}`, { method: route.method });
      expect(`${route.method} ${route.pathPattern} -> ${res.status}`)
        .toBe(`${route.method} ${route.pathPattern} -> 401`);
      expect(res.headers.get("www-authenticate")).toContain("skipper-data");
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(false);
    }
  });

  it("rejects an unknown key (401)", async () => {
    const res = await fetch(`${baseUrl}/data/tasks`, {
      headers: { Authorization: "Bearer sk-definitely-not-a-real-key-000" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts a valid key", async () => {
    const res = await fetch(`${baseUrl}/data/tasks`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
