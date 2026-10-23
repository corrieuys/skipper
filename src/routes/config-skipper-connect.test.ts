import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { startServer } from "../server";
import { registerPageRoutes } from "./pages";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { getStringSetting, SETTING_SKIPPER_CONNECT_URL } from "../config/app-settings";
import { getConnectKey } from "../connect/connect-key";

// The config page's Skipper Connect Save: a URL that would send the instance
// key unencrypted is refused before anything is stored.

let server: Server<unknown>;
let baseUrl: string;

beforeAll(() => {
  resetDb();
  initializeDatabase(getDb(":memory:"));
  registerPageRoutes({
    getStatus: () => ({ state: "running", uptime: 100 }),
    getEscalationManager: () => ({
      reconcileOpenEscalationsForInactiveTasks: () => {},
      resolveEscalation: async () => {},
    }),
    listRuntimeSteeringOptions: () => [],
  } as never);
  server = startServer(0);
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  resetDb();
});

function save(url: string, key: string): Promise<Response> {
  return fetch(`${baseUrl}/api/config/skipper-connect`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "HX-Request": "true" },
    body: new URLSearchParams({ url, key }).toString(),
  });
}

describe("POST /api/config/skipper-connect", () => {
  it("refuses a plain ws:// URL to a remote host and stores nothing", async () => {
    const res = await save("ws://connect.example.com", "k-insecure");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("wss://");
    const db = getDb();
    expect(getStringSetting(db, SETTING_SKIPPER_CONNECT_URL, "")).toBe("");
    expect(getConnectKey(db)).toBe("");
  });

  it("stores a wss:// URL and the key", async () => {
    const res = await save("wss://connect.example.com", "k-good");
    expect(res.status).toBe(204);
    const db = getDb();
    expect(getStringSetting(db, SETTING_SKIPPER_CONNECT_URL, "")).toBe("wss://connect.example.com");
    expect(getConnectKey(db)).toBe("k-good");
  });
});
