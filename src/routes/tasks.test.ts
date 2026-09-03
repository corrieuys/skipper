import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startServer } from "../server";
import { registerTaskRoutes } from "./tasks";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { ArtifactManager } from "../orchestrator/artifact-manager";
import type { Server } from "bun";

let server: Server;
let baseUrl: string;

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);

  registerTaskRoutes();

  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  resetDb();
});

describe("POST /api/tasks", () => {
  it("redirects to dashboard after creating task", async () => {
    const body = new URLSearchParams({ title: "Test Task", workingDirectory: "/tmp/test" });
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("redirects to task creation page when title is missing", async () => {
    const body = new URLSearchParams({});
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/tasks/new");
  });

  it("shows the task list after creation", async () => {
    const task1 = new URLSearchParams({ title: "Fragment Task A", workingDirectory: "/tmp/test" });
    await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: task1.toString(),
      redirect: "manual",
    });

    const task2 = new URLSearchParams({ title: "Fragment Task B", workingDirectory: "/tmp/test" });
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: task2.toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    const db = getDb();
    const row = db.prepare("SELECT id FROM tasks WHERE title = ?").get("Fragment Task B") as { id: string } | null;
    expect(row).not.toBeNull();
  });

  it("keeps team assignment when creating a real-time task", async () => {
    const db = getDb();
    const teamId = crypto.randomUUID();
    db.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run(teamId, "Realtime Team");

    const body = new URLSearchParams({
      title: "Realtime Create Keep Team",
      taskType: "real_time",
      teamId,
      workingDirectory: "/tmp/test",
    });
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);

    const row = db.prepare("SELECT team_id, mode FROM tasks WHERE title = ?").get("Realtime Create Keep Team") as {
      team_id: string | null;
      mode: string;
    } | null;
    expect(row).not.toBeNull();
    // Legacy taskType=real_time maps onto the unified mode column.
    expect(row!.mode).toBe("conversational");
    expect(row!.team_id).toBe(teamId);
  });

  it("returns HX-Redirect to the command-center task view when creating a real-time task from HTMX", async () => {
    const db = getDb();
    const teamId = crypto.randomUUID();
    db.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run(teamId, "Realtime Team");

    const body = new URLSearchParams({
      title: "Realtime Create Redirect",
      taskType: "real_time",
      teamId,
      workingDirectory: "/tmp/test",
    });
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "HX-Request": "true",
      },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
    const redirect = res.headers.get("HX-Redirect");
    expect(redirect).toBeTruthy();
    // Legacy /realtime/:id retired: real-time tasks open in the v2 command center.
    expect(redirect!).toContain("/?task=");
  });

  it("returns HX-Redirect to standard task detail when creating a standard task from HTMX", async () => {
    const body = new URLSearchParams({
      title: "Standard Create Redirect",
      taskType: "standard",
      workingDirectory: "/tmp/test",
    });
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "HX-Request": "true",
      },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
    const redirect = res.headers.get("HX-Redirect");
    expect(redirect).toBeTruthy();
    expect(redirect!).toContain("/tasks/");
  });

  it("defaults to the Software team when no team is selected", async () => {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO teams (id, name) VALUES (?, ?)").run("software-default-a", "Software");
    db.prepare("INSERT OR IGNORE INTO teams (id, name) VALUES (?, ?)").run("software-default-b", "Platform");

    const body = new URLSearchParams({
      title: "Software Default Team Task",
      teamId: "",
      workingDirectory: "/tmp/test",
    });
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);

    const expectedDefaultTeam = db
      .prepare("SELECT id FROM teams WHERE lower(trim(name)) = 'software' ORDER BY name LIMIT 1")
      .get() as { id: string } | null;
    const created = db
      .prepare("SELECT team_id FROM tasks WHERE title = ? ORDER BY rowid DESC LIMIT 1")
      .get("Software Default Team Task") as { team_id: string | null } | null;

    expect(expectedDefaultTeam).not.toBeNull();
    expect(created).not.toBeNull();
    expect(created!.team_id).toBe(expectedDefaultTeam!.id);
  });
});

describe("GET /api/tasks", () => {
  it("returns JSON list of tasks", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("POST /api/tasks/:id/approve", () => {
  it("returns JSON ok after approving a draft task", async () => {
    const db = getDb();
    const teamId = crypto.randomUUID();
    db.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run(teamId, "Test Team");

    const body = new URLSearchParams({ title: "Task to approve", teamId, workingDirectory: "/tmp/test" });
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });
    expect(createRes.status).toBe(302);

    // Get the task ID from the database
    const tasks = db.prepare("SELECT id FROM tasks WHERE title = ?").all("Task to approve") as { id: string }[];
    const taskId = tasks[tasks.length - 1].id;

    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    const body2 = await res.json();
    expect(body2.ok).toBe(true);
  });

  it("returns JSON error for unknown task id", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent/approve`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns JSON error for HTMX approve failure", async () => {
    const db = getDb();
    const taskId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO tasks (id, title, description, status, team_id) VALUES (?, ?, ?, 'draft', NULL)",
    ).run(taskId, "Unassigned draft task", "No team assigned");

    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/approve`, {
      method: "POST",
      headers: { "HX-Request": "true" },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

describe("POST /api/tasks/:id/cancel", () => {
  it("archives an active task with a cancellation error", async () => {
    const db = getDb();
    const taskId = crypto.randomUUID();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, 'active')").run(taskId, "Task to cancel");

    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    const row = db.prepare("SELECT status, result FROM tasks WHERE id = ?").get(taskId) as { status: string; result: string | null } | null;
    expect(row?.status).toBe("settled");
    expect(JSON.parse(row!.result!).error).toBe("Cancelled by user");
  });

  it("returns JSON error for unknown task id", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent/cancel`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

describe("POST /api/tasks/:id/retry", () => {
  it("returns 410 Gone pointing at the input endpoint", async () => {
    const db = getDb();
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, 'settled')").run(id, "Task to retry");

    const res = await fetch(`${baseUrl}/api/tasks/${id}/retry`, { method: "POST" });
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.error).toContain("input");

    // Retry never mutates the task anymore.
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string } | null;
    expect(row?.status).toBe("settled");
  });

  it("returns 410 for unknown task id too", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent/retry`, { method: "POST" });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

describe("POST /api/tasks/:id/resume", () => {
  it("unarchives an archived task and queues a wake", async () => {
    const db = getDb();
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO tasks (id, title, status, current_phase, result) VALUES (?, ?, 'settled', ?, ?)")
      .run(id, "Task to resume", 1, JSON.stringify({ error: "boom" }));

    const res = await fetch(`${baseUrl}/api/tasks/${id}/resume`, { method: "POST" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    const row = db.prepare("SELECT status, current_phase, wake_requested_at FROM tasks WHERE id = ?").get(id) as {
      status: string;
      current_phase: number;
      wake_requested_at: string | null;
    } | null;
    expect(row?.status).toBe("active");
    expect(row?.current_phase).toBe(1);
    expect(row?.wake_requested_at).not.toBeNull();
  });

  it("clears the paused flag on a paused task", async () => {
    const db = getDb();
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO tasks (id, title, status, paused, started_at) VALUES (?, ?, 'active', 1, datetime('now'))")
      .run(id, "Paused task to resume");

    const res = await fetch(`${baseUrl}/api/tasks/${id}/resume`, { method: "POST" });
    expect(res.status).toBe(200);

    const row = db.prepare("SELECT status, paused FROM tasks WHERE id = ?").get(id) as { status: string; paused: number } | null;
    expect(row?.status).toBe("active");
    expect(row?.paused).toBe(0);
  });

  it("409s for a task that is neither paused nor archived", async () => {
    const db = getDb();
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, 'draft')").run(id, "Draft not resumable");

    const res = await fetch(`${baseUrl}/api/tasks/${id}/resume`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 404 for unknown task id", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent/resume`, { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

describe("POST /api/tasks/:id/delete", () => {
  it("returns JSON ok after deleting a non-running task", async () => {
    const body = new URLSearchParams({ title: "Task to delete via route", workingDirectory: "/tmp/test" });
    await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });

    const db = getDb();
    const tasks = db.prepare("SELECT id FROM tasks WHERE title = ?").all("Task to delete via route") as { id: string }[];
    const taskId = tasks[tasks.length - 1].id;

    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/delete`, { method: "POST" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    const deleted = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId) as { id: string } | null;
    expect(deleted).toBeNull();
  });

  it("returns JSON error for unknown task id", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent/delete`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

describe("POST /api/tasks/:id", () => {
  it("updates a draft task and returns JSON", async () => {
    const createBody = new URLSearchParams({ title: "Task to edit", workingDirectory: "/tmp/test" });
    await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: createBody.toString(),
    });

    const db = getDb();
    const tasks = db.prepare("SELECT id FROM tasks WHERE title = ?").all("Task to edit") as { id: string }[];
    const taskId = tasks[tasks.length - 1].id;

    const res = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Task edited",
        description: "Updated description",
        teamId: "",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("Task edited");
    expect(body.description).toBe("Updated description");
  });

  it("returns 400 when trying to edit a non-draft task", async () => {
    const db = getDb();
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run(id, "Locked Task", "active");

    const res = await fetch(`${baseUrl}/api/tasks/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Should fail" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Can only edit draft tasks");
  });
});

describe("Artifact REST API", () => {
  let taskId: string;
  let artifactManager: ArtifactManager;

  beforeAll(() => {
    const db = getDb();
    taskId = crypto.randomUUID();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run(taskId, "Artifact Test Task", "active");
    artifactManager = new ArtifactManager(db);
  });

  it("GET /api/tasks/:id/artifacts returns artifacts list", async () => {
    artifactManager.createArtifact({ taskId, name: "art-a", kind: "plan", body: "body-a" });
    artifactManager.createArtifact({ taskId, name: "art-b", kind: "summary", body: "body-b" });

    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/artifacts`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.artifacts)).toBe(true);
    expect(json.artifacts.length).toBeGreaterThanOrEqual(2);
    // body should NOT be included in list items
    for (const item of json.artifacts) {
      expect(item.body).toBeUndefined();
    }
  });

  it("GET /api/tasks/:id/artifacts filters by kind", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/artifacts?kind=plan`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.artifacts.length).toBeGreaterThanOrEqual(1);
    for (const item of json.artifacts) {
      expect(item.kind).toBe("plan");
    }
  });

  it("GET /api/tasks/:id/artifacts filters by name prefix", async () => {
    const tid = crypto.randomUUID();
    const db = getDb();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run(tid, "Name Prefix Task", "active");
    artifactManager.createArtifact({ taskId: tid, name: "analysis-1", kind: "other", body: "a1" });
    artifactManager.createArtifact({ taskId: tid, name: "analysis-2", kind: "other", body: "a2" });
    artifactManager.createArtifact({ taskId: tid, name: "summary", kind: "summary", body: "s1" });

    const res = await fetch(`${baseUrl}/api/tasks/${tid}/artifacts?name=analysis`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.artifacts.length).toBe(2);
  });

  it("GET /api/tasks/:id/artifacts respects limit", async () => {
    const tid = crypto.randomUUID();
    const db = getDb();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run(tid, "Limit Task", "active");
    for (let i = 0; i < 5; i++) {
      artifactManager.createArtifact({ taskId: tid, name: `item-${i}`, kind: "other", body: `body-${i}` });
    }

    const res = await fetch(`${baseUrl}/api/tasks/${tid}/artifacts?limit=2`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.artifacts.length).toBe(2);
  });

  it("GET /api/tasks/:id/artifacts/:name returns latest version", async () => {
    const tid = crypto.randomUUID();
    const db = getDb();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run(tid, "Version Task", "active");
    artifactManager.createArtifact({ taskId: tid, name: "versioned", kind: "plan", body: "v1-body" });
    artifactManager.createArtifact({ taskId: tid, name: "versioned", kind: "plan", body: "v2-body" });
    artifactManager.createArtifact({ taskId: tid, name: "versioned", kind: "plan", body: "v3-body" });

    const res = await fetch(`${baseUrl}/api/tasks/${tid}/artifacts/versioned`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.version).toBe(3);
    expect(json.body).toBe("v3-body");
  });

  it("GET /api/tasks/:id/artifacts/:name returns specific version", async () => {
    const tid = crypto.randomUUID();
    const db = getDb();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run(tid, "Specific Version Task", "active");
    artifactManager.createArtifact({ taskId: tid, name: "spec-ver", kind: "other", body: "first" });
    artifactManager.createArtifact({ taskId: tid, name: "spec-ver", kind: "other", body: "second" });
    artifactManager.createArtifact({ taskId: tid, name: "spec-ver", kind: "other", body: "third" });

    const res = await fetch(`${baseUrl}/api/tasks/${tid}/artifacts/spec-ver?version=1`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.version).toBe(1);
    expect(json.body).toBe("first");
  });

  it("GET /api/tasks/:id/artifacts/:name returns 404 for missing artifact", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/artifacts/nonexistent`);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeDefined();
  });

  it("GET /api/tasks/:id/artifacts/:name/versions returns version list", async () => {
    const tid = crypto.randomUUID();
    const db = getDb();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run(tid, "Versions List Task", "active");
    artifactManager.createArtifact({ taskId: tid, name: "multi-ver", kind: "summary", body: "v1" });
    artifactManager.createArtifact({ taskId: tid, name: "multi-ver", kind: "summary", body: "v2" });
    artifactManager.createArtifact({ taskId: tid, name: "multi-ver", kind: "summary", body: "v3" });

    const res = await fetch(`${baseUrl}/api/tasks/${tid}/artifacts/multi-ver/versions`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.versions)).toBe(true);
    expect(json.versions.length).toBe(3);
    // Should be ordered descending by version
    expect(json.versions[0].version).toBe(3);
    expect(json.versions[1].version).toBe(2);
    expect(json.versions[2].version).toBe(1);
    // body should NOT be in version items
    for (const v of json.versions) {
      expect(v.body).toBeUndefined();
    }
  });
});

describe("Realtime session endpoints", () => {
  // The task_type guard is gone: sessions are valid for ANY task; only the
  // active-status rule and daemon availability gate the start.

  it("POST .../session/start returns 400 for a non-active task", async () => {
    const db = getDb();
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, 'draft')").run(id, "Draft Task");

    const res = await fetch(`${baseUrl}/api/tasks/${id}/realtime/session/start`, { method: "POST" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("active");
  });

  it("POST .../session/start accepts a workflow-mode active task (503 without daemon, status untouched)", async () => {
    const db = getDb();
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO tasks (id, title, status, mode) VALUES (?, ?, 'active', 'workflow')").run(id, "Workflow Active");

    const res = await fetch(`${baseUrl}/api/tasks/${id}/realtime/session/start`, { method: "POST" });
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("Daemon not available");

    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string } | null;
    expect(row!.status).toBe("active");
  });

  it("POST .../session/start returns 503 when daemon not available for a conversational task", async () => {
    const db = getDb();
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO tasks (id, title, status, mode) VALUES (?, ?, 'active', 'conversational')").run(id, "RT Active No Daemon");

    const res = await fetch(`${baseUrl}/api/tasks/${id}/realtime/session/start`, { method: "POST" });
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("Daemon not available");
  });

  it("POST .../session/stop has no mode guard and returns 503 without daemon", async () => {
    const db = getDb();
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO tasks (id, title, status, mode) VALUES (?, ?, 'active', 'workflow')").run(id, "Workflow Stop");

    const res = await fetch(`${baseUrl}/api/tasks/${id}/realtime/session/stop`, { method: "POST" });
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("Daemon not available");
  });

  it("POST .../session/start returns 404 for unknown task", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent-id/realtime/session/start`, { method: "POST" });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("not found");
  });

  it("POST .../session/stop returns 404 for unknown task", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent-id/realtime/session/stop`, { method: "POST" });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("not found");
  });
});
