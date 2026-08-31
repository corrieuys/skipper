import { describe, it, expect } from "bun:test";
import { AnsiRenderer, clampScroll, tasksLines, agentLines, outputLines, phaseStrip } from "./ansi-renderer";
import type { TerminalDriver } from "./terminal";
import type { Snapshot, PhaseInfo } from "../model/types";
import type { UIState } from "./types";

/** Stub driver: fixed size, captures painted frames. */
function stubDriver(cols: number, rows: number): { driver: TerminalDriver; frames: string[] } {
  const frames: string[] = [];
  const driver = {
    size: () => ({ cols, rows }),
    mount: () => {},
    unmount: () => {},
    onResize: () => {},
    onKey: () => {},
    paint: (f: string) => frames.push(f),
  } as unknown as TerminalDriver;
  return { driver, frames };
}

const phase: PhaseInfo = { taskId: "t1", title: "Fix auth", status: "running", current: 1, total: 4, needsReview: false, phaseName: "Build" };

const sampleData: Snapshot = {
  tasks: [
    { id: "t1", title: "Fix auth", status: "running" },
    { id: "t2", title: "Import CSV", status: "approved" },
  ],
  agents: [{ id: "a1", template_agent_name: "claude", task_id: "t1", task_title: "Fix auth", status: "running" }],
  activity: [
    { agent_id: "a1", agent_name: "claude", kind: "message", text: "Analyzing the middleware", stream: "stdout" },
    { agent_id: "a1", agent_name: "claude", kind: "tool", text: "bash: bun test", stream: "stdout" },
    { agent_id: "a1", agent_name: "claude", kind: "note", text: "Plan approved", stream: "note" },
  ],
  phase,
  metrics: { running: 1, queued: 1, completed: 4, failed: 0, activeAgentCount: 1 },
};

const ui: UIState = {
  focused: "output",
  scroll: { output: 0, agents: 0, tasks: 0 },
  transportLabel: "local",
  frame: 0,
};

function plain(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

describe("AnsiRenderer", () => {
  it("paints a frame with pane titles, the output feed, notes and the phase indicator", () => {
    const { driver, frames } = stubDriver(140, 44);
    const r = new AnsiRenderer(driver);
    r.render({ data: sampleData, conn: "connected", ui });
    const text = plain(frames[0] ?? "");
    expect(text).toContain("SKIPPER");
    expect(text).toContain("AGENT OUTPUT");
    expect(text).toContain("ACTIVE AGENTS");
    expect(text).toContain("ACTIVE TASKS");
    expect(text).toContain("Analyzing the middleware");
    // note folded into the feed
    expect(text).toContain("Plan approved");
    // phase indicator in the header + the strip
    expect(text).toContain("phase 2/4");
    expect(text).toContain("Build");
    expect(text).toContain("claude");
  });

  it("advances animation glyphs when the frame counter changes", () => {
    const { driver, frames } = stubDriver(140, 44);
    const r = new AnsiRenderer(driver);
    r.render({ data: sampleData, conn: "connected", ui: { ...ui, frame: 0 } });
    r.render({ data: sampleData, conn: "connected", ui: { ...ui, frame: 1 } });
    // Two different frames → the spinner region differs between paints.
    expect(frames[0]).not.toBe(frames[1]);
  });

  it("clears once on first paint / resize, not on steady frames", () => {
    const { driver, frames } = stubDriver(140, 44);
    const r = new AnsiRenderer(driver);
    r.render({ data: sampleData, conn: "connected", ui });
    r.render({ data: sampleData, conn: "connected", ui });
    expect(frames[0]).toContain("\x1b[2J");
    expect(frames[1]).not.toContain("\x1b[2J");
  });
});

describe("content builders", () => {
  const empty: Snapshot = { tasks: [], agents: [], activity: [], phase: null, metrics: sampleData.metrics };

  it("returns no rows when a lane is empty (renderer supplies the placeholder)", () => {
    expect(tasksLines(empty, null)).toHaveLength(0);
    expect(agentLines(empty, 0)).toHaveLength(0);
    expect(outputLines(empty)).toHaveLength(0);
  });

  it("renders the pane placeholder text on an empty frame", () => {
    const { driver, frames } = stubDriver(140, 44);
    new AnsiRenderer(driver).render({ data: empty, conn: "connected", ui });
    const text = plain(frames[0] ?? "");
    expect(text).toContain("waiting for agent output");
    expect(text).toContain("no active tasks");
  });

  it("puts newest output at the bottom", () => {
    const lines = outputLines(sampleData).map(plain);
    // activity[0] is newest (server order) → should be the LAST rendered line
    expect(lines[lines.length - 1]).toContain("Analyzing the middleware");
    expect(lines[0]).toContain("Plan approved");
  });

  it("renders approved tasks as 'queued' and inserts a phase strip under the focus task", () => {
    const lines = tasksLines(sampleData, phase).map(plain);
    expect(lines.some((l) => l.includes("Import CSV") && l.includes("queued"))).toBe(true);
    // phase strip line follows the focus task row
    expect(lines.some((l) => l.includes("2/4") && l.includes("Build"))).toBe(true);
  });

  it("phaseStrip marks done/current/todo segments", () => {
    const s = plain(phaseStrip({ taskId: "t", title: "", status: "running", current: 1, total: 4, needsReview: true, phaseName: "Build" }));
    expect(s).toContain("2/4");
    expect(s).toContain("Build");
    expect(s).toContain("review"); // needsReview marker
  });
});

describe("clampScroll", () => {
  it("keeps the offset within [0, total-viewport]", () => {
    expect(clampScroll(-5, 10, 4)).toBe(0);
    expect(clampScroll(100, 10, 4)).toBe(6);
    expect(clampScroll(2, 10, 4)).toBe(2);
    expect(clampScroll(5, 3, 10)).toBe(0);
  });
});
