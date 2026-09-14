import { describe, it, expect } from "bun:test";
import { parseGlyphReply, sanitizeGlyphText, buildWakeMessage, describeRejection } from "./renderer";
import { parseFrame, Tree, ProtocolError } from "./protocol";
import type { GlyphDelta } from "../data/glyph";

describe("parseGlyphReply", () => {
  it("reads a fenced RENDER block", () => {
    const r = parseGlyphReply('Here you go:\n```glyph\nRENDER ra[tb"hi"]\n```\n');
    expect(r).toEqual({ kind: "render", frame: 'ra[tb"hi"]' });
  });

  it("reads a multi-line frame", () => {
    const r = parseGlyphReply('```glyph\nRENDER ra[\n  cb[hc"T"]\n]\n```');
    expect(r?.kind).toBe("render");
    expect((r as { frame: string }).frame).toBe('ra[\n  cb[hc"T"]\n]');
  });

  it("reads PATCH and NOOP, with or without a fence", () => {
    expect(parseGlyphReply('```\nPATCH ~c"x"!\n```')).toEqual({ kind: "patch", ops: '~c"x"!' });
    expect(parseGlyphReply("PATCH -e")).toEqual({ kind: "patch", ops: "-e" });
    expect(parseGlyphReply("```glyph\nNOOP\n```")).toEqual({ kind: "noop" });
    expect(parseGlyphReply("NOOP")).toEqual({ kind: "noop" });
  });

  it("turns a literal backslash-n into a real newline", () => {
    const r = parseGlyphReply("```glyph\nRENDER ra[lb\"one\\ntwo\"Tc\"A|B\\n1|2\"]\n```");
    expect(r).toEqual({ kind: "render", frame: 'ra[lb"one\ntwo"Tc"A|B\n1|2"]' });
    expect(parseGlyphReply("PATCH ~b\"x\\ny\"")).toEqual({ kind: "patch", ops: '~b"x\ny"' });
  });

  it("returns null on prose or an empty command", () => {
    expect(parseGlyphReply("I would render something nice.")).toBeNull();
    expect(parseGlyphReply("```glyph\nRENDER\n```")).toBeNull();
    expect(parseGlyphReply("")).toBeNull();
  });
});

describe("sanitizeGlyphText", () => {
  it("replaces quotes and pipes, normalizes newlines", () => {
    expect(sanitizeGlyphText('say "hi" | ok\r\nnext')).toBe("say 'hi' / ok\nnext");
  });
});

function delta(over: Partial<GlyphDelta> = {}): GlyphDelta {
  return {
    task: {
      id: "t1", title: 'Ship "v2"', description: "Do the thing", working_directory: "/tmp/proj", status: "active", display_status: "working",
      mode: "workflow", current_phase: 1, phases: ["Plan", "Build", "Verify"], needs_review: false, open_escalations: 0,
    },
    notes: [], messages: [], artifacts: [], newEscalations: [], resolvedEscalations: [], openEscalations: [], inputs: [],
    next: { notes: 0, messages: 0, artifacts: 0, escalations: 0, resolvedAt: "", inputs: 0 },
    ...over,
  };
}

describe("buildWakeMessage", () => {
  it("carries the task header, the description on the first wake, and the current screen", () => {
    const msg = buildWakeMessage(delta(), "", { firstWake: true });
    expect(msg).toContain("title: Ship 'v2'");
    expect(msg).toContain("phase 2 of 3 (Build)");
    expect(msg).toContain("Do the thing");
    expect(msg).toContain("(empty: send RENDER)");
    expect(msg).toContain('working directory: /tmp/proj (a file under it can be shown with w"/absolute/path")');
    expect(msg).toContain("NO NEW REGISTER ENTRIES");
    const later = buildWakeMessage(delta(), 'ra[tb"x"]', { firstWake: false });
    expect(later).not.toContain("Do the thing");
    expect(later).toContain('ra[tb"x"]');
    expect(later).toContain("Re-read the whole screen above, then fold the new material in");
    expect(msg).not.toContain("Re-read the whole screen above");
  });

  it("lists registers, sanitizes text, and caps per register", () => {
    const notes = Array.from({ length: 15 }, (_, i) => ({
      rowid: i + 1, id: `n${i}`, agent: "Builder", content: `note ${i} says "x"`, created_at: `2026-09-13 10:00:${String(i).padStart(2, "0")}`,
    }));
    const msg = buildWakeMessage(delta({
      notes,
      messages: [{ rowid: 1, id: "m1", agent: "Skipper", content: "not sure the API | batches", created_at: "2026-09-13 10:01:00" }],
      inputs: [
        { rowid: 1, id: "i1", entry_type: "text", content: "Please add a refund column", created_at: "2026-09-13 10:02:00" },
        { rowid: 2, id: "i2", entry_type: "summary", content: "Operator asked whether Thursday still holds", created_at: "2026-09-13 10:03:00" },
      ],
      artifacts: [
        { rowid: 1, id: "a1", name: "plan", version: 2, kind: "plan", description: "the plan", body: "line1\nline2", storage: "inline", mime: null, format: "markdown", width: null, height: null, agent: "Planner", created_at: "x" },
        { rowid: 2, id: "a2", name: "shot", version: 1, kind: "upload", description: null, body: null, storage: "file", mime: "image/png", format: null, width: 1200, height: 800, agent: "operator", created_at: "x" },
        { rowid: 3, id: "a3", name: "proto", version: 1, kind: "other", description: null, body: "<h1>x</h1>", storage: "inline", mime: null, format: "html", width: null, height: null, agent: "Builder", created_at: "x" },
        { rowid: 4, id: "a4", name: "big-spec", version: 1, kind: "plan", description: null, body: "x".repeat(9000), storage: "inline", mime: null, format: "markdown", width: null, height: null, agent: "Builder", created_at: "x" },
      ],
      openEscalations: [{ rowid: 1, id: "e1", agent: "Builder", type: "agent_request", severity: "high", question: "Delete prod?", response: null, status: "open", created_at: "x", resolved_at: null }],
      resolvedEscalations: [{ rowid: 2, id: "e2", agent: "Builder", type: "agent_request", severity: "normal", question: "Which DB?", response: "SQLite", status: "resolved", created_at: "x", resolved_at: "y" }],
    }), "", { firstWake: false, lastError: 'RENDER rejected: unknown id "z"' });
    expect(msg).toContain("(3 earlier notes skipped)");
    expect(msg).toContain("note 14 says 'x'");
    expect(msg).not.toContain("note 2 says");
    expect(msg).toContain("not sure the API / batches");
    expect(msg).toContain("NEW OPERATOR INPUT: instructions FOR SOMEONE ELSE");
    expect(msg).toContain("Observe it, do not execute it");
    expect(msg).toContain("operator (typed): Please add a refund column");
    expect(msg).toContain("operator (spoken, summarised): Operator asked whether Thursday still holds");
    expect(msg).toContain("plan v2 (plan) by Planner: the plan");
    expect(msg).toContain("  --- full content ---");
    expect(msg).toContain("  line2");
    expect(msg).toContain("== TOOLS ==");
    expect(msg).toContain('(image 1200x800: show it with w"artifact:shot")');
    expect(msg).toContain('(html page: show it with w"artifact:proto")');
    expect(msg).toContain('(text: summarise what matters from it on the screen; a page view w"artifact:plan" is a last resort, not for work in progress)');
    expect(msg).toContain("[high] Builder asks: Delete prod?");
    expect(msg).toContain("operator answered: SQLite");
    expect(msg).toContain('(9000 characters, not inlined: read it in full with get_artifact("big-spec") before summarising)');
    expect(msg).not.toContain("x".repeat(100));
    expect(msg).toContain("PREVIOUS COMMAND WAS REJECTED");
    expect(msg).toContain('RENDER rejected: unknown id "z"');
    expect(msg).not.toContain("NO NEW REGISTER ENTRIES");
  });
});

describe("describeRejection", () => {
  const screen = 'ra[cb[hc"T"ld"x"]]';

  it("marks the parse position with a caret and echoes what was sent", () => {
    const frame = 'ra[cb[hc"oops]]';
    let err: unknown;
    try { parseFrame(frame); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ProtocolError);
    const out = describeRejection({ kind: "render", frame }, err, screen, { n: 1, max: 4 });
    expect(out).toContain("Attempt 1 of 4: your RENDER was rejected");
    expect(out).toContain("Position: character");
    expect(out).toMatch(/\^/);
    expect(out).toContain("Error: unterminated text (at 9)");
    expect(out).toContain("(line 1, column 10)");
    expect(out).toContain(`You sent (${frame.length} chars):\n${frame}`);
    expect(out).toContain("Hint: A text body must end with a closing double quote");
    expect(out).toContain("Ids currently on screen: a b c d");
  });

  it("lists screen ids and hints on an unknown id in a patch", () => {
    const t = Tree.fromFrame(screen);
    let err: unknown;
    try { t.applyOps('~z"nope"'); } catch (e) { err = e; }
    const out = describeRejection({ kind: "patch", ops: '~z"nope"' }, err, screen, { n: 2, max: 4 });
    expect(out).toContain("Attempt 2 of 4: your PATCH was rejected");
    expect(out).toContain("unknown id 'z'");
    expect(out).toContain("Hint: Every op must target an id that is on the current screen");
    expect(out).toContain("Ids currently on screen: a b c d");
    expect(out).toContain("send a full RENDER");
  });

  it("explains a missing command and an empty screen", () => {
    const out = describeRejection(null, new Error("no glyph command found in the reply"), "", { n: 1, max: 4 });
    expect(out).toContain("no command was found");
    expect(out).toContain("Hint: Your whole reply must be one ```glyph block");
    expect(out).toContain("The screen is currently empty: only RENDER is possible.");
  });

  it("hints on one-way violations", () => {
    const out = describeRejection({ kind: "render", frame: 'ra[Bb>go"Go"]' }, new ProtocolError("'B' nodes are not allowed on a one-way screen (id 'b')", -1), "", { n: 1, max: 4 });
    expect(out).toContain("Hint: This screen is read-only");
    expect(out).not.toContain("Position:");
  });
});

describe("buildWakeMessage viewport", () => {
  it("tells the renderer to cut when the overlay had to shrink the screen", () => {
    const shrunk = buildWakeMessage(delta(), 'ra[tb"x"]', { firstWake: false, fit: 0.82 });
    expect(shrunk).toContain("SCREEN OVERFLOWS THE VIEWPORT");
    expect(shrunk).toContain("shrink it to 82%");
    expect(buildWakeMessage(delta(), 'ra[tb"x"]', { firstWake: false, fit: 1 })).not.toContain("OVERFLOWS");
    expect(buildWakeMessage(delta(), 'ra[tb"x"]', { firstWake: false, fit: 0.98 })).not.toContain("OVERFLOWS");
    expect(buildWakeMessage(delta(), "", { firstWake: true, fit: 0.5 })).not.toContain("OVERFLOWS");
  });
});
