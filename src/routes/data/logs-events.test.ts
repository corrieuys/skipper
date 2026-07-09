import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import type { ManagerDaemon } from "../../agents/manager-daemon";
import { startServer } from "../../server";
import { getDb, initializeDatabase, resetDb } from "../../db/connection";
import { registerDataLogRoutes } from "./logs";
import { registerDataEscalationRoutes } from "./escalations";
import { createTestApiKey } from "./test-helpers";

let server: Server<unknown>;
let baseUrl: string;
let headers: Record<string, string>;

const fakeDaemon = {
  getEscalationManager: () => ({
    reconcileOpenEscalationsForInactiveTasks: () => {},
    dismissEscalation: () => {},
  }),
} as unknown as ManagerDaemon;

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);
  registerDataLogRoutes();
  registerDataEscalationRoutes(db, fakeDaemon);

  // FK targets first: events/escalations reference tasks + agents.
  db.prepare("INSERT INTO agents (id, name, type, model, config, capabilities) VALUES ('agent-esc', 'Esc', 'claude-code', 'default', '{}', '[]')").run();
  db.prepare("INSERT INTO tasks (id, title, status) VALUES ('task-a', 'A', 'running')").run();
  db.prepare("INSERT INTO tasks (id, title, status) VALUES ('task-b', 'B', 'running')").run();

  db.prepare("INSERT INTO error_log (category, message, context) VALUES ('daemon.tick', 'boom', '{\"taskId\":\"task-a\"}')").run();
  db.prepare("INSERT INTO error_log (category, message, context) VALUES ('agent.spawn', 'oops', '{}')").run();
  db.prepare("INSERT INTO events (type, payload, task_id) VALUES ('phase:complete', '{\"phase\":1}', 'task-a')").run();
  db.prepare("INSERT INTO events (type, payload, task_id) VALUES ('task:created', '{}', 'task-b')").run();
  db.prepare(
    "INSERT INTO escalations (id, agent_id, task_id, type, question, status, response, resolved_at) VALUES ('esc-1', 'agent-esc', 'task-a', 'agent_request', 'help?', 'resolved', 'done', datetime('now'))",
  ).run();
  db.prepare(
    "INSERT INTO escalations (id, agent_id, task_id, type, question, status) VALUES ('esc-2', 'agent-esc', 'task-a', 'max_nudges', 'stuck', 'open')",
  ).run();

  headers = createTestApiKey(db).headers;
  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  resetDb();
});

describe("GET /data/logs", () => {
  it("filters by category and parses context", async () => {
    const body = await (await fetch(`${baseUrl}/data/logs?category=daemon.tick`, { headers })).json() as {
      data: Array<{ message: string; context: Record<string, unknown> }>;
    };
    expect(body.data.length).toBe(1);
    expect(body.data[0]!.message).toBe("boom");
    expect(body.data[0]!.context.taskId).toBe("task-a");
  });

  it("filters by task_id via the context JSON", async () => {
    const body = await (await fetch(`${baseUrl}/data/logs?task_id=task-a`, { headers })).json() as {
      data: Array<{ category: string }>;
    };
    expect(body.data.length).toBe(1);
    expect(body.data[0]!.category).toBe("daemon.tick");
  });
});

describe("GET /data/events", () => {
  it("filters by type and task_id, payload parsed", async () => {
    const byType = await (await fetch(`${baseUrl}/data/events?type=phase:complete`, { headers })).json() as {
      data: Array<{ payload: Record<string, unknown> }>;
    };
    expect(byType.data.length).toBe(1);
    expect(byType.data[0]!.payload.phase).toBe(1);

    const byTask = await (await fetch(`${baseUrl}/data/events?task_id=task-b`, { headers })).json() as {
      data: Array<{ type: string }>;
    };
    expect(byTask.data.length).toBe(1);
    expect(byTask.data[0]!.type).toBe("task:created");
  });
});

describe("escalation detail + history", () => {
  it("returns a resolved escalation by id", async () => {
    const body = await (await fetch(`${baseUrl}/data/escalations/esc-1`, { headers })).json() as {
      data: { status: string; response: string; agent_name: string; task_title: string };
    };
    expect(body.data.status).toBe("resolved");
    expect(body.data.response).toBe("done");
    expect(body.data.agent_name).toBe("Esc");
    expect(body.data.task_title).toBe("A");
  });

  it("404s for an unknown escalation", async () => {
    const res = await fetch(`${baseUrl}/data/escalations/nope`, { headers });
    expect(res.status).toBe(404);
  });

  it("lists full task history including resolved", async () => {
    const body = await (await fetch(`${baseUrl}/data/tasks/task-a/escalations`, { headers })).json() as {
      data: Array<{ id: string }>;
    };
    expect(body.data.map((e) => e.id).sort()).toEqual(["esc-1", "esc-2"]);
  });
});
