import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startServer } from "../server";
import { registerAgentRoutes } from "./agents";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import type { Server } from "bun";

let server: Server;
let baseUrl: string;

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);

  registerAgentRoutes();

  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  resetDb();
});

describe("POST /api/agents/:id", () => {
  it("updates an agent and returns JSON", async () => {
    const create = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Editable Agent",
        model: "default",
        instruction: "Before",
      }),
    });

    expect(create.status).toBe(201);
    const listRes = await fetch(`${baseUrl}/api/agents`);
    const agents = await listRes.json();
    const created = agents.find((agent: { name: string }) => agent.name === "Editable Agent");
    expect(created).toBeDefined();

    const update = await fetch(`${baseUrl}/api/agents/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Edited Agent",
        model: "default",
        instruction: "After",
      }),
    });
    expect(update.status).toBe(200);
    const body = await update.json();
    expect(body.name).toBe("Edited Agent");
    expect(body.config.instruction).toBe("After");
  });

  it("returns full HTML detail page for HTMX requests", async () => {
    const create = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "HTMX Agent",
      }),
    });
    expect(create.status).toBe(201);

    const listRes = await fetch(`${baseUrl}/api/agents`);
    const agents = await listRes.json();
    const created = agents.find((agent: { name: string }) => agent.name === "HTMX Agent");
    expect(created).toBeDefined();

    const formData = new URLSearchParams();
    formData.set("name", "HTMX Agent Edited");
    formData.set("model", "default");
    formData.set("instruction", "New Goal");

    const update = await fetch(`${baseUrl}/api/agents/${created.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "HX-Request": "true",
      },
      body: formData.toString(),
    });
    expect(update.status).toBe(200);
    expect(update.headers.get("content-type")).toContain("text/html");
    const html = await update.text();
    expect(html).toContain("<!DOCTYPE html");
    expect(html).toContain("HTMX Agent Edited");
    expect(html).toContain("New Goal");
  });

  it("rejects legacy goal field", async () => {
    const create = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Legacy Goal Agent",
        goal: "Old field",
      }),
    });
    expect(create.status).toBe(400);
    const body = await create.json();
    expect(body.error).toContain("goal is no longer supported");
  });
});
