import { describe, it, expect } from "bun:test";
import { Screen } from "./screen";
import { drawFrame } from "./renderer";
import { Store } from "../model/store";
import type { TaskItem } from "../model/types";
import { initialUIState } from "../ui/state";
import { TextBuffer } from "../input/text-editor";

function task(over: Partial<TaskItem> = {}): TaskItem {
  return {
    id: "t1",
    title: "Fix auth middleware",
    status: "active",
    display_status: "working",
    mode: "workflow",
    paused: false,
    memory_enabled: true,
    memory_mode: "run",
    team_id: "team",
    team_name: "Core Team",
    current_phase: 1,
    phase_count: 4,
    needs_review: false,
    starred: true,
    icon: null,
    icon_color: null,
    created_at: "2026-09-01 10:00:00",
    updated_at: "2026-09-01 10:05:00",
    started_at: "2026-09-01 10:01:00",
    source_scheduled_task_id: null,
    ...over,
  };
}

function world() {
  const store = new Store();
  store.apply({ kind: "status", status: "connected" });
  store.apply({
    kind: "snapshot",
    tasks: [task(), task({ id: "t2", title: "Import CSV", display_status: "queued", starred: false }), task({ id: "t3", title: "Old one", status: "settled", display_status: "completed" })],
    escalations: [{ id: "e1", taskId: "t1", agentId: "a", agentName: "coder", type: "question", status: "open", question: "Which DB?", response: null, createdAt: "2026-09-01 10:04:00" }],
    titleGeneratorConfigured: false,
  });
  store.apply({ kind: "agents", agents: [{ id: "i1", template_agent_name: "coder", task_id: "t1", task_title: "Fix auth middleware", status: "running", updated_at: null }] });
  store.apply({ kind: "activity", activity: [{ agent_id: "i1", agent_name: "coder", kind: "message", text: "Analyzing the middleware", stream: "stdout", created_at: "2026-09-01 10:05:00" }] });
  store.apply({ kind: "note", note: { id: "n1", taskId: "t1", agentName: "coder", content: "Plan approved", createdAt: "2026-09-01 10:03:00" } });
  store.apply({ kind: "timeline", entry: { id: "x1", taskId: "t1", entryType: "text", content: "please use postgres", fedToSkipper: true, createdAt: "2026-09-01 10:02:00" } });
  const ui = initialUIState("local");
  ui.selectedTaskId = "t1";
  return { store, ui };
}

function text(s: Screen): string {
  return s.toLines().join("\n");
}

describe("drawFrame", () => {
  it("draws header, rail, detail and feed on a wide terminal", () => {
    const { store, ui } = world();
    const s = new Screen(180, 48);
    const r = drawFrame(s, { store, ui });
    const t = text(s);
    expect(r.layout.mode).toBe("triple");
    expect(t).toContain("SKIPPER");
    expect(t).toContain("ACTIVE");
    expect(t).toContain("Fix auth middleware");
    expect(t).toContain("Import CSV");
    expect(t).not.toContain("Old one"); // settled tasks are not in the Active filter
    expect(t).toContain("LIVE FEED");
    expect(t).toContain("Analyzing the middleware");
    // detail: status pill, meta, escalation banner, conversation
    expect(t).toContain("WORKING");
    expect(t).toContain("Core Team");
    expect(t).toContain("autopilot");
    expect(t).toContain("ESCALATION");
    expect(t).toContain("Which DB?");
    expect(t).toContain("please use postgres");
    expect(t).toContain("Plan approved");
    // header counts
    expect(t).toMatch(/1 working/);
    expect(t).toContain("▲ 1 blocked");
  });

  it("switches filters and shows settled tasks under Done", () => {
    const { store, ui } = world();
    ui.filter = "done";
    ui.selectedTaskId = "t3";
    const s = new Screen(140, 40);
    drawFrame(s, { store, ui });
    const t = text(s);
    expect(t).toContain("DONE");
    expect(t).toContain("Old one");
    expect(t).not.toContain("Import CSV");
  });

  it("renders a single column on a narrow terminal and the detail view on demand", () => {
    const { store, ui } = world();
    const s = new Screen(80, 30);
    const r = drawFrame(s, { store, ui });
    expect(r.layout.mode).toBe("single");
    expect(text(s)).toContain("Import CSV");
    ui.singleView = "main";
    const s2 = new Screen(80, 30);
    drawFrame(s2, { store, ui });
    expect(text(s2)).toContain("Which DB?");
  });

  it("overlays a form modal with the caret on the active field", () => {
    const { store, ui } = world();
    ui.modals.push({
      kind: "form",
      title: "New task",
      fields: [
        { kind: "text", key: "title", label: "Title", buf: new TextBuffer("abc"), required: true },
        { kind: "select", key: "mode", label: "Mode", options: [{ value: "workflow", label: "autopilot" }], index: 0 },
        { kind: "toggle", key: "approve", label: "Approve", value: true },
      ],
      active: 0,
      submitLabel: "Create",
      onSubmit: () => {},
      error: "title is required",
      busy: false,
      width: 70,
    });
    const s = new Screen(160, 44);
    const r = drawFrame(s, { store, ui });
    const t = text(s);
    expect(t).toContain("New task");
    expect(t).toContain("Title *");
    expect(t).toContain("autopilot");
    expect(t).toContain("✗ title is required");
    expect(t).toContain("Create");
    expect(r.cursor).not.toBeNull();
    // caret sits after "abc" inside the text field
    const row = s.rowText(r.cursor!.y);
    expect(row.slice(r.cursor!.x - 3, r.cursor!.x)).toBe("abc");
  });

  it("shows the composer caret when typing a message", () => {
    const { store, ui } = world();
    ui.composerActive = true;
    ui.composer.insert("hello there");
    const s = new Screen(160, 44);
    const r = drawFrame(s, { store, ui });
    expect(text(s)).toContain("▶ hello there");
    expect(r.cursor).not.toBeNull();
  });

  it("never throws on a tiny screen", () => {
    const { store, ui } = world();
    ui.modals.push({ kind: "confirm", title: "Delete", body: "sure?", confirmLabel: "Delete", danger: true, onConfirm: () => {}, busy: false, error: null });
    expect(() => drawFrame(new Screen(12, 4), { store, ui })).not.toThrow();
    expect(() => drawFrame(new Screen(1, 1), { store, ui })).not.toThrow();
  });
});
