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

describe("POST /api/tasks", () => {
  it("returns HTML fragment with task table when given valid form data", async () => {
    const body = new URLSearchParams({ title: "Test Task", priority: "5" });
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Test Task");
    expect(html).toContain("badge-draft");
  });

  it("returns HTML error when title is missing", async () => {
    const body = new URLSearchParams({ priority: "5" });
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("title is required");
  });

  it("includes all tasks in the returned fragment after creation", async () => {
    const task1 = new URLSearchParams({ title: "Fragment Task A", priority: "3" });
    await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: task1.toString(),
    });

    const task2 = new URLSearchParams({ title: "Fragment Task B", priority: "7" });
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: task2.toString(),
    });
    const html = await res.text();
    expect(html).toContain("Fragment Task A");
    expect(html).toContain("Fragment Task B");
  });
});

describe("GET /api/tasks", () => {
  it("returns JSON list of tasks", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("POST /api/tasks/:id/approve", () => {
  it("returns HTML tasks page after approving a draft task", async () => {
    const db = getDb();
    const teamId = crypto.randomUUID();
    db.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run(teamId, "Test Team");

    const body = new URLSearchParams({ title: "Task to approve", teamId });
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(createRes.status).toBe(200);

    // Get the task ID from the database
    const tasks = db.prepare("SELECT id FROM tasks WHERE title = ?").all("Task to approve") as { id: string }[];
    const taskId = tasks[tasks.length - 1].id;

    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Tasks");
    expect(html).toContain("Task to approve");
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
    const body = new URLSearchParams({ title: "Task to cancel" });
    await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const db = getDb();
    const tasks = db.prepare("SELECT id FROM tasks WHERE title = ?").all("Task to cancel") as { id: string }[];
    const taskId = tasks[tasks.length - 1].id;

    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Tasks");
    expect(html).toContain("Task to cancel");
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
    const html = await res.text();
    expect(html).toContain("Tasks");
    expect(html).toContain("Task to retry");
  });

  it("returns JSON error for unknown task id", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent/retry`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});
