import { describe, expect, test } from "bun:test";
import { Store } from "../model/store";
import type { RecurringSeries, TaskItem } from "../model/types";
import { initialUIState } from "./state";
import { railRows, selectedIndex, nearestSelectable, isSelectable, seriesRuns, type RailRow } from "./view-model";

function task(over: Partial<TaskItem>): TaskItem {
  return {
    id: "t", title: "T", status: "active", display_status: "idle", mode: "workflow", paused: false, needs_review: false,
    current_phase: 0, phase_count: 0, phase_names: [], team_id: null, team_name: null, starred: false, icon: null, icon_color: null,
    memory_enabled: false, created_at: "2026-09-01 10:00:00", updated_at: null, started_at: null, source_scheduled_task_id: null,
    ...over,
  } as TaskItem;
}
const series = (over: Partial<RecurringSeries>): RecurringSeries => ({
  id: "s1", title: "Nightly", description: null, teamId: null, teamName: null, scheduleUnit: null, scheduleAmount: null,
  status: "approved", starred: false, nextRunAt: null, lastRunAt: null, memoryMode: "off", runs: [], ...over,
});

function world() {
  const store = new Store();
  const tasks: TaskItem[] = [
    task({ id: "blocked", title: "Blocked", display_status: "blocked", created_at: "2026-09-01 09:00:00" }),
    task({ id: "work", title: "Working", display_status: "working", created_at: "2026-09-01 08:00:00" }),
    task({ id: "draft", title: "Draft", status: "draft", display_status: "draft", created_at: "2026-09-01 07:00:00" }),
    ...Array.from({ length: 7 }, (_, i) => task({ id: `done${i}`, title: `Done ${i}`, status: "settled", display_status: "completed", created_at: `2026-08-2${i} 10:00:00` })),
    // runs of s1: one live, one failed, seven healthy finished
    task({ id: "run-live", title: "Run live", display_status: "working", source_scheduled_task_id: "s1", created_at: "2026-09-02 02:00:00" }),
    task({ id: "run-fail", title: "Run failed", status: "settled", display_status: "failed", source_scheduled_task_id: "s1", created_at: "2026-09-02 01:00:00" }),
    ...Array.from({ length: 7 }, (_, i) => task({ id: `run${i}`, title: `Run ${i}`, status: "settled", display_status: "completed", source_scheduled_task_id: "s1", created_at: `2026-08-1${i} 10:00:00` })),
  ];
  store.apply({ kind: "snapshot", tasks, escalations: [{ id: "e1", taskId: "blocked", agentId: "a", agentName: "coder", type: "question", status: "open", question: "?", response: null, createdAt: "2026-09-01 09:30:00" }], titleGeneratorConfigured: false });
  const ui = initialUIState("local");
  ui.recurring = [series({}), series({ id: "s2", title: "Weekly", starred: true })];
  return { store, ui };
}

const labels = (rows: RailRow[]): string[] =>
  rows.map((r) => (r.kind === "header" ? `# ${r.label} ${r.count}` : r.kind === "series" ? `~ ${r.series.title}${r.expanded ? " (open)" : ""}` : `${r.run ? "  · " : ""}${r.task.id}`));

describe("Latest board rows", () => {
  test("sections in web order: Needs you, Active (active + drafts), Recurring, Recent (5)", () => {
    const { store, ui } = world();
    expect(labels(railRows(store, ui))).toEqual([
      "# NEEDS YOU 1", "blocked",
      "# ACTIVE 3", "run-live", "work", "draft",
      "# RECURRING 2", "~ Nightly", "~ Weekly",
      "# RECENT 5", "run-fail", "done6", "done5", "done4", "done3",
    ]);
  });

  test("healthy finished runs stay under their series; an open series lists its newest five", () => {
    const { store, ui } = world();
    ui.expandedSeries.add("s1");
    const rows = labels(railRows(store, ui));
    const at = rows.indexOf("~ Nightly (open)");
    expect(rows.slice(at + 1, at + 7)).toEqual(["  · run-live", "  · run-fail", "  · run6", "  · run5", "  · run4", "~ Weekly"]);
    expect(seriesRuns(store, "s1")).toHaveLength(5);
  });

  test("an empty Active section still shows, with a note; search narrows tasks and series", () => {
    const { store, ui } = world();
    ui.search.insert("weekly");
    const rows = railRows(store, ui);
    expect(labels(rows)).toEqual(["# ACTIVE 0", "# RECURRING 1", "~ Weekly"]);
    expect(rows[0]).toMatchObject({ kind: "header", note: "nothing matches" });
  });

  test("headers are never selectable; the cursor finds the nearest real row", () => {
    const { store, ui } = world();
    const rows = railRows(store, ui);
    expect(isSelectable(rows[0]!)).toBe(false);
    expect(nearestSelectable(rows, 0)).toBe(1);
    expect(nearestSelectable(rows, 2, 1)).toBe(3); // stepping down onto "# ACTIVE" lands on its first task
    expect(nearestSelectable(rows, 2, -1)).toBe(1); // stepping up onto it lands on the row above
    ui.railKind = "series";
    ui.selectedSeriesId = "s2";
    expect(rows[selectedIndex(rows, ui)]).toMatchObject({ kind: "series" });
  });

  test("Starred holds starred series too; All has every task and no sections", () => {
    const { store, ui } = world();
    ui.filter = "starred";
    expect(labels(railRows(store, ui))).toEqual(["~ Weekly"]);
    ui.filter = "all";
    const rows = railRows(store, ui);
    expect(rows.every((r) => r.kind === "task")).toBe(true);
    expect(rows).toHaveLength(19);
  });
});
