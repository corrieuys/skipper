import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { startServer } from "../../server";
import { getDb, initializeDatabase, resetDb } from "../../db/connection";
import { registerDataGlobalStoreRoutes } from "./global-store";
import { createTestApiKey } from "./test-helpers";

let server: Server<unknown>;
let baseUrl: string;
let headers: Record<string, string>;

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);
  registerDataGlobalStoreRoutes();
  headers = { ...createTestApiKey(db).headers, "Content-Type": "application/json" };
  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  resetDb();
});

describe("global store data API", () => {
  it("sets, gets, lists by prefix, and deletes", async () => {
    for (const [key, data] of [["team/alpha", "a"], ["team/beta", "b"], ["other", "c"]] as const) {
      const res = await fetch(`${baseUrl}/data/global-store`, {
        method: "POST",
        headers,
        body: JSON.stringify({ key, data, type: "test" }),
      });
      expect(res.status).toBe(200);
    }

    const one = await (await fetch(`${baseUrl}/data/global-store/team%2Falpha`, { headers })).json() as {
      data: { name: string; data: string; updated_by_agent_id: string };
    };
    expect(one.data.data).toBe("a");
    expect(one.data.updated_by_agent_id).toBe("api");

    const prefixed = await (await fetch(`${baseUrl}/data/global-store?key=team/`, { headers })).json() as {
      data: Array<{ name: string }>;
    };
    expect(prefixed.data.map((r) => r.name).sort()).toEqual(["team/alpha", "team/beta"]);

    const del = await fetch(`${baseUrl}/data/global-store/other`, { method: "DELETE", headers });
    expect(del.status).toBe(200);
    const gone = await fetch(`${baseUrl}/data/global-store/other`, { headers });
    expect(gone.status).toBe(404);
  });

  it("partial update preserves untouched columns", async () => {
    await fetch(`${baseUrl}/data/global-store`, {
      method: "POST",
      headers,
      body: JSON.stringify({ key: "partial", data: "original", status: "active" }),
    });
    await fetch(`${baseUrl}/data/global-store`, {
      method: "POST",
      headers,
      body: JSON.stringify({ key: "partial", status: "done" }),
    });
    const row = await (await fetch(`${baseUrl}/data/global-store/partial`, { headers })).json() as {
      data: { data: string; status: string };
    };
    expect(row.data.data).toBe("original");
    expect(row.data.status).toBe("done");
  });

  it("requires a key on set", async () => {
    const res = await fetch(`${baseUrl}/data/global-store`, {
      method: "POST",
      headers,
      body: JSON.stringify({ data: "x" }),
    });
    expect(res.status).toBe(400);
  });
});
