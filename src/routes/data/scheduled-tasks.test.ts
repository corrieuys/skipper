import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { startServer } from "../../server";
import { getDb, initializeDatabase, resetDb } from "../../db/connection";
import { registerDataScheduledTaskRoutes } from "./scheduled-tasks";
import { createTestApiKey } from "./test-helpers";

let server: Server<unknown>;
let baseUrl: string;
let headers: Record<string, string>;

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
  it("creates, approves, lists, and deletes", async () => {
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
  });

  it("validates the interval", async () => {
    const res = await fetch(`${baseUrl}/data/scheduled-tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Bad", scheduleUnit: "hours", scheduleAmount: "-2" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates a weekly-matrix task from a JSON array and switches it to an interval", async () => {
    const matrix = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    matrix[4]![18] = 1; // Friday 18:00
    matrix[6]![7] = 1; // Sunday 07:00

    const create = await fetch(`${baseUrl}/data/scheduled-tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Weekend runs", teamId: "team-sched", scheduleMatrix: matrix }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as {
      data: { id: string; schedule_matrix: number[][] | null; schedule_unit: string | null };
    };
    expect(created.data.schedule_matrix).toEqual(matrix);
    expect(created.data.schedule_unit).toBeNull();

    const approve = await fetch(`${baseUrl}/data/scheduled-tasks/${created.data.id}/approve`, {
      method: "POST",
      headers,
    });
    expect(approve.status).toBe(200);
    const approved = await approve.json() as { data: { next_run_at: string | null } };
    expect(approved.data.next_run_at).not.toBeNull();

    // Switch back to an interval: unapprove, then update without a matrix.
    await fetch(`${baseUrl}/data/scheduled-tasks/${created.data.id}/unapprove`, { method: "POST", headers });
    const update = await fetch(`${baseUrl}/data/scheduled-tasks/${created.data.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Weekend runs", scheduleUnit: "days", scheduleAmount: 1 }),
    });
    expect(update.status).toBe(200);
    const updated = await update.json() as {
      data: { schedule_matrix: number[][] | null; schedule_unit: string | null };
    };
    expect(updated.data.schedule_matrix).toBeNull();
    expect(updated.data.schedule_unit).toBe("days");

    await fetch(`${baseUrl}/data/scheduled-tasks/${created.data.id}`, { method: "DELETE", headers });
  });

  it("rejects invalid matrices and interval+matrix together", async () => {
    const good = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    good[0]![9] = 1;

    const cases: unknown[] = [
      good.slice(0, 6), // 6 rows
      good.map(r => r.slice(0, 23)), // 23 columns
      good.map((r, i) => (i === 0 ? r.map(() => 2) : r)), // value 2
      Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)), // no enabled cell
      "{not json", // unparseable string
    ];
    for (const scheduleMatrix of cases) {
      const res = await fetch(`${baseUrl}/data/scheduled-tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Bad matrix", scheduleMatrix }),
      });
      expect(res.status).toBe(400);
    }

    const both = await fetch(`${baseUrl}/data/scheduled-tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Both", scheduleUnit: "hours", scheduleAmount: 2, scheduleMatrix: good }),
    });
    expect(both.status).toBe(400);
    const body = await both.json() as { error: string };
    expect(body.error).toContain("not both");
  });

  it("round-trips globalStoreInstructions and clears it on update", async () => {
    const contract = "Store the last processed id under key 'sweep-cursor'.";
    const create = await fetch(`${baseUrl}/data/scheduled-tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Cursor sweep", teamId: "team-sched", globalStoreInstructions: contract }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { data: { id: string; global_store_instructions: string | null } };
    expect(created.data.global_store_instructions).toBe(contract);

    const update = await fetch(`${baseUrl}/data/scheduled-tasks/${created.data.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Cursor sweep" }),
    });
    expect(update.status).toBe(200);
    const updated = await update.json() as { data: { global_store_instructions: string | null } };
    expect(updated.data.global_store_instructions).toBeNull();

    await fetch(`${baseUrl}/data/scheduled-tasks/${created.data.id}`, { method: "DELETE", headers });
  });
});
