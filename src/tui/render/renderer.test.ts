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
  it("header agents chip follows the live roster, not the coarser metrics lane", () => {
    const { store, ui } = world();
    // Metrics still say 2 (last task-driven push); both agents then exit.
    store.apply({ kind: "metrics", metrics: { running: 1, queued: 0, completed: 0, failed: 0, activeAgentCount: 2 } });
    const header = (): string => {
      const s = new Screen(180, 48);
      drawFrame(s, { store, ui });
      return s.toLines()[0]!;
    };
    expect(header()).toContain("⬢ 1 agents");
    store.apply({ kind: "instance", instance: { id: "i1", template_agent_name: "coder", task_id: "t1", task_title: "Fix auth middleware", status: "completed", updated_at: null } });
    expect(header()).toContain("⬢ 0 agents");
  });

  it("draws header, rail, detail and feed on a wide terminal", () => {
    const { store, ui } = world();
    const s = new Screen(180, 48);
    const r = drawFrame(s, { store, ui });
    const t = text(s);
    expect(r.layout.mode).toBe("triple");
    expect(t).toContain("SKIPPER");
    // The Latest board, sectioned like the web sidebar.
    expect(t).toContain("LATEST");
    expect(t).toContain("NEEDS YOU"); // t1 has an open escalation
    expect(t).toContain("ACTIVE");
    expect(t).toContain("RECENT");
    expect(t).toContain("Fix auth middleware");
    expect(t).toContain("Import CSV");
    expect(t).toContain("Old one"); // the finished task sits under Recent
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

  it("switches filters: Drafts narrows, All keeps finished tasks (there is no Done board)", () => {
    const { store, ui } = world();
    ui.filter = "drafts";
    let s = new Screen(140, 40);
    drawFrame(s, { store, ui });
    expect(text(s)).toContain("DRAFTS");
    expect(text(s)).not.toContain("Old one");
    ui.filter = "all";
    ui.selectedTaskId = "t3";
    s = new Screen(140, 40);
    drawFrame(s, { store, ui });
    const t = text(s);
    expect(t).toContain("Old one");
    expect(t).toContain("Import CSV");
    expect(t).not.toContain(" Done ");
    expect(t).not.toContain("Recurring"); // the tab is gone; series live inside Latest
  });

  it("lists recurring series on Latest, opens one to its latest runs, and shows the series in the main pane", () => {
    const { store, ui } = world();
    ui.recurring = [{ id: "s1", title: "Nightly sweep", description: "Sweep the repo", teamId: "team-1", teamName: "Core Team", scheduleUnit: "hours", scheduleAmount: 6, status: "approved", starred: false, nextRunAt: null, lastRunAt: null, memoryMode: "shared", runs: [] }];
    ui.recurringLoadedAt = Date.now();
    store.apply({ kind: "task", task: task({ id: "r1", title: "Nightly sweep · run 41", status: "settled", display_status: "completed", source_scheduled_task_id: "s1", created_at: "2026-09-02 01:00:00" }) });
    const draw = (): string => {
      const s = new Screen(180, 48);
      drawFrame(s, { store, ui });
      return text(s);
    };
    let t = draw();
    expect(t).toContain("RECURRING");
    expect(t).toContain("▸");
    expect(t).not.toContain("run 41"); // a healthy finished run stays under its series

    ui.railKind = "series";
    ui.selectedSeriesId = "s1";
    ui.expandedSeries.add("s1");
    t = draw();
    expect(t).toContain("▾");
    expect(t).toContain("run 41");
    expect(t).toContain("LATEST RUNS"); // main pane shows the series
    expect(t).toContain("memory shared");
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
