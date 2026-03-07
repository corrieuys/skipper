import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { startServer } from "../server";
import { registerPageRoutes } from "./pages";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import type { Server } from "bun";

let server: Server;
let baseUrl: string;

function seedBaseData(): void {
  const db = getDb();

  db.prepare(
    `INSERT INTO agents (id, name, type, model, status, config, capabilities, process_pid, current_task_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("agent-1", "Lead Agent", "codex", "default", "idle", JSON.stringify({ instruction: "Lead" }), JSON.stringify(["planning"]), null, null);

  db.prepare(
    `INSERT INTO agents (id, name, type, model, status, config, capabilities, process_pid, current_task_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("agent-2", "Analyst Agent", "codex", "default", "idle", JSON.stringify({ instruction: "Analyze" }), JSON.stringify(["analysis", "research"]), 1234, "task-1");

  db.prepare(
    `INSERT INTO teams (id, name, entrypoint_agent_id, phases, goal)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("team-1", "Platform Team", "agent-1", JSON.stringify([{ name: "Plan", prompt: "Plan" }, { name: "Build", prompt: "Build" }]), "Ship");

  db.prepare(
    `INSERT INTO team_agents (id, team_id, agent_id, role, level, max_complexity)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("ta-1", "team-1", "agent-1", "lead", 0, 10);

  db.prepare(
    `INSERT INTO team_agents (id, team_id, agent_id, role, level, max_complexity)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("ta-2", "team-1", "agent-2", "analyst", 1, 7);

  db.prepare(
    `INSERT INTO tasks (id, title, description, team_id, status, current_phase, priority, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("task-1", "Investigate issue", "Task description", "team-1", "completed", 1, 5, JSON.stringify({ ok: true }));

  db.prepare(
    `INSERT INTO delegations (id, parent_agent_id, child_agent_id, task_id, prompt, result, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("deleg-1", "agent-1", "agent-2", "task-1", "Analyze logs", "Done", "completed");
}

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);

  registerPageRoutes({
    getStatus: () => ({ state: "running", uptime: 100 }),
    getEscalationManager: () => ({
      reconcileOpenEscalationsForInactiveTasks: () => {},
      resolveEscalation: async () => {},
    }),
  } as never);

  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM escalations");
  db.exec("DELETE FROM delegations");
  db.exec("DELETE FROM team_agents");
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM teams");
  db.exec("DELETE FROM agents");
  seedBaseData();
});

afterAll(() => {
  server.stop(true);
  resetDb();
});

describe("fragment polling routes", () => {
  it("GET /fragments/tasks/list returns polling wrapper and list", async () => {
    const res = await fetch(`${baseUrl}/fragments/tasks/list`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="task-list"');
    expect(html).toContain('hx-get="/fragments/tasks/list"');
    expect(html).toContain("Investigate issue");
    expect(html).toContain('hx-trigger="every 8s"');
  });

  it("GET /fragments/tasks/:id/summary returns status summary", async () => {
    const res = await fetch(`${baseUrl}/fragments/tasks/task-1/summary`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="task-summary-fragment"');
    expect(html).toContain("badge-completed");
    expect(html).toContain("Task description");
  });

  it("GET /fragments/tasks/:id/delegations returns delegation rows", async () => {
    const res = await fetch(`${baseUrl}/fragments/tasks/task-1/delegations`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="task-delegations-fragment"');
    expect(html).toContain("Analyze logs");
    expect(html).toContain("Lead Agent");
    expect(html).toContain("Analyst Agent");
  });

  it("GET /fragments/agents/list returns status badges", async () => {
    const res = await fetch(`${baseUrl}/fragments/agents/list`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="agent-list"');
    expect(html).toContain("Lead Agent");
    expect(html).toContain("badge-idle");
  });

  it("GET /fragments/agents/:id/summary returns task/status", async () => {
    const db = getDb();
    db.prepare("UPDATE agents SET status = 'busy', current_task_id = ?, process_pid = ? WHERE id = ?").run("task-1", 4321, "agent-2");

    const res = await fetch(`${baseUrl}/fragments/agents/agent-2/summary`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="agent-summary-fragment"');
    expect(html).toContain("badge-busy");
    expect(html).toContain("task-1");
  });

  it("GET /fragments/teams/list returns entrypoint and phase count", async () => {
    const res = await fetch(`${baseUrl}/fragments/teams/list`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="team-list"');
    expect(html).toContain("Platform Team");
    expect(html).toContain("Lead Agent");
    expect(html).toContain(">2<");
  });

  it("GET /fragments/teams/:id/members returns member fields", async () => {
    const res = await fetch(`${baseUrl}/fragments/teams/team-1/members`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="team-members-fragment"');
    expect(html).toContain("name=\"role\"");
    expect(html).toContain("name=\"level\"");
    expect(html).toContain("name=\"skills\"");
    expect(html).toContain("analysis, research");
  });

  it("uses fast polling when system is active", async () => {
    const db = getDb();
    db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run("task-1");

    const res = await fetch(`${baseUrl}/fragments/tasks/list`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('hx-trigger="every 3s"');
  });

  it("pollingRoot includes HTMX error handling to prevent fragment destruction", async () => {
    const res = await fetch(`${baseUrl}/fragments/tasks/list`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("hx-on:htmx:response-error");
  });

  it("GET /escalations renders escalation card with agent_id, task_id, and status badge", async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO escalations (id, agent_id, task_id, type, question, response, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("esc-1", "agent-1", "task-1", "approval", "Should I proceed?", null, "open", "2026-01-01T00:00:00Z");

    const res = await fetch(`${baseUrl}/escalations`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("badge-open");
    expect(html).toContain("agent-1".slice(0, 8));
    expect(html).toContain("task-1".slice(0, 8));
    expect(html).toContain("Should I proceed?");
  });
});
