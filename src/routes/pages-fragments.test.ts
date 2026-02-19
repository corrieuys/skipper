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
    `INSERT INTO team_agents (id, team_id, agent_id, role, level)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("ta-1", "team-1", "agent-1", "lead", 0);

  db.prepare(
    `INSERT INTO team_agents (id, team_id, agent_id, role, level)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("ta-2", "team-1", "agent-2", "analyst", 1);

  db.prepare(
    `INSERT INTO tasks (id, title, description, team_id, status, current_phase, result)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("task-1", "Investigate issue", "Task description", "team-1", "completed", 1, JSON.stringify({ ok: true }));

  db.prepare(
    `INSERT INTO delegations (id, parent_agent_id, child_agent_id, task_id, prompt, result, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("deleg-1", "agent-1", "agent-2", "task-1", "Analyze logs", "Done", "completed");

  db.prepare(
    `INSERT INTO task_artifacts (id, task_id, name, kind, version, description, body, created_by_agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("artifact-1", "task-1", "plan", "plan", 1, "Initial plan", "# Plan v1", "agent-1");

  db.prepare(
    `INSERT INTO task_artifacts (id, task_id, name, kind, version, description, body, created_by_agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("artifact-2", "task-1", "plan", "plan", 2, "Revised plan", "# Plan v2", "agent-1");

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
    listRuntimeSteeringOptions: () => [],
  } as never);

  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM terminal_outputs");
  db.exec("DELETE FROM agent_sessions");
  db.exec("DELETE FROM agent_instances");
  db.exec("DELETE FROM task_artifacts");
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
  it("GET /tasks/new renders the dedicated task creation page", async () => {
    const res = await fetch(`${baseUrl}/tasks/new`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Create Task");
    expect(html).toContain('hx-post="/api/tasks"');
    expect(html).toContain('class="sk-navbar"');
  });

  it("GET /fragments/tasks/list returns fragment wrapper and list", async () => {
    const res = await fetch(`${baseUrl}/fragments/tasks/list`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="task-list"');
    expect(html).toContain("Investigate issue");
    // No polling — updates via WebSocket push
    expect(html).not.toContain('hx-trigger="every');
  });

  it("GET /fragments/tasks/:id/summary returns status summary", async () => {
    const res = await fetch(`${baseUrl}/fragments/tasks/task-1/summary`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="task-summary-fragment"');
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

  it("GET /tasks/:id handles malformed terminal JSON without failing", async () => {
    const db = getDb();
    db.prepare("INSERT INTO agent_sessions (id, agent_id) VALUES (?, ?)").run("sess-1", "agent-2");
    db.prepare(
      `INSERT INTO terminal_outputs (agent_id, session_id, stream, data, sequence)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("agent-2", "sess-1", "stdout", "not-json-output", 1);

    const res = await fetch(`${baseUrl}/tasks/task-1`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Investigate issue");
  });

  it("GET /fragments/agents/list returns agent names and model", async () => {
    const res = await fetch(`${baseUrl}/fragments/agents/list`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="agent-list"');
    expect(html).toContain("Lead Agent");
    expect(html).toContain("Model");
  });

  it("GET /fragments/agents/:id/summary returns instance count", async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, status)
       VALUES (?, ?, ?, ?)`,
    ).run("inst-1", "task-1", "agent-2", "running");

    const res = await fetch(`${baseUrl}/fragments/agents/agent-2/summary`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="agent-summary-fragment"');
    expect(html).toContain("1 running");
  });

  it("GET /fragments/teams/list returns entrypoint and phase count", async () => {
    const res = await fetch(`${baseUrl}/fragments/teams/list`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="team-list"');
    expect(html).toContain("Platform Team");
    expect(html).toContain(">2<");
  });

  it("GET /teams/new redirects to /config (v1 page removed)", async () => {
    const res = await fetch(`${baseUrl}/teams/new`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/config");
  });

  it("GET /fragments/teams/:id/members returns member rows", async () => {
    const res = await fetch(`${baseUrl}/fragments/teams/team-1/members`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="team-members-fragment"');
    expect(html).toContain("analysis, research");
  });

  it("fragment routes return content without polling attributes", async () => {
    const db = getDb();
    db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run("task-1");

    const res = await fetch(`${baseUrl}/fragments/tasks/list`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="task-list"');
    expect(html).not.toContain('hx-trigger="every');
  });

  it("GET /fragments/dashboard/running-instances renders one card per live instance", async () => {
    const db = getDb();
    db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run("task-1");

    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, status)
       VALUES (?, ?, ?, ?)`,
    ).run("inst-alpha-12345678", "task-1", "agent-2", "running");
    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, status)
       VALUES (?, ?, ?, ?)`,
    ).run("inst-bravo-87654321", "task-1", "agent-2", "waiting_delegation");

    const res = await fetch(`${baseUrl}/fragments/dashboard/running-instances`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.match(/class="cmd-agent"/g)?.length).toBe(2);
    expect(html).toContain("Analyst Agent");
    expect(html).toContain("waiting delegation");
    expect(html).toContain('href="/agents/agent-2"');
  });

  it("GET /fragments/dashboard/realtime-timeline renders newest-first timeline entries", async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO tasks (id, title, description, team_id, status, current_phase, task_type, task_config)
       VALUES (?, ?, ?, NULL, 'running', 0, 'real_time', '{}')`,
    ).run("task-rt-1", "Realtime Task", "rt");
    db.prepare(
      `INSERT INTO realtime_timeline (id, task_id, entry_type, content, created_at)
       VALUES (?, ?, 'text', ?, ?)`,
    ).run("rt-old", "task-rt-1", "older", "2026-01-01 10:00:00");
    db.prepare(
      `INSERT INTO realtime_timeline (id, task_id, entry_type, content, created_at)
       VALUES (?, ?, 'summary', ?, ?)`,
    ).run("rt-new", "task-rt-1", "latest", "2026-01-01 10:05:00");

    const res = await fetch(`${baseUrl}/fragments/dashboard/realtime-timeline`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("latest");
    expect(html).toContain("older");
    expect(html.indexOf("latest")).toBeLessThan(html.indexOf("older"));
  });

  it("fragment containers use stable IDs for WebSocket push", async () => {
    const res = await fetch(`${baseUrl}/fragments/tasks/list`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="task-list"');
  });

  it("GET /fragments/tasks/:id/artifacts launches task artifacts into the modal body", async () => {
    const res = await fetch(`${baseUrl}/fragments/tasks/task-1/artifacts`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('onclick="openTaskArtifactModal(); return false;"');
    expect(html).toContain('hx-target="#task-artifact-modal-body"');
    expect(html).not.toContain('hx-target="#artifact-detail"');
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
    expect(html).toContain("sk-badge--danger\">open");
    expect(html).toContain("agent-1".slice(0, 8));
    expect(html).toContain("task-1".slice(0, 8));
    expect(html).toContain("Should I proceed?");
  });
});
