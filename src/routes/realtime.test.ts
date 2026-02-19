import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { startServer } from "../server";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { registerRealtimeRoutes } from "./realtime";

let server: Server;
let baseUrl: string;

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

describe("POST /api/realtime-tasks/:id", () => {
  it("updates title/description for an existing real-time task", async () => {
    const createBody = new URLSearchParams({
      title: "Realtime Original",
      description: "original description",
    });
    const createRes = await fetch(`${baseUrl}/api/realtime-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: createBody.toString(),
    });
    expect(createRes.status).toBe(201);

    const created = await createRes.json() as { id: string };
    const updateBody = new URLSearchParams({
      title: "Realtime Updated",
      description: "updated description",
    });
    const updateRes = await fetch(`${baseUrl}/api/realtime-tasks/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: updateBody.toString(),
    });
    expect(updateRes.status).toBe(200);

    const db = getDb();
    const row = db.prepare("SELECT title, description FROM tasks WHERE id = ?").get(created.id) as {
      title: string;
      description: string | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row!.title).toBe("Realtime Updated");
    expect(row!.description).toBe("updated description");
  });

  it("returns HX redirect for HTMX requests", async () => {
    const createBody = new URLSearchParams({
      title: "Realtime HTMX Original",
    });
    const createRes = await fetch(`${baseUrl}/api/realtime-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: createBody.toString(),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { id: string };

    const updateBody = new URLSearchParams({
      title: "Realtime HTMX Updated",
    });
    const updateRes = await fetch(`${baseUrl}/api/realtime-tasks/${created.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "HX-Request": "true",
      },
      body: updateBody.toString(),
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.headers.get("HX-Redirect")).toBe(`/realtime/${created.id}`);
  });
});

describe("POST /api/realtime-tasks/:id/start", () => {
  it("returns 503 when daemon is not available", async () => {
    const createBody = new URLSearchParams({
      title: "Realtime Start No Daemon",
      description: "start me",
    });
    const createRes = await fetch(`${baseUrl}/api/realtime-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: createBody.toString(),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { id: string };

    const db = getDb();
    db.prepare("UPDATE tasks SET status = 'approved', started_at = NULL WHERE id = ?").run(created.id);

    const startRes = await fetch(`${baseUrl}/api/realtime-tasks/${created.id}/start`, { method: "POST" });
    expect(startRes.status).toBe(503);
    const body = await startRes.json() as { error: string };
    expect(body.error).toContain("Daemon not available");
  });

});

describe("GET /api/realtime-tasks/:id/timeline", () => {
  it("returns newest timeline entries first", async () => {
    const createBody = new URLSearchParams({
      title: "Realtime Timeline Sort",
      description: "ordering",
    });
    const createRes = await fetch(`${baseUrl}/api/realtime-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: createBody.toString(),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { id: string };

    const db = getDb();
    db.prepare(
      `INSERT INTO realtime_timeline (id, task_id, entry_type, content, created_at)
       VALUES (?, ?, 'text', ?, ?)`,
    ).run("rt-old", created.id, "old entry", "2026-01-01 10:00:00");
    db.prepare(
      `INSERT INTO realtime_timeline (id, task_id, entry_type, content, created_at)
       VALUES (?, ?, 'text', ?, ?)`,
    ).run("rt-new", created.id, "new entry", "2026-01-01 10:10:00");

    const res = await fetch(`${baseUrl}/api/realtime-tasks/${created.id}/timeline`);
    expect(res.status).toBe(200);
    const timeline = await res.json() as Array<{ id: string; content: string }>;
    expect(timeline[0].id).toBe("rt-new");
    expect(timeline[1].id).toBe("rt-old");
  });
});
