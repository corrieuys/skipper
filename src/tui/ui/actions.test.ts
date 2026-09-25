import { describe, expect, test } from "bun:test";
import { instanceListItems, openRecurringForm, openTaskForm, type Assignee, type Ctx } from "./actions";
import { formValues, initialUIState, type FormModal, type Modal } from "./state";
import { Store } from "../model/store";
import { toSeries } from "../run";
import type { TaskDetail, TaskItem } from "../model/types";
import type { TaskEditFields, Transport } from "../transport/types";

const row = (id: string, agent_name: string, extra: Partial<Parameters<typeof instanceListItems>[0][number]> = {}) => ({
  id,
  template_agent_id: agent_name.toLowerCase(),
  agent_name,
  status: "running",
  parent_instance_id: null,
  process_pid: 100,
  can_steer: true,
  disabled_reason: null,
  ...extra,
});

describe("instanceListItems", () => {
  test("numbers parallel instances of one agent in list order and leaves singles unnumbered", () => {
    const items = instanceListItems([row("a1", "Coder"), row("t1", "Tester"), row("a2", "Coder", { parent_instance_id: "root" })]);
    expect(items.map((i) => i.label)).toEqual(["Coder #1", "Tester", "Coder #2"]);
    expect(items[0]!.hint).toContain("root");
    expect(items[2]!.hint).toContain("delegated");
    expect(items[2]!.data).toMatchObject({ id: "a2" });
  });

  test("shows why an instance cannot be steered", () => {
    const items = instanceListItems([
      row("w", "Coder", { status: "waiting_delegation", can_steer: false, disabled_reason: "Runtime is waiting on delegation and cannot be steered." }),
      row("n", "Coder", { can_steer: false, disabled_reason: "Runtime has no resumable session yet." }),
      row("ok", "Coder"),
    ]);
    expect(items[0]!.right).toBe("waiting on delegation");
    expect(items[0]!.glyph).toBe("◌");
    expect(items[0]!.detail).toContain("waiting on delegation");
    expect(items[1]!.right).toBe("running · not steerable");
    expect(items[1]!.detail).toBe("Runtime has no resumable session yet.");
    expect(items[2]!.right).toBe("running");
    expect(items[2]!.detail).toBeUndefined();
  });
});

const TEAMS: Assignee[] = [
  { id: "team-1", name: "Core Team", phaseCount: 2, kind: "team" },
  { id: "team-2", name: "Docs Team", phaseCount: 1, kind: "team" },
];

function taskItem(over: Partial<TaskItem> = {}): TaskItem {
  return {
    id: "t1", title: "Fix auth", status: "active", display_status: "idle", mode: "workflow", paused: false,
    memory_enabled: false, memory_mode: "off", team_id: "team-1", team_name: "Core Team", current_phase: 0,
    phase_count: 2, needs_review: false, starred: false, icon: null, icon_color: null,
    created_at: "2026-09-01 10:00:00", updated_at: null, started_at: "2026-09-01 10:01:00", source_scheduled_task_id: null,
    ...over,
  };
}

function detailOf(t: TaskItem, over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    ...t, description: "The brief: rotate the signing keys", result: null, working_directory: "/repo",
    run_input: null, completed_at: null, settled_at: null, regression_count: 0, phases: null, agent_tiles: [],
    ...over,
  };
}

/** A Ctx over a fake transport that records what the forms send. */
function fakeCtx(opts: { readTask?: Ctx["readTask"]; loadAssignees?: Ctx["loadAssignees"] } = {}) {
  const requests: Array<{ resource: string; action: string; params: Record<string, unknown> }> = [];
  const updates: Array<{ id: string; fields: TaskEditFields }> = [];
  const toasts: Array<{ text: string; level?: string }> = [];
  const ui = initialUIState("test");
  const transport: Partial<Transport> = {
    capabilities: () => ({ remote: false, globalFeed: true, fullTeamImport: true, editAnyStatus: true }),
    request: (async (resource: string, action: string, params: Record<string, unknown> = {}) => {
      requests.push({ resource, action, params });
      return {};
    }) as Transport["request"],
    updateTask: async (id, fields) => {
      updates.push({ id, fields });
    },
  };
  const ctx: Partial<Ctx> = {
    store: new Store(),
    ui,
    transport: transport as Transport,
    toast: (text, level) => void toasts.push({ text, level }),
    push: (m: Modal) => void ui.modals.push(m),
    pop: () => void ui.modals.pop(),
    loadAssignees: opts.loadAssignees ?? (async () => TEAMS),
    readTask: opts.readTask ?? (async () => null),
    loadRecurring: async () => [],
    selectTask: () => {},
  };
  const form = (): FormModal => {
    const m = ui.modals[ui.modals.length - 1];
    if (m?.kind !== "form") throw new Error("no form open");
    return m;
  };
  const field = (key: string) => form().fields.find((f) => f.key === key)!;
  const submit = async () => {
    const m = form();
    return m.onSubmit(formValues(m));
  };
  return { ctx: ctx as Ctx, requests, updates, toasts, field, submit };
}

describe("task edit form", () => {
  test("reads the task before opening, so an unloaded bundle never saves an empty brief", async () => {
    const t = taskItem({ status: "draft", display_status: "draft", started_at: null });
    const reads: string[] = [];
    const f = fakeCtx({ readTask: async (id) => (reads.push(id), detailOf(t)) });
    expect(f.ctx.store.peekBundle(t.id)).toBeNull(); // nothing cached for this task
    await openTaskForm(f.ctx, t);
    expect(reads).toEqual(["t1"]);
    const desc = f.field("description");
    expect(desc.kind === "textarea" && desc.buf.value).toBe("The brief: rotate the signing keys");
    await f.submit();
    const sent = f.requests.find((r) => r.resource === "tasks" && r.action === "update")!;
    expect(sent.params.description).not.toBe("");
    // An untouched brief and assignee are left out: tasks/update keeps the stored values.
    expect(sent.params).not.toHaveProperty("description");
    expect(sent.params).not.toHaveProperty("teamId");
    expect(sent.params).toMatchObject({ id: "t1", title: "Fix auth", mode: "workflow" });
  });

  test("sends the brief and the assignee when the operator changed them", async () => {
    const t = taskItem();
    const f = fakeCtx({ readTask: async () => detailOf(t) });
    await openTaskForm(f.ctx, t);
    const desc = f.field("description");
    if (desc.kind === "textarea") desc.buf.value = "A new brief";
    const team = f.field("teamId");
    if (team.kind === "select") team.index = team.options.findIndex((o) => o.value === "team-2");
    await f.submit();
    expect(f.updates).toEqual([{ id: "t1", fields: { title: "Fix auth", description: "A new brief", teamId: "team-2", workingDirectory: "/repo" } }]);
  });

  test("a failed assignee load keeps the current team instead of defaulting to none", async () => {
    // Active task: saved through the loopback update route, where teamId "" clears the team.
    const t = taskItem();
    const f = fakeCtx({
      readTask: async () => detailOf(t),
      loadAssignees: async () => {
        throw new Error("not connected");
      },
    });
    await openTaskForm(f.ctx, t);
    const team = f.field("teamId");
    expect(team.kind === "select" && team.options[team.index]).toMatchObject({ value: "team-1", label: "⬢ Core Team" });
    await f.submit();
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0]!.fields.teamId).toBeUndefined();
    expect(f.updates[0]!.fields).not.toHaveProperty("description");
  });

  test("refuses to open when the task cannot be read", async () => {
    const t = taskItem();
    const failing = fakeCtx({
      readTask: async () => {
        throw new Error("tasks/read timed out");
      },
    });
    await openTaskForm(failing.ctx, t);
    expect(failing.ctx.ui.modals).toHaveLength(0);
    expect(failing.toasts).toEqual([{ text: "cannot edit: tasks/read timed out", level: "error" }]);

    const gone = fakeCtx({ readTask: async () => null });
    await openTaskForm(gone.ctx, t);
    expect(gone.ctx.ui.modals).toHaveLength(0);
    expect(gone.toasts.map((x) => x.level)).toEqual(["error"]);
  });
});

describe("recurring edit form", () => {
  const grid = JSON.stringify(Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d < 5 && h === 9 ? 1 : 0))));
  // A weekly series as recurring/list sends it: the grid is a JSON string on the wire.
  const wireRow = {
    id: "s1", title: "Weekday digest", description: "Summarize yesterday", teamId: "team-1", teamName: "Core Team",
    scheduleUnit: null, scheduleAmount: null, scheduleMatrix: grid, status: "approved", starred: false,
    icon: null, iconColor: null, nextRunAt: "2026-09-28 07:00:00", lastRunAt: null, memoryMode: "off", runs: [],
  };

  test("a weekly series opens as weekly and an untouched save sends its grid back unchanged", async () => {
    const series = toSeries(wireRow);
    expect(series.scheduleMatrix).toBe(grid);
    const f = fakeCtx();
    await openRecurringForm(f.ctx, series);
    const cadence = f.field("unit");
    expect(cadence.kind === "select" && cadence.options[cadence.index]!.label).toBe("weekly");
    await f.submit();
    const sent = f.requests.find((r) => r.resource === "recurring" && r.action === "update")!;
    expect(sent.params.scheduleMatrix).toBe(grid);
    expect(sent.params).not.toHaveProperty("scheduleUnit");
    expect(sent.params).not.toHaveProperty("scheduleAmount");
  });

  test("picking an interval replaces the grid; a series without a grid is never offered weekly", async () => {
    const f = fakeCtx();
    await openRecurringForm(f.ctx, toSeries(wireRow));
    const cadence = f.field("unit");
    if (cadence.kind === "select") cadence.index = cadence.options.findIndex((o) => o.value === "hours");
    const n = f.field("amount");
    if (n.kind === "text") n.buf.value = "2";
    await f.submit();
    const sent = f.requests.find((r) => r.resource === "recurring" && r.action === "update")!;
    expect(sent.params).toMatchObject({ scheduleUnit: "hours", scheduleAmount: 2 });
    expect(sent.params).not.toHaveProperty("scheduleMatrix");

    const interval = fakeCtx();
    await openRecurringForm(interval.ctx, toSeries({ ...wireRow, scheduleUnit: "days", scheduleAmount: 1, scheduleMatrix: null }));
    const c2 = interval.field("unit");
    expect(c2.kind === "select" && c2.options.map((o) => o.value)).toEqual(["", "minutes", "hours", "days"]);
    expect(c2.kind === "select" && c2.options[c2.index]!.value).toBe("days");
  });
});
