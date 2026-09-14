import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { fetchGlyphDelta, fetchGlyphTaskSummary, EMPTY_GLYPH_CURSOR } from "./glyph";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  db.prepare("INSERT INTO agents (id, name, type) VALUES ('ag1', 'Builder', 'claude-code')").run();
  db.prepare("INSERT INTO teams (id, name, phases) VALUES ('tm1', 'Team', ?)").run(JSON.stringify([{ name: "Plan", prompt: "p" }, { name: "Build", prompt: "b" }]));
  db.prepare("INSERT INTO tasks (id, title, description, team_id, status, current_phase) VALUES ('t1', 'Task', 'desc', 'tm1', 'active', 1)").run();
});

afterEach(() => db.close());

describe("fetchGlyphTaskSummary", () => {
  it("projects phases, mode and open escalation count", () => {
    db.prepare("INSERT INTO escalations (id, agent_id, task_id, type, question) VALUES ('e1', 'ag1', 't1', 'agent_request', 'q')").run();
    const s = fetchGlyphTaskSummary(db, "t1")!;
    expect(s.title).toBe("Task");
    expect(s.phases).toEqual(["Plan", "Build"]);
    expect(s.current_phase).toBe(1);
    expect(s.mode).toBe("workflow");
    expect(s.open_escalations).toBe(1);
    expect(s.display_status).toBe("blocked");
    expect(fetchGlyphTaskSummary(db, "nope")).toBeNull();
  });
});

describe("fetchGlyphDelta", () => {
  it("returns everything on an empty cursor and only new rows afterwards", () => {
    db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content) VALUES ('n1', 't1', 'ag1', 'first')").run();
    db.prepare("INSERT INTO task_messages (id, task_id, agent_id, content) VALUES ('m1', 't1', 'ag1', 'hello')").run();
    db.prepare("INSERT INTO task_artifacts (id, task_id, name, version, kind, body, created_by_agent_id) VALUES ('a1', 't1', 'plan', 1, 'plan', 'the plan', 'ag1')").run();
    db.prepare("INSERT INTO escalations (id, agent_id, task_id, type, question) VALUES ('e1', 'ag1', 't1', 'agent_request', 'q1')").run();

    const d1 = fetchGlyphDelta(db, "t1", EMPTY_GLYPH_CURSOR)!;
    expect(d1.notes.map((n) => n.content)).toEqual(["first"]);
    expect(d1.notes[0]!.agent).toBe("Builder");
    expect(d1.messages.map((m) => m.content)).toEqual(["hello"]);
    expect(d1.artifacts.map((a) => `${a.name}v${a.version}`)).toEqual(["planv1"]);
    expect(d1.artifacts[0]!.body).toBe("the plan");
    expect(d1.newEscalations.map((e) => e.id)).toEqual(["e1"]);
    expect(d1.openEscalations.map((e) => e.id)).toEqual(["e1"]);
    expect(d1.resolvedEscalations).toEqual([]);

    // Nothing new: empty delta, cursor unchanged.
    const d2 = fetchGlyphDelta(db, "t1", d1.next)!;
    expect(d2.notes).toEqual([]);
    expect(d2.messages).toEqual([]);
    expect(d2.artifacts).toEqual([]);
    expect(d2.newEscalations).toEqual([]);
    expect(d2.next).toEqual(d1.next);

    // New rows + a resolution of the old escalation.
    db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content) VALUES ('n2', 't1', 'ag1', 'second')").run();
    db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content, deleted_at) VALUES ('n3', 't1', 'ag1', 'retracted', datetime('now'))").run();
    db.prepare("INSERT INTO task_artifacts (id, task_id, name, version, kind, body, storage, source) VALUES ('a2', 't1', 'shot.png', 1, 'upload', '', 'file', 'operator')").run();
    db.prepare("UPDATE escalations SET status = 'resolved', response = 'yes', resolved_at = '2026-09-13 12:00:00' WHERE id = 'e1'").run();
    const d3 = fetchGlyphDelta(db, "t1", d1.next)!;
    expect(d3.notes.map((n) => n.content)).toEqual(["second"]);
    expect(d3.artifacts.map((a) => a.name)).toEqual(["shot.png"]);
    expect(d3.artifacts[0]!.body).toBeNull();
    expect(d3.artifacts[0]!.agent).toBe("operator");
    expect(d3.resolvedEscalations.map((e) => e.response)).toEqual(["yes"]);
    expect(d3.openEscalations).toEqual([]);
    expect(d3.next.resolvedAt).toBe("2026-09-13 12:00:00");

    // The resolution is not reported twice.
    const d4 = fetchGlyphDelta(db, "t1", d3.next)!;
    expect(d4.resolvedEscalations).toEqual([]);
  });

  it("returns null for an unknown task", () => {
    expect(fetchGlyphDelta(db, "nope", EMPTY_GLYPH_CURSOR)).toBeNull();
  });
});

describe("fetchGlyphDelta operator input", () => {
  it("reads typed, transcript and summary timeline entries since the cursor, nothing else", () => {
    db.prepare("INSERT INTO realtime_timeline (id, task_id, entry_type, content) VALUES ('i1', 't1', 'text', 'do the thing')").run();
    db.prepare("INSERT INTO realtime_timeline (id, task_id, entry_type, content) VALUES ('i2', 't1', 'transcript', 'um so yeah')").run();
    db.prepare("INSERT INTO realtime_timeline (id, task_id, entry_type, content) VALUES ('i3', 't1', 'error', 'boom')").run();
    db.prepare("INSERT INTO realtime_timeline (id, task_id, entry_type, content) VALUES ('i4', 't1', 'image', 'shot')").run();
    const d1 = fetchGlyphDelta(db, "t1", EMPTY_GLYPH_CURSOR)!;
    expect(d1.inputs.map((i) => [i.entry_type, i.content])).toEqual([["text", "do the thing"], ["transcript", "um so yeah"]]);
    db.prepare("INSERT INTO realtime_timeline (id, task_id, entry_type, content) VALUES ('i5', 't1', 'summary', 'operator wants X')").run();
    const d2 = fetchGlyphDelta(db, "t1", d1.next)!;
    expect(d2.inputs.map((i) => i.content)).toEqual(["operator wants X"]);
    expect(fetchGlyphDelta(db, "t1", d2.next)!.inputs).toEqual([]);
  });
});
