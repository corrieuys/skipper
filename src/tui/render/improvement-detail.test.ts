import { describe, expect, test } from "bun:test";
import { Screen } from "./screen";
import { drawFrame } from "./renderer";
import { CONFLICT_NOTICE, MISSING_NOTICE, diffLines, foldDiff } from "./improvement-detail";
import { C } from "./theme";
import { Store } from "../model/store";
import type { ImprovementDetail, ImprovementDiffLine, ImprovementSummary } from "../model/types";
import { initialUIState } from "../ui/state";

function imp(over: Partial<ImprovementSummary> = {}): ImprovementSummary {
  return {
    id: "i1", kind: "phase_prompt", status: "pending", state: "ready", targetKey: "phase:tm:0:analyse",
    targetLabel: 'Team "Sales" › Phase 1 "analyse"', teamId: "tm", teamName: "Sales", scheduledTaskId: null,
    phaseIndex: 0, phaseName: "analyse", agentRef: null, skillName: null, reason: "The run went on with an empty dataset.",
    sourceTaskId: null, sourceTaskTitle: null, usedByTeams: null, baseRevision: "r1", liveRevision: "r1",
    editedAt: null, decidedAt: null, createdAt: "2026-09-30 15:00:00", updatedAt: "2026-09-30 15:00:00",
    ...over,
  };
}

function detail(sum: ImprovementSummary, over: Partial<ImprovementDetail> = {}): ImprovementDetail {
  return {
    ...sum,
    proposedText: "Compute the total.\nStop and escalate when a source file is missing.",
    beforeText: "Compute the total.",
    liveText: "Compute the total.",
    diff: [{ op: "same", text: "Compute the total." }, { op: "add", text: "Stop and escalate when a source file is missing." }],
    diffBase: "live",
    ...over,
  };
}

const same = (n: number, from = 0): ImprovementDiffLine[] => Array.from({ length: n }, (_, i) => ({ op: "same", text: `line ${from + i}` }));

function world(rows: ImprovementSummary[], features = ["snapshot", "improvements"], hint = 0) {
  const store = new Store();
  store.apply({ kind: "status", status: "connected" });
  store.apply({ kind: "snapshot", tasks: [], escalations: [], titleGeneratorConfigured: false, pendingImprovements: hint });
  store.apply({ kind: "capabilities", protocolVersion: 3, features });
  if (rows.length) store.loadImprovements(rows, "pending", 500);
  store.apply({ kind: "improvement_settings", autoApprove: false });
  const ui = initialUIState("local");
  ui.filter = "improvements";
  ui.railKind = "improvement";
  ui.selectedImprovementId = rows[0]?.id ?? null;
  return { store, ui };
}

function draw(store: Store, ui: ReturnType<typeof initialUIState>, cols = 200, rows = 50): Screen {
  const s = new Screen(cols, rows);
  drawFrame(s, { store, ui });
  return s;
}

const text = (s: Screen): string => s.toLines().join("\n");

/** First cell of `needle` on screen. */
function find(s: Screen, needle: string): { x: number; y: number } {
  const lines = s.toLines();
  for (let y = 0; y < lines.length; y++) {
    const x = lines[y]!.indexOf(needle);
    if (x >= 0) return { x, y };
  }
  throw new Error(`"${needle}" not on screen`);
}

describe("foldDiff", () => {
  test("keeps 3 lines of context around a change and folds the rest", () => {
    const diff = [...same(5), { op: "add" as const, text: "new" }, ...same(5, 5)];
    const rows = foldDiff(diff, false);
    expect(rows.map((r) => (r.kind === "fold" ? `~${r.count}` : `${r.op}:${r.text}`))).toEqual([
      "~2", "same:line 2", "same:line 3", "same:line 4", "add:new", "same:line 5", "same:line 6", "same:line 7", "~2",
    ]);
    expect(foldDiff(diff, true)).toHaveLength(11);
  });

  test("a gap of one line is shown, not folded; no change folds everything", () => {
    const diff = [{ op: "del" as const, text: "a" }, ...same(4), { op: "add" as const, text: "b" }];
    expect(foldDiff(diff, false).every((r) => r.kind === "line")).toBe(true);
    expect(foldDiff(same(9), false)).toEqual([{ kind: "fold", count: 9 }]);
  });

  test("diff lines: + in the ok colour, - in the danger colour, context muted, long lines wrap under the sign", () => {
    const { lines, folded } = diffLines([{ op: "del", text: "gone" }, { op: "add", text: "word ".repeat(20).trim() }, { op: "same", text: "kept" }], 40, false);
    expect(folded).toBe(false);
    expect(lines[0]!.prefix!.text).toBe("- ");
    expect(lines[0]!.st.fg).toBe(C.danger);
    expect(lines[1]!.prefix!.text).toBe("+ ");
    expect(lines[1]!.st.fg).toBe(C.ok);
    expect(lines[2]!.prefix!.text).toBe("  "); // continuation of the wrapped add
    expect(lines[2]!.st.fg).toBe(C.ok);
    expect(lines.at(-1)!.st.fg).toBe(C.textMuted);
  });
});

describe("board 5 main pane", () => {
  test("a ready improvement: target, state, meta, reason and the coloured diff", () => {
    const sum = imp({ sourceTaskId: "t1", sourceTaskTitle: "Q3 report", usedByTeams: 2 });
    const { store, ui } = world([sum]);
    store.setImprovementDetail(detail(sum));
    const s = draw(store, ui);
    const t = text(s);
    expect(t).toContain('Team "Sales" › Phase 1 "analyse"');
    expect(t).toContain("PENDING");
    expect(t).toContain("Phase prompt · Sales · Used by 2 teams");
    expect(t).toContain("from Q3 report");
    expect(t).toContain("REASON");
    expect(t).toContain("The run went on with an empty dataset.");
    expect(t).toContain("CURRENT TEXT → PROPOSED TEXT");
    const add = find(s, "+ Stop and escalate");
    expect(s.cellAt(add.x, add.y)!.st.fg).toBe(C.ok);
    expect(t).not.toContain(CONFLICT_NOTICE.slice(0, 30));
  });

  test("a conflict shows the notice from the live summary, even before the detail is read again", () => {
    const sum = imp();
    const { store, ui } = world([sum]);
    store.setImprovementDetail(detail(sum));
    store.apply({ kind: "improvements", improvements: [imp({ state: "conflict", liveRevision: "r2" })] });
    const t = text(draw(store, ui));
    expect(t).toContain("CONFLICT");
    expect(t).toContain("The live text changed after this was proposed.");
    expect(t).toContain("refreshing…");
  });

  test("a missing target shows its notice and the proposed text only", () => {
    const sum = imp({ state: "missing", liveRevision: null });
    const { store, ui } = world([sum]);
    store.setImprovementDetail(detail(sum, { liveText: null, diff: null, diffBase: null }));
    const t = text(draw(store, ui));
    expect(t).toContain("TARGET GONE");
    expect(t).toContain(MISSING_NOTICE.slice(0, 40));
    expect(t).toContain("PROPOSED TEXT");
    expect(t).not.toContain("CURRENT TEXT →");
  });

  test("a skill suggestion reads Problem and Suggestion", () => {
    const sum = imp({ kind: "skill_suggestion", state: "suggestion", targetLabel: 'Skill "xlsx"', baseRevision: null, liveRevision: null });
    const { store, ui } = world([sum]);
    store.setImprovementDetail(detail(sum, { proposedText: "Write formulas, not text.", liveText: null, diff: null, diffBase: null }));
    const t = text(draw(store, ui));
    expect(t).toContain("Skill suggestion");
    expect(t).toContain("PROBLEM");
    expect(t).toContain("SUGGESTION");
    expect(t).toContain("Write formulas, not text.");
  });

  test("decided rows say so and diff against the text before", () => {
    const sum = imp({ status: "rejected", state: "decided", liveRevision: null, kind: "skill_suggestion" });
    const { store, ui } = world([sum]);
    ui.improvementScope = "all";
    expect(text(draw(store, ui))).toContain("DISMISSED");
    const approved = imp({ id: "i2", status: "approved", state: "decided", liveRevision: null, decidedAt: "2026-09-30 16:00:00" });
    store.apply({ kind: "improvements", improvements: [approved] });
    store.setImprovementDetail(detail(approved, { diffBase: "before", liveText: null }));
    ui.selectedImprovementId = "i2";
    const t = text(draw(store, ui));
    expect(t).toContain("APPROVED");
    expect(t).toContain("TEXT BEFORE → PROPOSED TEXT");
  });

  test("long unchanged runs fold until z expands them", () => {
    const sum = imp();
    const { store, ui } = world([sum]);
    store.setImprovementDetail(detail(sum, { diff: [...same(10), { op: "add", text: "new rule" }] }));
    let t = text(draw(store, ui));
    expect(t).toContain("⋯ 7 unchanged lines");
    expect(t).not.toContain("line 0");
    expect(t).toContain("z shows every line");
    ui.improvementDiffExpanded = true;
    t = text(draw(store, ui));
    expect(t).not.toContain("⋯");
    expect(t).toContain("line 0");
    expect(t).toContain("z folds unchanged lines");
  });

  test("before the read lands the pane says it is loading", () => {
    const { store, ui } = world([imp()]);
    expect(text(draw(store, ui))).toContain("loading the text…");
  });

  test("rail rows drop the team prefix; the selected one names kind, team and state", () => {
    const { store, ui } = world([imp(), imp({ id: "i2", state: "conflict", createdAt: "2026-09-29 10:00:00" })]);
    const t = text(draw(store, ui));
    expect(t).toContain("IMPROVEMENTS · PENDING");
    expect(t).toContain('✦ Phase 1 "analyse"');
    expect(t).toContain('▲ Phase 1 "analyse"');
    expect(t).toMatch(/Phase prompt · Sales\s+pending/);
  });
});

describe("board 5 in the header", () => {
  test("the tab and the attention chip show only with the feature", () => {
    const off = world([], ["snapshot"], 3);
    off.ui.filter = "latest";
    off.ui.railKind = "task";
    const tOff = draw(off.store, off.ui).toLines();
    expect(tOff[1]).not.toContain("Improvements");
    expect(tOff[0]).not.toContain("improvements");

    const on = world([imp(), imp({ id: "i2" })]);
    on.ui.filter = "latest";
    on.ui.railKind = "task";
    const tOn = draw(on.store, on.ui).toLines();
    expect(tOn[1]).toContain("5 Improvements 2");
    expect(tOn[0]).toContain("✦ 2 improvements");
  });

  test("the chip uses the snapshot count until the list loads, and hides at zero", () => {
    const { store, ui } = world([], undefined, 4);
    expect(draw(store, ui).toLines()[0]).toContain("✦ 4 improvements");
    store.loadImprovements([], "pending", 500);
    expect(draw(store, ui).toLines()[0]).not.toContain("improvements");
  });
});
