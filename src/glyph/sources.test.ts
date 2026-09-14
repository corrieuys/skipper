import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeDatabase } from "../db/connection";
import { resolveGlyphSource, resolveAllowedFile, glyphLocalUrl, webSources } from "./sources";
import { parseFrame, ProtocolError } from "./protocol";

let db: Database;
let wd: string;
let outside: string;

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  wd = mkdtempSync(join(tmpdir(), "glyph-wd-"));
  outside = mkdtempSync(join(tmpdir(), "glyph-out-"));
  mkdirSync(join(wd, "dist"));
  writeFileSync(join(wd, "dist", "index.html"), "<h1>proto</h1>");
  writeFileSync(join(wd, "shot.png"), "png");
  writeFileSync(join(outside, "secret.txt"), "no");
  db.prepare("INSERT INTO tasks (id, title, status, working_directory) VALUES ('t1', 'T', 'active', ?)").run(wd);
  db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t2', 'No dir', 'active')").run();
  db.prepare("INSERT INTO task_artifacts (id, task_id, name, version, kind, body, format) VALUES ('a1', 't1', 'proto', 1, 'other', '<p>v1</p>', 'html')").run();
  db.prepare("INSERT INTO task_artifacts (id, task_id, name, version, kind, body, format) VALUES ('a2', 't1', 'proto', 2, 'other', '<p>v2</p>', 'html')").run();
  db.prepare("INSERT INTO task_artifacts (id, task_id, name, version, kind, body, storage, mime, width, height) VALUES ('a3', 't1', 'shot.png', 1, 'upload', '', 'file', 'image/png', 10, 10)").run();
  db.prepare("INSERT INTO task_artifacts (id, task_id, name, version, kind, body, storage, mime) VALUES ('a4', 't1', 'report.pdf', 1, 'upload', '', 'file', 'application/pdf')").run();
});

afterEach(() => {
  db.close();
  rmSync(wd, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveGlyphSource", () => {
  it("resolves artifacts by name to the latest version, images marked", () => {
    expect(resolveGlyphSource(db, "t1", "artifact:proto")).toEqual({ url: "/api/artifacts/a2/view", kind: "page" });
    expect(resolveGlyphSource(db, "t1", "artifact:shot.png")).toEqual({ url: "/api/artifacts/a3/file?glyph=image", kind: "image" });
    expect(resolveGlyphSource(db, "t1", "artifact:report.pdf")).toEqual({ url: "/api/artifacts/a4/file", kind: "page" });
  });

  it("names the available artifacts when the name is wrong", () => {
    expect(() => resolveGlyphSource(db, "t1", "artifact:nope")).toThrow(/no artifact named 'nope'.*proto.*report\.pdf.*shot\.png/);
    expect(() => resolveGlyphSource(db, "t2", "artifact:nope")).toThrow(/has no artifacts/);
  });

  it("serves files inside the working directory and refuses the rest", () => {
    const page = resolveGlyphSource(db, "t1", join(wd, "dist", "index.html"));
    expect(page.kind).toBe("page");
    expect(page.url.startsWith("/glyph-local/t1/")).toBe(true);
    expect(page.url.endsWith("/dist/index.html")).toBe(true);
    const img = resolveGlyphSource(db, "t1", join(wd, "shot.png"));
    expect(img.kind).toBe("image");
    expect(img.url.endsWith("/shot.png?glyph=image")).toBe(true);
    expect(() => resolveGlyphSource(db, "t1", join(outside, "secret.txt"))).toThrow(ProtocolError);
    expect(() => resolveGlyphSource(db, "t1", join(wd, "..", "..", "etc", "passwd"))).toThrow(/must exist and lie inside/);
    expect(() => resolveGlyphSource(db, "t1", join(wd, "missing.html"))).toThrow(/must exist/);
    expect(() => resolveGlyphSource(db, "t1", wd)).toThrow(ProtocolError); // a directory
    expect(() => resolveGlyphSource(db, "t2", join(wd, "shot.png"))).toThrow(/this task has none/);
  });

  it("passes https urls through and rejects everything else", () => {
    expect(resolveGlyphSource(db, "t1", "https://example.com/x")).toEqual({ url: "https://example.com/x", kind: "external" });
    expect(() => resolveGlyphSource(db, "t1", "javascript:alert(1)")).toThrow(/unsupported web view source/);
    expect(() => resolveGlyphSource(db, "t1", "dist/index.html")).toThrow(/unsupported/);
    expect(() => resolveGlyphSource(db, "t1", "")).toThrow(/empty/);
  });
});

describe("resolveAllowedFile + glyphLocalUrl", () => {
  it("round-trips an allowed path through the local url", () => {
    const real = resolveAllowedFile(db, "t1", join(wd, "dist", "index.html"))!;
    expect(real).toBeTruthy();
    const url = glyphLocalUrl("t1", real);
    const back = "/" + url.slice("/glyph-local/t1/".length).split("/").map((s) => decodeURIComponent(s)).join("/");
    expect(resolveAllowedFile(db, "t1", back)).toBe(real);
    expect(resolveAllowedFile(db, "t1", join(outside, "secret.txt"))).toBeNull();
  });
});

describe("webSources", () => {
  it("lists w texts in tree order", () => {
    expect(webSources(parseFrame('ra[wb"artifact:x"cc[wd"/p"te"t"]]'))).toEqual(["artifact:x", "/p"]);
    expect(webSources(null)).toEqual([]);
  });
});
