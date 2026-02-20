import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startServer } from "../server";
import { registerTaskRoutes } from "./tasks";
import { getDb, initializeDatabase, closeDb } from "../db/connection";
import type { Server } from "bun";

let server: Server;
let baseUrl: string;

beforeAll(() => {
  // Initialize in-memory database singleton before routes are registered
  const db = getDb(":memory:");
  initializeDatabase(db);

  registerTaskRoutes();

  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  closeDb();
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

  it("returns HTML error when priority is out of range", async () => {
    const body = new URLSearchParams({ title: "Bad Priority Task", priority: "99" });
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Priority must be between 1 and 10");
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
