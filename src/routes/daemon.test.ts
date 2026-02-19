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

  it("redirects to dashboard for HTMX callers", async () => {
    const res = await fetch(`${baseUrl}/api/daemon/pause`, {
      method: "POST",
      headers: { "HX-Request": "true" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});

describe("POST /api/daemon/resume", () => {
  it("returns JSON running status for non-HTMX callers", async () => {
    const res = await fetch(`${baseUrl}/api/daemon/resume`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("running");
  });

  it("redirects to dashboard for HTMX callers", async () => {
    const res = await fetch(`${baseUrl}/api/daemon/resume`, {
      method: "POST",
      headers: { "HX-Request": "true" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    // Clean up - stop the daemon that resume started
    daemon.stop();
  });
});

describe("daemon fragment controls", () => {
  it("POST /fragments/daemon/pause returns the compact pause fragment swap target", async () => {
    daemon.resume();
    const res = await fetch(`${baseUrl}/fragments/daemon/pause`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="daemon-global-control"');
    expect(body).toContain("Resume Daemon");
  });

  it("POST /fragments/daemon/resume returns the compact running fragment swap target", async () => {
    await daemon.pause();
    const res = await fetch(`${baseUrl}/fragments/daemon/resume`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="daemon-global-control"');
    expect(body).toContain("Pause Daemon");
  });
});
