import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { startServer } from "../server";
import { registerDaemonRoutes } from "./daemon";
import { initializeDatabase, resetDb, getDb } from "../db/connection";
import { ManagerDaemon } from "../agents/manager-daemon";
import type { Server } from "bun";

let server: Server;
let baseUrl: string;
let db: Database;
let daemon: ManagerDaemon;

beforeAll(() => {
  // Set up the getDb() singleton used by buildDashboardResponse
  resetDb();
  const routesDb = getDb(":memory:");
  initializeDatabase(routesDb);

  // Set up daemon with its own in-memory db
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);

  daemon = new ManagerDaemon(db);
  registerDaemonRoutes(daemon);

  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  daemon.stop();
  server.stop(true);
  db.close();
  resetDb();
});

describe("GET /api/daemon/status", () => {
  it("returns daemon status", async () => {
    const res = await fetch(`${baseUrl}/api/daemon/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBeDefined();
    expect(typeof body.uptime).toBe("number");
  });
});

describe("POST /api/daemon/pause", () => {
  it("returns JSON paused status for non-HTMX callers", async () => {
    const res = await fetch(`${baseUrl}/api/daemon/pause`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("paused");
  });

  it("returns full dashboard HTML for HTMX callers", async () => {
    const res = await fetch(`${baseUrl}/api/daemon/pause`, {
      method: "POST",
      headers: { "HX-Request": "true" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("Dashboard");
  });
});

describe("POST /api/daemon/resume", () => {
  it("returns JSON running status for non-HTMX callers", async () => {
    const res = await fetch(`${baseUrl}/api/daemon/resume`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("running");
  });

  it("returns full dashboard HTML for HTMX callers", async () => {
    const res = await fetch(`${baseUrl}/api/daemon/resume`, {
      method: "POST",
      headers: { "HX-Request": "true" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("Dashboard");

    // Clean up - stop the daemon that resume started
    daemon.stop();
  });
});
