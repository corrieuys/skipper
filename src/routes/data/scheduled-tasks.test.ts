import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { startServer } from "../../server";
import { getDb, initializeDatabase, resetDb } from "../../db/connection";
import { registerDataScheduledTaskRoutes } from "./scheduled-tasks";
import { createTestApiKey } from "./test-helpers";

let server: Server<unknown>;
let baseUrl: string;
let headers: Record<string, string>;

function withExperimental<T>(fn: () => Promise<T>): Promise<T> {
  process.argv.push("--experimental");
  return fn().finally(() => {
    const i = process.argv.indexOf("--experimental");
    if (i !== -1) process.argv.splice(i, 1);
  });
}

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);
  registerDataScheduledTaskRoutes();
  // Approval requires an assigned team.
  db.prepare("INSERT INTO teams (id, name) VALUES ('team-sched', 'Sched Team')").run();
  headers = { ...createTestApiKey(db).headers, "Content-Type": "application/json" };
  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  resetDb();
});

describe("scheduled tasks data API", () => {
  it("403s without the experimental flag", async () => {
    const res = await fetch(`${baseUrl}/data/scheduled-tasks`, { headers });
    expect(res.status).toBe(403);
  });

  it("creates, approves, lists, and deletes under --experimental", () => withExperimental(async () => {
    const create = await fetch(`${baseUrl}/data/scheduled-tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Nightly sweep", teamId: "team-sched", scheduleUnit: "hours", scheduleAmount: 6 }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { data: { id: string; status: string; schedule_unit: string } };
    expect(created.data.status).toBe("draft");
    expect(created.data.schedule_unit).toBe("hours");

    const approve = await fetch(`${baseUrl}/data/scheduled-tasks/${created.data.id}/approve`, {
      method: "POST",
      headers,
    });
    expect(approve.status).toBe(200);
    const approved = await approve.json() as { data: { status: string; next_run_at: string | null } };
    expect(approved.data.status).toBe("approved");
    expect(approved.data.next_run_at).not.toBeNull();

    const list = await (await fetch(`${baseUrl}/data/scheduled-tasks`, { headers })).json() as {
      data: Array<{ id: string }>;
    };
    expect(list.data.some((t) => t.id === created.data.id)).toBe(true);

    const detail = await (await fetch(`${baseUrl}/data/scheduled-tasks/${created.data.id}`, { headers })).json() as {
      data: { runs: unknown[] };
    };
    expect(Array.isArray(detail.data.runs)).toBe(true);

    const del = await fetch(`${baseUrl}/data/scheduled-tasks/${created.data.id}`, { method: "DELETE", headers });
    expect(del.status).toBe(200);
    const gone = await fetch(`${baseUrl}/data/scheduled-tasks/${created.data.id}`, { headers });
    expect(gone.status).toBe(404);
  }));

  it("validates the interval", () => withExperimental(async () => {
    const res = await fetch(`${baseUrl}/data/scheduled-tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Bad", scheduleUnit: "hours", scheduleAmount: "-2" }),
    });
    expect(res.status).toBe(400);
  }));
});
