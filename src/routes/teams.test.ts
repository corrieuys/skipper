import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { startServer } from "../server";
import { registerTeamRoutes } from "./teams";
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

  registerTeamRoutes(db);

  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  db.close();
});

describe("POST /api/teams - JSON API", () => {
  it("creates a team and returns JSON when no HX-Request header", async () => {
    const res = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alpha Team", goal: "Ship fast" }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.name).toBe("Alpha Team");
    expect(body.goal).toBe("Ship fast");
  });

  it("returns 400 when name is missing", async () => {
    const res = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "No name" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("name is required");
  });
});

describe("POST /api/teams - HTMX form submission", () => {
  it("returns HTML team list fragment when HX-Request header is present", async () => {
    const formData = new URLSearchParams();
    formData.set("name", "Beta Team");
    formData.set("goal", "Iterate quickly");

    const res = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "HX-Request": "true",
      },
      body: formData.toString(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Beta Team");
    expect(body).not.toContain("<!DOCTYPE html");
  });

  it("returns HTML with empty state when no teams after creating (edge case: all teams listed)", async () => {
    const formData = new URLSearchParams();
    formData.set("name", "Gamma Team");

    const res = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "HX-Request": "true",
      },
      body: formData.toString(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    // Should contain the new team in a table
    expect(body).toContain("Gamma Team");
    expect(body).toContain("data-table");
  });
});

describe("POST /api/teams/:id/agents - JSON API", () => {
  it("returns 400 when agent_id is missing", async () => {
    // Create a team first
    const teamRes = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Delta Team" }),
    });
    const team = await teamRes.json();

    const res = await fetch(`${baseUrl}/api/teams/${team.id}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "lead" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("agent_id is required");
  });

  it("returns 400 when agent does not exist", async () => {
    const teamRes = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Epsilon Team" }),
    });
    const team = await teamRes.json();

    const res = await fetch(`${baseUrl}/api/teams/${team.id}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "nonexistent-agent-id" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Agent not found");
  });
});

describe("POST /api/teams/:id/agents - HTMX form submission", () => {
  it("returns full HTML team detail page when HX-Request header is present", async () => {
    // Create a team
    const teamRes = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Zeta Team" }),
    });
    const team = await teamRes.json();

    // Create an agent in the DB so we can add it
    db.prepare(
      `INSERT INTO agents (id, name, type, model, status, config, capabilities)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("test-agent-fe05", "Test Agent FE05", "claude-code", "default", "idle", "{}", "[]");

    const formData = new URLSearchParams();
    formData.set("agent_id", "test-agent-fe05");
    formData.set("role", "developer");

    const res = await fetch(`${baseUrl}/api/teams/${team.id}/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "HX-Request": "true",
      },
      body: formData.toString(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    // Should contain full page (layout)
    expect(body).toContain("<!DOCTYPE html");
    expect(body).toContain("Zeta Team");
    // Should show the new agent member
    expect(body).toContain("Test Agent FE05");
  });
});

describe("POST /api/teams/:id/phases", () => {
  it("adds a phase and returns JSON when no HX-Request header", async () => {
    const teamRes = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Phase Test Team A" }),
    });
    const team = await teamRes.json();

    const res = await fetch(`${baseUrl}/api/teams/${team.id}/phases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Planning", prompt: "Plan the work carefully" }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.phases).toHaveLength(1);
    expect(body.phases[0].name).toBe("Planning");
    expect(body.phases[0].prompt).toBe("Plan the work carefully");
  });

  it("returns 400 when name or prompt is missing", async () => {
    const teamRes = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Phase Test Team B" }),
    });
    const team = await teamRes.json();

    const res = await fetch(`${baseUrl}/api/teams/${team.id}/phases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Only name" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("required");
  });

  it("returns full HTML team detail page for HTMX requests", async () => {
    const teamRes = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Phase Test Team C" }),
    });
    const team = await teamRes.json();

    const formData = new URLSearchParams();
    formData.set("name", "Execution");
    formData.set("prompt", "Execute the plan step by step");

    const res = await fetch(`${baseUrl}/api/teams/${team.id}/phases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "HX-Request": "true",
      },
      body: formData.toString(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html");
    expect(body).toContain("Phase Test Team C");
    expect(body).toContain("Execution");
    expect(body).toContain("Execute the plan step by step");
  });
});

describe("POST /api/teams/:id", () => {
  it("updates team name and goal and returns JSON", async () => {
    const teamRes = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Editable Team", goal: "Before" }),
    });
    const team = await teamRes.json();

    const res = await fetch(`${baseUrl}/api/teams/${team.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Edited Team", goal: "After" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Edited Team");
    expect(body.goal).toBe("After");
  });

  it("returns full HTML team detail for HTMX requests", async () => {
    const teamRes = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "HTMX Edit Team", goal: "Old Goal" }),
    });
    const team = await teamRes.json();

    const formData = new URLSearchParams();
    formData.set("name", "HTMX Edited Team");
    formData.set("goal", "New Goal");

    const res = await fetch(`${baseUrl}/api/teams/${team.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "HX-Request": "true",
      },
      body: formData.toString(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html");
    expect(body).toContain("HTMX Edited Team");
    expect(body).toContain("New Goal");
  });
});

describe("POST /api/teams/:id/entrypoint", () => {
  it("returns full HTML team detail for HTMX requests", async () => {
    const teamRes = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Entrypoint Team" }),
    });
    const team = await teamRes.json();

    db.prepare(
      `INSERT INTO agents (id, name, type, model, status, config, capabilities)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("entry-agent-01", "Entrypoint Agent", "codex", "default", "idle", "{}", "[]");

    await fetch(`${baseUrl}/api/teams/${team.id}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "entry-agent-01" }),
    });

    const formData = new URLSearchParams();
    formData.set("agent_id", "entry-agent-01");

    const res = await fetch(`${baseUrl}/api/teams/${team.id}/entrypoint`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "HX-Request": "true",
      },
      body: formData.toString(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html");
    expect(body).toContain("Entrypoint Team");
    expect(body).toContain("Entrypoint Agent");
  });
});

describe("DELETE /api/teams/:id/phases/:index", () => {
  it("removes a phase by index and returns JSON", async () => {
    const teamRes = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Delete Phase Team A" }),
    });
    const team = await teamRes.json();

    // Add two phases first
    await fetch(`${baseUrl}/api/teams/${team.id}/phases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Phase 1", prompt: "Do it" }),
    });
    await fetch(`${baseUrl}/api/teams/${team.id}/phases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Phase 2", prompt: "Do more" }),
    });

    const res = await fetch(`${baseUrl}/api/teams/${team.id}/phases/0`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.phases).toHaveLength(1);
    expect(body.phases[0].name).toBe("Phase 2");
  });

  it("returns 400 for invalid phase index", async () => {
    const teamRes = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Delete Phase Team B" }),
    });
    const team = await teamRes.json();

    const res = await fetch(`${baseUrl}/api/teams/${team.id}/phases/99`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid phase index");
  });

  it("returns HTML for HTMX requests after deleting a phase", async () => {
    const teamRes = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Delete Phase Team C" }),
    });
    const team = await teamRes.json();

    await fetch(`${baseUrl}/api/teams/${team.id}/phases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Phase A", prompt: "Do A" }),
    });

    const res = await fetch(`${baseUrl}/api/teams/${team.id}/phases/0`, {
      method: "DELETE",
      headers: { "HX-Request": "true" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html");
    expect(body).toContain("Delete Phase Team C");
    expect(body).toContain("No phases defined");
  });
});

describe("teamListFragment in components", () => {
  it("renders teamListFragment separately for HTMX usage", async () => {
    // Verify that the HTMX response does NOT include the full page layout
    const formData = new URLSearchParams();
    formData.set("name", "Fragment Test Team");

    const res = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "HX-Request": "true",
      },
      body: formData.toString(),
    });
    const body = await res.text();
    // Fragment should NOT include the full layout (nav, head, etc.)
    expect(body).not.toContain("<nav");
    expect(body).not.toContain("<head");
    // But should have the table content
    expect(body).toContain("Fragment Test Team");
  });
});
