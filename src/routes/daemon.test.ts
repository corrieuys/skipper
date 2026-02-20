import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { startServer } from "../server";
import { registerDaemonRoutes } from "./daemon";
import { initializeDatabase } from "../db/connection";
import { ManagerDaemon } from "../agents/manager-daemon";
import type { Server } from "bun";

let server: Server;
let baseUrl: string;
let db: Database;
let daemon: ManagerDaemon;

beforeAll(() => {
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
  it("returns paused status", async () => {
    const res = await fetch(`${baseUrl}/api/daemon/pause`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("paused");
  });
});

describe("POST /api/daemon/resume", () => {
  it("returns running status", async () => {
    const res = await fetch(`${baseUrl}/api/daemon/resume`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("running");

    // Clean up - stop the daemon that resume started
    daemon.stop();
  });
});
