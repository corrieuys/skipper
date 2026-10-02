import { describe, expect, test } from "bun:test";
import { Store } from "./store";
import type { ImprovementSummary } from "./types";
import { mapConnectEvent, toImprovementDetail } from "../transport/local";
import { initialUIState } from "../ui/state";
import { improvementRailLabel, railRows, selectedIndex, type RailRow } from "../ui/view-model";

/** Improvements (experimental board 5): wire mapping, store folds, rail rows. */

function imp(over: Partial<ImprovementSummary> = {}): ImprovementSummary {
  return {
    id: "i1",
    kind: "phase_prompt",
    status: "pending",
    state: "ready",
    targetKey: "phase:tm:0:analyse",
    targetLabel: 'Team "Sales" › Phase 1 "analyse"',
    teamId: "tm",
    teamName: "Sales",
    scheduledTaskId: null,
    phaseIndex: 0,
    phaseName: "analyse",
    agentRef: null,
    skillName: null,
    reason: "The run went on with an empty dataset.",
    sourceTaskId: null,
    sourceTaskTitle: null,
    usedByTeams: null,
    baseRevision: "r1",
    liveRevision: "r1",
    editedAt: null,
    decidedAt: null,
    createdAt: "2026-09-30 15:00:00",
    updatedAt: "2026-09-30 15:00:00",
    ...over,
  };
}

function store(features = ["snapshot", "improvements"], hint = 0): Store {
  const s = new Store();
  s.apply({ kind: "snapshot", tasks: [], escalations: [], titleGeneratorConfigured: false, pendingImprovements: hint });
  s.apply({ kind: "capabilities", protocolVersion: 3, features });
  return s;
}

describe("improvement wire mapping", () => {
  test("improvement:changed upserts the row and its siblings", () => {
    const ev = mapConnectEvent("improvement:changed", {
      improvementId: "i1",
      change: "updated",
      improvement: { ...imp({ status: "approved", state: "decided" }) },
      siblings: [{ ...imp({ id: "i2", state: "conflict", liveRevision: "r2" }) }],
    });
    expect(ev?.kind).toBe("improvements");
    if (ev?.kind !== "improvements") throw new Error("wrong kind");
    expect(ev.improvements.map((i) => [i.id, i.status, i.state])).toEqual([["i1", "approved", "decided"], ["i2", "pending", "conflict"]]);
    expect(ev.improvements[1]!.liveRevision).toBe("r2");
  });

  test("an improvement:changed without its fat row maps to nothing", () => {
    expect(mapConnectEvent("improvement:changed", { improvementId: "i1", change: "created" })).toBeNull();
  });

  test("settings, library agent and team / series events", () => {
    expect(mapConnectEvent("improvements:settings_changed", { autoApprove: true })).toEqual({ kind: "improvement_settings", autoApprove: true });
    expect(mapConnectEvent("library_agent:changed", { agentType: "single:x" })).toBeNull();
    const lib = mapConnectEvent("library_agent:changed", { agentType: "single:x", improvements: [imp({ id: "i9", usedByTeams: 3 })] });
    expect(lib?.kind === "improvements" && lib.improvements[0]!.usedByTeams).toBe(3);
    const team = mapConnectEvent("team:changed", { teamId: "tm", change: "updated", team: { id: "tm" }, improvements: [imp({ state: "conflict" })] });
    expect(team?.kind === "team_changed" && team.improvements?.[0]?.state).toBe("conflict");
    const series = mapConnectEvent("recurring:changed", { scheduledTaskId: "s1", change: "deleted", improvements: [imp({ kind: "recurring_description", state: "missing" })] });
    expect(series?.kind === "recurring_changed" && series.improvements?.[0]?.state).toBe("missing");
    // A daemon without the feature sends no `improvements` key: the event keeps its old shape.
    expect(mapConnectEvent("team:changed", { teamId: "tm", change: "updated" })).toEqual({ kind: "team_changed", id: "tm", deleted: false, row: null });
  });

  test("the detail keeps texts, the diff and its base", () => {
    const d = toImprovementDetail({
      ...imp(),
      proposedText: "a\nb",
      beforeText: "a",
      liveText: "a",
      diff: [{ op: "same", text: "a" }, { op: "add", text: "b" }, { op: "weird", text: "c" }],
      diffBase: "live",
    });
    expect(d.diff).toEqual([{ op: "same", text: "a" }, { op: "add", text: "b" }, { op: "same", text: "c" }]);
    expect(d.diffBase).toBe("live");
    expect(d.liveText).toBe("a");
    expect(toImprovementDetail({ ...imp(), kind: "skill_suggestion", diff: null, diffBase: null, liveText: null }).diff).toBeNull();
  });
});

describe("Store improvements", () => {
  test("pending count: the snapshot's until the first list, then the rows; 0 without the feature", () => {
    expect(store(["snapshot"], 4).pendingImprovementCount()).toBe(0);
    const s = store(undefined, 4);
    expect(s.pendingImprovementCount()).toBe(4);
    s.loadImprovements([imp(), imp({ id: "i2" })], "pending", 500);
    expect(s.pendingImprovementCount()).toBe(2);
    s.apply({ kind: "improvements", improvements: [imp({ id: "i3", createdAt: "2026-09-30 16:00:00" })] });
    expect(s.pendingImprovementCount()).toBe(3);
    expect(s.allImprovements()[0]!.id).toBe("i3"); // newest first
  });

  test("an approve upserts the row and flips its siblings to conflict", () => {
    const s = store();
    s.loadImprovements([imp(), imp({ id: "i2" })], "pending", 500);
    const v = s.version;
    s.apply({ kind: "improvements", improvements: [imp({ status: "approved", state: "decided", liveRevision: null }), imp({ id: "i2", state: "conflict", liveRevision: "r2" })] });
    expect(s.version).toBeGreaterThan(v);
    expect(s.improvement("i1")!.status).toBe("approved");
    expect(s.improvement("i2")!.state).toBe("conflict");
    expect(s.pendingImprovementCount()).toBe(1);
  });

  test("team / series events upsert the pending rows they carry", () => {
    const s = store();
    s.loadImprovements([imp()], "pending", 500);
    expect(s.apply({ kind: "team_changed", id: "tm", deleted: false, row: null })).toBe(false);
    expect(s.apply({ kind: "team_changed", id: "tm", deleted: false, row: null, improvements: [imp({ state: "conflict" })] })).toBe(true);
    expect(s.improvement("i1")!.state).toBe("conflict");
    s.apply({ kind: "recurring_changed", id: "s1", deleted: true, row: null, improvements: [imp({ id: "i5", kind: "recurring_description", state: "missing" })] });
    expect(s.improvement("i5")!.state).toBe("missing");
  });

  test("a pending list drops pending rows the daemon no longer holds and keeps decided ones", () => {
    const s = store();
    s.loadImprovements([imp(), imp({ id: "i2" }), imp({ id: "d1", status: "rejected", state: "decided" })], "all", 500);
    s.loadImprovements([imp({ id: "i2" })], "pending", 500);
    expect(s.improvement("i1")).toBeUndefined();
    expect(s.improvement("i2")).toBeDefined();
    expect(s.improvement("d1")).toBeDefined();
    // An answer at the limit may be cut: nothing is dropped.
    s.loadImprovements([], "pending", 0);
    expect(s.improvement("i2")).toBeDefined();
  });

  test("a detail goes stale when its summary moves", () => {
    const s = store();
    s.loadImprovements([imp()], "pending", 500);
    expect(s.improvementDetailStale("i1")).toBe(true);
    s.setImprovementDetail({ ...imp(), proposedText: "x", beforeText: "", liveText: "", diff: [], diffBase: "live" });
    expect(s.improvementDetailStale("i1")).toBe(false);
    s.apply({ kind: "improvements", improvements: [imp({ liveRevision: "r2", state: "conflict" })] });
    expect(s.improvementDetailStale("i1")).toBe(true);
    s.setImprovementDetail({ ...imp({ liveRevision: "r2", state: "conflict" }), proposedText: "x", beforeText: "", liveText: "", diff: [], diffBase: "live" });
    expect(s.improvementDetailStale("i1")).toBe(false);
    s.apply({ kind: "improvements", improvements: [imp({ liveRevision: "r2", state: "conflict", updatedAt: "2026-09-30 17:00:00" })] });
    expect(s.improvementDetailStale("i1")).toBe(true);
  });

  test("the auto-approve gate follows its event", () => {
    const s = store();
    expect(s.autoApprove).toBeNull();
    expect(s.apply({ kind: "improvement_settings", autoApprove: true })).toBe(true);
    expect(s.autoApprove).toBe(true);
    expect(s.apply({ kind: "improvement_settings", autoApprove: true })).toBe(false);
  });
});

const ids = (rows: RailRow[]): string[] => rows.map((r) => (r.kind === "header" ? `# ${r.label} ${r.count}` : r.kind === "improvement" ? r.improvement.id : "?"));

describe("board 5 rows", () => {
  function world() {
    const s = store();
    s.loadImprovements(
      [
        imp({ id: "old", createdAt: "2026-09-29 10:00:00" }),
        imp({ id: "new", createdAt: "2026-09-30 10:00:00", kind: "skill_suggestion", state: "suggestion", targetLabel: 'Skill "xlsx"', teamName: "Sales" }),
        imp({ id: "done", status: "approved", state: "decided", createdAt: "2026-09-30 11:00:00" }),
      ],
      "all",
      500,
    );
    const ui = initialUIState("local");
    ui.filter = "improvements";
    return { s, ui };
  }

  test("Pending lists pending rows newest first, with no sections", () => {
    const { s, ui } = world();
    expect(ids(railRows(s, ui))).toEqual(["new", "old"]);
  });

  test("All adds a DECIDED section under PENDING", () => {
    const { s, ui } = world();
    ui.improvementScope = "all";
    expect(ids(railRows(s, ui))).toEqual(["# PENDING 2", "new", "old", "# DECIDED 1", "done"]);
  });

  test("search narrows by target, kind and state", () => {
    const { s, ui } = world();
    ui.search.insert("skill");
    expect(ids(railRows(s, ui))).toEqual(["new"]);
  });

  test("the cursor is an improvement id; the rail label drops the team prefix", () => {
    const { s, ui } = world();
    ui.railKind = "improvement";
    ui.selectedImprovementId = "old";
    expect(selectedIndex(railRows(s, ui), ui)).toBe(1);
    expect(improvementRailLabel(imp())).toBe('Phase 1 "analyse"');
    expect(improvementRailLabel(imp({ teamName: null, targetLabel: 'Recurring task "Q3"' }))).toBe('Recurring task "Q3"');
  });
});
