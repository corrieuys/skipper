import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { Server } from "bun";
import { startServer } from "../server";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { registerGlyphRoutes } from "./glyph";
import { GlyphEngine } from "../glyph/engine";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let server: Server<unknown>;
let baseUrl: string;
let engine: GlyphEngine;
let wd: string;

function setExperimental(on: boolean): void {
  const idx = process.argv.indexOf("--experimental");
  if (on && idx === -1) process.argv.push("--experimental");
  if (!on && idx !== -1) process.argv.splice(idx, 1);
}

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);
  wd = mkdtempSync(join(tmpdir(), "glyph-route-"));
  writeFileSync(join(wd, "index.html"), "<h1>proto</h1><link rel=stylesheet href=style.css>");
  writeFileSync(join(wd, "style.css"), "h1{color:red}");
  db.prepare("INSERT INTO tasks (id, title, status, working_directory) VALUES ('t1', 'Task', 'active', ?)").run(wd);
  db.prepare("INSERT INTO task_artifacts (id, task_id, name, version, kind, body, format) VALUES ('a1', 't1', 'page', 1, 'other', '<p>hi</p>', 'html')").run();
  db.prepare("INSERT INTO task_artifacts (id, task_id, name, version, kind, body, format) VALUES ('a2', 't1', 'notes', 1, 'other', '# md <b>', 'markdown')").run();
  db.prepare("INSERT INTO task_artifacts (id, task_id, name, version, kind, body, storage, mime) VALUES ('a3', 't1', 'shot.png', 1, 'upload', '', 'file', 'image/png')").run();
  engine = new GlyphEngine(db, { broadcastJson() {}, hasJsonClients: () => false }, {
    runner: async () => ({ text: '```glyph\nRENDER ra[tb"hi"]\n```', sessionId: "s" }),
    debounceMs: 1,
  });
  registerGlyphRoutes(engine, db);
  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  setExperimental(false);
  engine.stop();
  server.stop(true);
  resetDb();
  rmSync(wd, { recursive: true, force: true });
});

beforeEach(() => setExperimental(true));

describe("glyph routes", () => {
  it("404 without the experimental flag", async () => {
    setExperimental(false);
    expect((await fetch(`${baseUrl}/api/tasks/t1/glyph`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/tasks/t1/glyph/open`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/tasks/t1/glyph/reset`, { method: "POST" })).status).toBe(404);
  });

  it("open returns the status and triggers the first render", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/t1/glyph/open`, { method: "POST" });
    expect(res.status).toBe(200);
    const st = await res.json() as { frame: string; state: string };
    expect(st.frame).toBe("");
    await new Promise((r) => setTimeout(r, 30));
    const after = await (await fetch(`${baseUrl}/api/tasks/t1/glyph`)).json() as { frame: string; state: string; calls: number };
    expect(after.frame).toBe('ra[tb"hi"]');
    expect(after.state).toBe("idle");
    expect(after.calls).toBe(1);
  });

  it("reset clears and re-renders", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/t1/glyph/reset`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { frame: string }).frame).toBe("");
    await new Promise((r) => setTimeout(r, 30));
    const after = await (await fetch(`${baseUrl}/api/tasks/t1/glyph`)).json() as { frame: string };
    expect(after.frame).toBe('ra[tb"hi"]');
  });
});

describe("glyph web view sources", () => {
  it("serves an html artifact in the shell and markdown through marked", async () => {
    const html = await fetch(`${baseUrl}/api/artifacts/a1/view`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain('<div class="art"><p>hi</p></div>');
    const md = await fetch(`${baseUrl}/api/artifacts/a2/view`);
    const body = await md.text();
    expect(body).toContain('<pre id="src"');
    expect(body).toContain("# md &lt;b&gt;");
    expect(body).toContain("marked.min.js");
    expect((await fetch(`${baseUrl}/api/artifacts/a3/view`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/artifacts/nope/view`)).status).toBe(404);
  });

  it("serves files inside the task working directory, with relative assets, and nothing outside", async () => {
    const enc = (p: string) => p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const page = await fetch(`${baseUrl}/glyph-local/t1/${enc(join(wd, "index.html"))}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("proto");
    const css = await fetch(`${baseUrl}/glyph-local/t1/${enc(join(wd, "style.css"))}`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect((await fetch(`${baseUrl}/glyph-local/t1/etc/passwd`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/glyph-local/t1/${enc(join(wd, "..", "other.txt"))}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/glyph-local/other-task/${enc(join(wd, "index.html"))}`)).status).toBe(404);
    setExperimental(false);
    expect((await fetch(`${baseUrl}/glyph-local/t1/${enc(join(wd, "index.html"))}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/artifacts/a1/view`)).status).toBe(404);
  });
});

describe("glyph viewport report", () => {
  it("accepts a fit factor and rejects junk", async () => {
    const ok = await fetch(`${baseUrl}/api/tasks/t1/glyph/viewport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fit: 0.8 }) });
    expect(ok.status).toBe(204);
    const bad = await fetch(`${baseUrl}/api/tasks/t1/glyph/viewport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fit: "x" }) });
    expect(bad.status).toBe(400);
  });
});
