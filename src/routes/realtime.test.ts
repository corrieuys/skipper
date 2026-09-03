import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { startServer } from "../server";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { registerRealtimeRoutes } from "./realtime";

let server: Server;
let baseUrl: string;

// Creation/edit of conversational tasks now goes through the unified task
// endpoints (see tasks.test.ts); these routes only carry the session/timeline
// surface the embedded JS still calls. Seed rows directly.
function seedTask(id: string, status: string = "active"): void {
  getDb()
    .prepare(
      "INSERT INTO tasks (id, title, description, status, mode) VALUES (?, ?, ?, ?, 'conversational')",
    )
    .run(id, `Task ${id}`, "seeded", status);
}

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);

  registerRealtimeRoutes();

  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  resetDb();
});

describe("POST /api/realtime-tasks/:id/start", () => {
  it("returns 503 when daemon is not available", async () => {
    seedTask("rt-start");

    const startRes = await fetch(`${baseUrl}/api/realtime-tasks/rt-start/start`, { method: "POST" });
    expect(startRes.status).toBe(503);
    const body = await startRes.json() as { error: string };
    expect(body.error).toContain("Daemon not available");
  });

  it("rejects a draft task", async () => {
    seedTask("rt-draft", "draft");
    const startRes = await fetch(`${baseUrl}/api/realtime-tasks/rt-draft/start`, { method: "POST" });
    expect([400, 409]).toContain(startRes.status);
  });
});

describe("GET /api/realtime-tasks/:id/timeline", () => {
  it("returns newest timeline entries first", async () => {
    seedTask("rt-tl");

    const db = getDb();
    db.prepare(
      `INSERT INTO realtime_timeline (id, task_id, entry_type, content, created_at)
       VALUES (?, ?, 'text', ?, ?)`,
    ).run("rt-old", "rt-tl", "old entry", "2026-01-01 10:00:00");
    db.prepare(
      `INSERT INTO realtime_timeline (id, task_id, entry_type, content, created_at)
       VALUES (?, ?, 'text', ?, ?)`,
    ).run("rt-new", "rt-tl", "new entry", "2026-01-01 10:10:00");

    const res = await fetch(`${baseUrl}/api/realtime-tasks/rt-tl/timeline`);
    expect(res.status).toBe(200);
    const timeline = await res.json() as Array<{ id: string; content: string }>;
    expect(timeline[0].id).toBe("rt-new");
    expect(timeline[1].id).toBe("rt-old");
  });
});
