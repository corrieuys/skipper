import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import type { ManagerDaemon } from "../../agents/manager-daemon";
import { startServer } from "../../server";
import { getDb, initializeDatabase, resetDb } from "../../db/connection";
import { registerDataRoutes } from "./index";
import { createTestApiKey } from "./test-helpers";
import { PhaseManager } from "../../orchestrator/phase-manager";
import { TaskScheduler } from "../../tasks/scheduler";

let server: Server<unknown>;
let baseUrl: string;
let headers: Record<string, string>;

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);

  // Real PhaseManager over the shared DB — the no-team approve path only
  // touches taskScheduler (setNeedsReview → completeTask), so the agent/prompt
  // collaborators can be inert.
  const scheduler = new TaskScheduler();
  const phaseManager = new PhaseManager(
    db,
    { getAgent: () => null } as never,
    {} as never,
    scheduler,
    { getTeamForExecution: () => null } as never,
    () => {},
    () => {},
  );

  const fakeDaemon = {
    getPhaseManager: () => phaseManager,
    getRealtimeSessionManager: () => ({}),
    getAgentManager: () => ({ getRunningAgents: () => new Map() }),
  } as unknown as ManagerDaemon;

  registerDataRoutes(db, fakeDaemon);

  db.prepare(
    "INSERT INTO tasks (id, title, status, needs_review, started_at) VALUES ('task-review', 'Review me', 'running', 1, datetime('now'))",
  ).run();
  // task_notes.agent_id has an FK in monolith schema — notes resolve the
  // team entrypoint agent, so give the plain task a team.
  db.prepare(
    "INSERT INTO agents (id, name, type, model, config, capabilities) VALUES ('agent-note', 'Noter', 'claude-code', 'default', '{}', '[]')",
  ).run();
  db.prepare(
    "INSERT INTO teams (id, name, entrypoint_agent_id) VALUES ('team-note', 'Team', 'agent-note')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (id, title, status, team_id) VALUES ('task-plain', 'No review', 'draft', 'team-note')",
  ).run();

  const auth = createTestApiKey(db).headers;
  headers = { ...auth, "Content-Type": "application/json" };

  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  resetDb();
});

describe("review endpoints", () => {
  it("404s for an unknown task", async () => {
    const res = await fetch(`${baseUrl}/data/tasks/nope/review/approve`, { method: "POST", headers });
    expect(res.status).toBe(404);
  });

  it("409s when the task is not awaiting review", async () => {
    const res = await fetch(`${baseUrl}/data/tasks/task-plain/review/approve`, { method: "POST", headers });
    expect(res.status).toBe(409);
  });

  it("reports review state and approves through the phase manager", async () => {
    const state = await (await fetch(`${baseUrl}/data/tasks/task-review/review`, { headers })).json() as {
      data: { needs_review: boolean; status: string };
    };
    expect(state.data.needs_review).toBe(true);
    expect(state.data.status).toBe("running");

    const res = await fetch(`${baseUrl}/data/tasks/task-review/review/approve`, { method: "POST", headers });
    expect(res.status).toBe(200);

    // No team + no phases → approve completes the task.
    const after = await (await fetch(`${baseUrl}/data/tasks/task-review`, { headers })).json() as {
      data: { status: string; needs_review: number };
    };
    expect(after.data.status).toBe("completed");
  });
});

describe("note endpoints", () => {
  it("creates and soft-deletes a note", async () => {
    const create = await fetch(`${baseUrl}/data/tasks/task-plain/notes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "note from the data api" }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { data: { id: string; content: string; source: string } };
    expect(created.data.content).toBe("note from the data api");
    expect(created.data.source).toBe("user");

    const del = await fetch(`${baseUrl}/data/tasks/task-plain/notes/${created.data.id}`, {
      method: "DELETE",
      headers,
    });
    expect(del.status).toBe(200);

    const row = getDb()
      .prepare("SELECT deleted_at FROM task_notes WHERE id = ?")
      .get(created.data.id) as { deleted_at: string | null };
    expect(row.deleted_at).not.toBeNull();
  });

  it("rejects an empty note and an unknown note id", async () => {
    const bad = await fetch(`${baseUrl}/data/tasks/task-plain/notes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "  " }),
    });
    expect(bad.status).toBe(400);

    const missing = await fetch(`${baseUrl}/data/tasks/task-plain/notes/nope`, { method: "DELETE", headers });
    expect(missing.status).toBe(404);
  });
});

describe("artifact create endpoint", () => {
  it("creates an artifact and reads it back", async () => {
    const res = await fetch(`${baseUrl}/data/tasks/task-plain/artifacts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "api-plan", kind: "plan", body: "step 1", description: "from api" }),
    });
    expect(res.status).toBe(201);
    const created = await res.json() as { data: { name: string; version: number } };
    expect(created.data.version).toBe(1);

    const read = await (await fetch(`${baseUrl}/data/tasks/task-plain/artifacts/api-plan`, { headers })).json() as {
      data: { body: string; kind: string };
    };
    expect(read.data.body).toBe("step 1");
    expect(read.data.kind).toBe("plan");
  });

  it("400s on an invalid kind", async () => {
    const res = await fetch(`${baseUrl}/data/tasks/task-plain/artifacts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "x", kind: "nonsense", body: "y" }),
    });
    expect(res.status).toBe(400);
  });
});
