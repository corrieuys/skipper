import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { startServer } from "../../server";
import { getDb, initializeDatabase, resetDb } from "../../db/connection";
import { registerDataTeamRoutes } from "./teams";
import { createTestApiKey } from "./test-helpers";
import { getLocalTeam } from "../../teams/local-teams";

let server: Server<unknown>;
let baseUrl: string;
let headers: Record<string, string>;

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);

  registerDataTeamRoutes(db);

  const auth = createTestApiKey(db).headers;
  headers = { ...auth, "Content-Type": "application/json" };

  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  resetDb();
});

describe("teams CRUD via /data", () => {
  it("creates, updates and deletes a team", async () => {
    const createRes = await fetch(`${baseUrl}/data/teams`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "data-team",
        name: "Data Team",
        skipper_prompt: "do the thing",
        phases: [{ name: "Build", prompt: "build it" }],
        agents: [{ id: "worker", name: "Worker", type: "claude-code", model: "default" }],
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.ok).toBe(true);
    expect(created.data.name).toBe("Data Team");
    expect(getLocalTeam(getDb(), "data-team")).not.toBeNull();

    const updateRes = await fetch(`${baseUrl}/data/teams/data-team`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: "Data Team v2",
        skipper_prompt: "do the thing better",
        phases: [{ name: "Build", prompt: "build it" }],
        agents: [{ id: "worker", name: "Worker", type: "claude-code", model: "default" }],
      }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.data.name).toBe("Data Team v2");

    const deleteRes = await fetch(`${baseUrl}/data/teams/data-team`, { method: "DELETE", headers });
    expect(deleteRes.status).toBe(200);
    expect(getLocalTeam(getDb(), "data-team")).toBeNull();
  });

  it("rejects invalid JSON on create", async () => {
    const res = await fetch(`${baseUrl}/data/teams`, { method: "POST", headers, body: "{nope" });
    expect(res.status).toBe(400);
  });

  it("404s update and delete on unknown teams", async () => {
    const upd = await fetch(`${baseUrl}/data/teams/nope`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ name: "x" }),
    });
    expect(upd.status).toBe(404);
    const del = await fetch(`${baseUrl}/data/teams/nope`, { method: "DELETE", headers });
    expect(del.status).toBe(404);
  });
});
