import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { loadGlyphScreen, saveGlyphScreen, deleteGlyphScreen } from "./store";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t1', 'T', 'active')").run();
});
afterEach(() => db.close());

describe("glyph store", () => {
  it("round-trips frame, cursor, session, calls and summary fingerprint; upserts; deletes", () => {
    expect(loadGlyphScreen(db, "t1")).toBeNull();
    const cursor = { notes: 3, messages: 1, artifacts: 0, escalations: 2, resolvedAt: "2026-09-13 10:00:00", inputs: 5 };
    saveGlyphScreen(db, "t1", { frame: 'ra[tb"x"]', cursor, sessionId: "s1", calls: 4, summaryFp: "fp1" });
    const s = loadGlyphScreen(db, "t1")!;
    expect(s.frame).toBe('ra[tb"x"]');
    expect(s.cursor).toEqual(cursor);
    expect(s.sessionId).toBe("s1");
    expect(s.calls).toBe(4);
    expect(s.summaryFp).toBe("fp1");
    saveGlyphScreen(db, "t1", { frame: 'ra[tb"y"]', cursor, sessionId: null, calls: 5 });
    expect(loadGlyphScreen(db, "t1")!.frame).toBe('ra[tb"y"]');
    expect(loadGlyphScreen(db, "t1")!.sessionId).toBeNull();
    deleteGlyphScreen(db, "t1");
    expect(loadGlyphScreen(db, "t1")).toBeNull();
  });

  it("tolerates an unreadable cursor", () => {
    db.prepare("INSERT INTO glyph_screens (task_id, frame, cursor) VALUES ('t1', 'ra[tb\"x\"]', 'not json')").run();
    const s = loadGlyphScreen(db, "t1")!;
    expect(s.cursor.notes).toBe(0);
    expect(s.cursor.inputs).toBe(0);
  });
});
