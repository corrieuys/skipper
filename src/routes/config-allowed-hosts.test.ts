import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { addRoute, startServer, setConfiguredAllowedHosts } from "../server";
import { registerPageRoutes } from "./pages";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { getAllowedHosts } from "../config/allowed-hosts";

// The config page's Allowed Hosts section end to end: the Save route, its
// in-place self-swap, and the running gate picking the list up with no restart.

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
  // Our own probe: other route tests empty the shared route table (teams.test.ts
  // sets routes.length = 0), which takes the module-level /health with it.
  addRoute("GET", "/__gate-probe", () => new Response("ok"));
  server = startServer(0);
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  setConfiguredAllowedHosts([]);
  resetDb();
});

/** The section's Save, as htmx posts it (form-encoded, HX-Request). */
function saveHosts(hosts: string): Promise<Response> {
  return fetch(`${baseUrl}/api/config/allowed-hosts`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "HX-Request": "true" },
    body: new URLSearchParams({ hosts }).toString(),
  });
}

/** A plain read that names `host` in the Host header, as a browser opening Skipper by that name would. */
async function statusAs(host: string): Promise<number> {
  return (await fetch(`${baseUrl}/__gate-probe`, { headers: { Host: `${host}:${server.port}` } })).status;
}

describe("POST /api/config/allowed-hosts", () => {
  it("returns the re-rendered section for the htmx self-swap, never a redirect", async () => {
    const res = await saveHosts("My-Box.test:5005\nother-box.test");
    expect(res.status).toBe(200);
    expect(res.headers.get("HX-Redirect")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    // Just the section (the swap target itself), not a page.
    expect(html).toStartWith('<div id="sk-allowed-hosts-panel"');
    expect(html).not.toContain("<html");
    expect(html).toContain('hx-target="#sk-allowed-hosts-panel"');
    expect(html).toContain('hx-swap="outerHTML"');
    expect(html).toContain("my-box.test\nother-box.test</textarea>");
    expect(html).toContain("Saved.");
    expect(getAllowedHosts(getDb())).toEqual(["my-box.test", "other-box.test"]);
  });

  it("shows refused entries inline, keeps the typed text, and saves nothing", async () => {
    await saveHosts("keep-box.test");
    const res = await saveHosts("new-box.test, 10.0.0.5, *.test");
    expect(res.status).toBe(200); // htmx only swaps a 2xx
    const html = await res.text();
    expect(html).toStartWith('<div id="sk-allowed-hosts-panel"');
    expect(html).toContain("Not saved");
    expect(html).toContain("10.0.0.5: IP addresses are always allowed");
    expect(html).toContain("*.test: wildcards are not supported");
    expect(html).toContain("new-box.test, 10.0.0.5, *.test</textarea>");
    expect(html).not.toContain("Saved.");
    expect(getAllowedHosts(getDb())).toEqual(["keep-box.test"]);
  });

  it("answers JSON callers with the list, or 400 with the errors", async () => {
    const ok = await fetch(`${baseUrl}/api/config/allowed-hosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hosts: ["Json-Box.test", "json-box.test:443"] }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ hosts: ["json-box.test"] });

    const bad = await fetch(`${baseUrl}/api/config/allowed-hosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hosts: "https://json-box.test" }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { errors: string[] }).errors).toHaveLength(1);

    // A call without the field is refused rather than read as "clear the list".
    const missing = await fetch(`${baseUrl}/api/config/allowed-hosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(400);
    expect(getAllowedHosts(getDb())).toEqual(["json-box.test"]);
  });

  it("the running gate accepts a saved host without a restart, and refuses it once deleted", async () => {
    await saveHosts("");
    expect(await statusAs("gate-box.test")).toBe(403);

    await saveHosts("gate-box.test");
    expect(await statusAs("gate-box.test")).toBe(200);
    expect(await statusAs("unlisted-box.test")).toBe(403);

    await saveHosts("");
    expect(await statusAs("gate-box.test")).toBe(403);
  });

  it("a refused save leaves the gate as it was", async () => {
    await saveHosts("gate-box.test");
    await saveHosts("gate-box.test\nsecond-box.test\n*.test");
    expect(await statusAs("gate-box.test")).toBe(200);
    expect(await statusAs("second-box.test")).toBe(403);
    await saveHosts("");
  });
});

describe("GET /config", () => {
  it("renders the Allowed Hosts section without --experimental", async () => {
    expect(process.argv.includes("--experimental")).toBe(false);
    const html = await (await fetch(`${baseUrl}/config`)).text();
    expect(html).toContain('<div id="sk-allowed-hosts-panel"');
    expect(html).toContain('hx-post="/api/config/allowed-hosts"');
    expect(html).toContain("SKIPPER_ALLOWED_HOSTS");
  });
});
