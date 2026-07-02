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

// Artifact publishing is gated behind --experimental (isExperimental reads
// process.argv). Toggle the flag for the duration of a test, then restore it.
async function withExperimental(fn: () => Promise<void>): Promise<void> {
  process.argv.push("--experimental");
  try {
    await fn();
  } finally {
    const i = process.argv.indexOf("--experimental");
    if (i !== -1) process.argv.splice(i, 1);
  }
}

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

  // The v1 agent/team fragment routes (/fragments/agents/list,
  // /fragments/agents/:id/summary, /fragments/teams/list,
  // /fragments/teams/:id/members) were removed — config now edits agents/teams
  // inline. Their tests were removed with them.

  it("GET /teams/new redirects to the config team-create page (v1 page removed)", async () => {
    const res = await fetch(`${baseUrl}/teams/new`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/config/teams/new");
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

  it("POST /fragments/tasks/:id/artifacts/:name/publish publishes the version and shows the public URL", () => withExperimental(async () => {
    const db = getDb();
    const connectKey = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ gid: "guid-test", kind: "connect" })).toString("base64url")}.sig`;
    db.prepare(
      "INSERT INTO app_settings (key, value, value_type) VALUES ('skipper_connect_key', ?, 'string')",
    ).run(connectKey);
    // Public links require an operator-supplied remote URL (no built-in default).
    db.prepare(
      "INSERT INTO app_settings (key, value, value_type) VALUES ('skipper_connect_url', 'wss://connect.example.test', 'string')",
    ).run();

    const detailBefore = await (await fetch(`${baseUrl}/fragments/tasks/task-1/artifacts/plan?version=2`)).text();
    expect(detailBefore).toContain(">Publish<");
    expect(detailBefore).not.toContain("Unpublish");

    const res = await fetch(`${baseUrl}/fragments/tasks/task-1/artifacts/plan/publish?version=2`, { method: "POST" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Unpublish");
    expect(html).toContain('class="badge badge-published"');
    expect(html).toContain("https://connect.example.test/p/guid-test/artifact-2?key=");

    // Scoped to v2 only
    const v1 = db.prepare("SELECT published_at FROM task_artifacts WHERE id = 'artifact-1'").get() as { published_at: string | null };
    expect(v1.published_at).toBeNull();

    const unpublished = await (await fetch(`${baseUrl}/fragments/tasks/task-1/artifacts/plan/unpublish?version=2`, { method: "POST" })).text();
    expect(unpublished).toContain(">Publish<");
    expect(unpublished).not.toContain("badge-published");
  }));

  it("artifact list marks names that have any published version", () => withExperimental(async () => {
    const listBefore = await (await fetch(`${baseUrl}/fragments/tasks/task-1/artifacts`)).text();
    expect(listBefore).not.toContain("badge-published");

    const db = getDb();
    // Publish v1 only; the list shows latest (v2) but should still flag the name.
    db.prepare(
      "UPDATE task_artifacts SET publish_key = 'k1', published_at = datetime('now') WHERE id = 'artifact-1'",
    ).run();

    const listAfter = await (await fetch(`${baseUrl}/fragments/tasks/task-1/artifacts`)).text();
    expect(listAfter).toContain('title="Has a published version"');
  }));

  it("publish button is disabled when Skipper Connect is not configured", () => withExperimental(async () => {
    const db = getDb();
    db.exec("DELETE FROM app_settings WHERE key = 'skipper_connect_key'");
    const html = await (await fetch(`${baseUrl}/fragments/tasks/task-1/artifacts/plan`)).text();
    expect(html).toContain('disabled title="Configure Skipper Connect first"');
  }));

  it("hides the publish surface entirely when not experimental", async () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO app_settings (key, value, value_type) VALUES ('skipper_connect_key', ?, 'string')",
    ).run(`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ gid: "guid-test", kind: "connect" })).toString("base64url")}.sig`);
    const html = await (await fetch(`${baseUrl}/fragments/tasks/task-1/artifacts/plan`)).text();
    expect(html).not.toContain(">Publish<");
    expect(html).not.toContain("Unpublish");
  });
});
