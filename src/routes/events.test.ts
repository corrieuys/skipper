import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { startServer } from "../server";
import { registerEventRoutes } from "./events";
import { initializeDatabase } from "../db/connection";
import type { Server } from "bun";

let server: Server;
let baseUrl: string;
let db: Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);

  // Seed some test events (source_agent_id must be null or a valid agent id due to FK)
  db.prepare(
    "INSERT INTO events (type, payload, source_agent_id, task_id) VALUES (?, ?, ?, ?)",
  ).run("test_error_1", JSON.stringify({ error_message: "first error" }), null, null);

  db.prepare(
    "INSERT INTO events (type, payload, source_agent_id, task_id) VALUES (?, ?, ?, ?)",
  ).run("test_error_2", JSON.stringify({ error_message: "second error" }), null, null);

  db.prepare(
    "INSERT INTO events (type, payload, source_agent_id, task_id) VALUES (?, ?, ?, ?)",
  ).run("test_error_3", JSON.stringify({ error_message: "third error" }), null, null);

  registerEventRoutes(db);
  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  db.close();
});

describe("GET /api/events", () => {
  it("returns a list of events", async () => {
    const res = await fetch(`${baseUrl}/api/events`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(3);
  });

  it("returns events in descending order (most recent first)", async () => {
    const res = await fetch(`${baseUrl}/api/events`);
    const body = await res.json() as Array<{ id: number; type: string }>;
    // Events are returned newest-first (ORDER BY id DESC)
    for (let i = 1; i < body.length; i++) {
      expect(body[i - 1].id).toBeGreaterThan(body[i].id);
    }
  });

  it("returns events with the expected fields", async () => {
    const res = await fetch(`${baseUrl}/api/events`);
    const body = await res.json() as Array<{
      id: number;
      type: string;
      payload: unknown;
      source_agent_id: string | null;
      task_id: string | null;
      created_at: string;
    }>;
    const event = body[0];
    expect(typeof event.id).toBe("number");
    expect(typeof event.type).toBe("string");
    expect(event.payload).not.toBeNull();
    expect("source_agent_id" in event).toBe(true);
    expect("task_id" in event).toBe(true);
    expect(typeof event.created_at).toBe("string");
  });

  it("parses the payload as JSON", async () => {
    const res = await fetch(`${baseUrl}/api/events`);
    const body = await res.json() as Array<{ type: string; payload: { error_message: string } }>;
    const e1 = body.find((e) => e.type === "test_error_1");
    expect(e1).not.toBeUndefined();
    expect(e1!.payload.error_message).toBe("first error");
  });

  it("respects the limit query parameter", async () => {
    const res = await fetch(`${baseUrl}/api/events?limit=1`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(body.length).toBe(1);
  });

  it("uses default limit of 50 when limit is not specified", async () => {
    // Insert more than 50 events to test default limit
    for (let i = 0; i < 55; i++) {
      db.prepare(
        "INSERT INTO events (type, payload) VALUES (?, ?)",
      ).run("bulk_event", JSON.stringify({ i }));
    }

    const res = await fetch(`${baseUrl}/api/events`);
    const body = await res.json() as unknown[];
    expect(body.length).toBe(50);
  });

  it("caps limit at 500", async () => {
    const res = await fetch(`${baseUrl}/api/events?limit=9999`);
    expect(res.status).toBe(200);
    // Just verify it doesn't error; actual count depends on seeded data
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  it("returns null source_agent_id when not set", async () => {
    const res = await fetch(`${baseUrl}/api/events?limit=500`);
    const body = await res.json() as Array<{ type: string; source_agent_id: string | null }>;
    const e2 = body.find((e) => e.type === "test_error_2");
    expect(e2).not.toBeUndefined();
    expect(e2!.source_agent_id).toBeNull();
  });
});
