import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import type { Server } from "bun";
import type { ManagerDaemon } from "../../agents/manager-daemon";
import { startServer } from "../../server";
import { getDb, initializeDatabase, resetDb } from "../../db/connection";
import { registerDataRoutes } from "./index";
import { createTestApiKey } from "./test-helpers";

let server: Server<unknown>;
let baseUrl: string;
let authHeaders: { Authorization: string };

const startSession = mock(() => ({ session_id: "task-rt-data", state: "active" }));
const fakeDaemon = {
  getRealtimeSessionManager: () => ({ startSession }),
  getAgentManager: () => ({ getRunningAgents: () => new Map() }),
} as unknown as ManagerDaemon;

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);

  // Regression: registerDataRoutes once passed (db, daemon) into registrars
  // that take only a daemon — the Database landed in the daemon slot and
  // every realtime data route died with "not a function".
  registerDataRoutes(db, fakeDaemon);

  db.prepare(
    "INSERT INTO tasks (id, title, status, mode) VALUES ('task-rt-data', 'RT', 'active', 'conversational')",
  ).run();
  authHeaders = createTestApiKey(db).headers;

  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  resetDb();
});

describe("POST /data/realtime-tasks/:id", () => {
  it("keeps the stored description when the body omits it", async () => {
    getDb().prepare(
      "INSERT INTO tasks (id, title, description, status, mode) VALUES ('task-rt-edit', 'RT edit', 'stored description', 'draft', 'conversational')",
    ).run();

    const res = await fetch(`${baseUrl}/data/realtime-tasks/task-rt-edit`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "RT edited" }),
    });
    const body = await res.json() as { ok: boolean; data: { title: string; description: string | null } };

    expect(res.status).toBe(200);
    expect(body.data.title).toBe("RT edited");
    expect(body.data.description).toBe("stored description");
  });
});

describe("POST /data/realtime-tasks/:id/start", () => {
  it("starts the session through the daemon's realtime session manager", async () => {
    const res = await fetch(`${baseUrl}/data/realtime-tasks/task-rt-data/start`, { method: "POST", headers: authHeaders });
    const body = await res.json() as { ok: boolean; data?: { started?: boolean } };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(startSession).toHaveBeenCalledWith("task-rt-data");
  });
});
