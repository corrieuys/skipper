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
    "INSERT INTO tasks (id, title, status, task_type) VALUES ('task-rt-data', 'RT', 'approved', 'real_time')",
  ).run();
  authHeaders = createTestApiKey(db).headers;

  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  resetDb();
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
