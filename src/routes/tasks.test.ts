import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startServer } from "../server";
import { registerTaskRoutes } from "./tasks";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import type { Server } from "bun";

let server: Server;
let baseUrl: string;

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);

  registerTaskRoutes();

  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  resetDb();
});

describe("POST /api/tasks/:id/approve", () => {
  it("returns HTML tasks page after approving a draft task", async () => {
    // Approve requires a team - insert one directly
    const db = getDb();
    const teamId = crypto.randomUUID();
    db.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run(teamId, "Test Team");

    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Task to approve", teamId }),
    });
    expect(createRes.status).toBe(201);
    const task = await createRes.json();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Tasks");
    expect(body).toContain("Task to approve");
  });

  it("returns JSON error for unknown task id", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent/approve`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

describe("POST /api/tasks/:id/cancel", () => {
  it("returns HTML tasks page after cancelling a draft task", async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Task to cancel" }),
    });
    expect(createRes.status).toBe(201);
    const task = await createRes.json();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Tasks");
    expect(body).toContain("Task to cancel");
  });

  it("returns JSON error for unknown task id", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent/cancel`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

describe("POST /api/tasks/:id/retry", () => {
  it("returns HTML tasks page after retrying a failed task", async () => {
    const db = getDb();
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run(id, "Task to retry", "failed");

    const res = await fetch(`${baseUrl}/api/tasks/${id}/retry`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Tasks");
    expect(body).toContain("Task to retry");
  });

  it("returns JSON error for unknown task id", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent/retry`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});
