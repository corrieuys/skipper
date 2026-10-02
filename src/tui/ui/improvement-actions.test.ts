import { describe, expect, test } from "bun:test";
import { actionForKey, type Ctx } from "./actions";
import { IMPROVEMENT_ACTIONS } from "./improvement-actions";
import { formValues, initialUIState, type FormModal, type Modal } from "./state";
import { Store } from "../model/store";
import type { ImprovementSummary, TaskItem } from "../model/types";
import type { Transport } from "../transport/types";
import type { KeyEvent } from "../input/keyboard";

function imp(over: Partial<ImprovementSummary> = {}): ImprovementSummary {
  return {
    id: "i1", kind: "phase_prompt", status: "pending", state: "ready", targetKey: "phase:tm:0:analyse",
    targetLabel: 'Team "Sales" › Phase 1 "analyse"', teamId: "tm", teamName: "Sales", scheduledTaskId: null,
    phaseIndex: 0, phaseName: "analyse", agentRef: null, skillName: null, reason: "Empty dataset.",
    sourceTaskId: null, sourceTaskTitle: null, usedByTeams: null, baseRevision: "r1", liveRevision: "r1",
    editedAt: null, decidedAt: null, createdAt: "2026-09-30 15:00:00", updatedAt: "2026-09-30 15:00:00",
    ...over,
  };
}

const draftTask: TaskItem = {
  id: "t1", title: "Draft behind the board", status: "draft", display_status: "draft", mode: "workflow", paused: false,
  memory_enabled: false, memory_mode: "off", team_id: null, team_name: null, current_phase: 0, phase_count: 0,
  needs_review: true, starred: false, icon: null, icon_color: null, created_at: "2026-09-30 10:00:00",
  updated_at: null, started_at: null, source_scheduled_task_id: null,
};

/** A Ctx on board 5 over a fake transport that records every request. */
function fakeCtx(row: ImprovementSummary | null, opts: { replies?: Record<string, unknown>; fail?: string; autoApprove?: boolean | null; features?: string[] } = {}) {
  const requests: Array<{ resource: string; action: string; params: Record<string, unknown> }> = [];
  const toasts: Array<{ text: string; level?: string }> = [];
  const selected: Array<string | null> = [];
  const store = new Store();
  store.apply({ kind: "snapshot", tasks: [draftTask], escalations: [], titleGeneratorConfigured: false });
  store.apply({ kind: "capabilities", protocolVersion: 3, features: opts.features ?? ["improvements"] });
  if (row) store.loadImprovements([row], "pending", 500);
  if (opts.autoApprove !== null) store.apply({ kind: "improvement_settings", autoApprove: opts.autoApprove ?? false });
  const ui = initialUIState("test");
  ui.filter = "improvements";
  ui.railKind = "improvement";
  ui.selectedImprovementId = row?.id ?? null;
  ui.selectedTaskId = draftTask.id; // a task stays selected behind the board
  const transport: Partial<Transport> = {
    capabilities: () => ({ remote: false, globalFeed: true, fullTeamImport: true, editAnyStatus: true }),
    request: (async (resource: string, action: string, params: Record<string, unknown> = {}) => {
      requests.push({ resource, action, params });
      if (opts.fail === action) throw new Error(`${action} failed`);
      return opts.replies?.[action] ?? {};
    }) as Transport["request"],
  };
  const ctx: Partial<Ctx> = {
    store,
    ui,
    transport: transport as Transport,
    selectedTask: () => store.task(ui.selectedTaskId ?? ""),
    selectedSeries: () => undefined,
    toast: (text, level) => void toasts.push({ text, level }),
    push: (m: Modal) => void ui.modals.push(m),
    pop: () => void ui.modals.pop(),
    exec: async (fn) => {
      try {
        const msg = await fn();
        if (msg) toasts.push({ text: msg, level: "ok" });
      } catch (err) {
        toasts.push({ text: err instanceof Error ? err.message : String(err), level: "error" });
      }
    },
    selectTask: (id) => {
      selected.push(id);
      ui.selectedTaskId = id;
      if (id) ui.railKind = "task";
    },
  };
  const available = () => IMPROVEMENT_ACTIONS.filter((a) => a.when(ctx as Ctx)).map((a) => a.id);
  const run = async (id: string) => IMPROVEMENT_ACTIONS.find((a) => a.id === id)!.run(ctx as Ctx);
  const top = () => ui.modals[ui.modals.length - 1];
  return { ctx: ctx as Ctx, store, ui, requests, toasts, selected, available, run, top };
}

const key = (ch: string): KeyEvent => ({ type: "char", ch });

describe("improvement action state table", () => {
  const ALWAYS = ["improvement-scope", "improvement-auto-approve"];
  const cases: Array<[string, ImprovementSummary, string[]]> = [
    ["pending ready", imp(), ["improvement-approve", "improvement-edit", "improvement-reject"]],
    ["conflict: edit to resolve, no approve", imp({ state: "conflict", liveRevision: "r2" }), ["improvement-edit", "improvement-reject"]],
    ["target gone: reject only", imp({ state: "missing", liveRevision: null }), ["improvement-reject"]],
    ["skill suggestion: acknowledge, edit, dismiss", imp({ kind: "skill_suggestion", state: "suggestion", baseRevision: null, liveRevision: null }), ["improvement-acknowledge", "improvement-edit", "improvement-dismiss"]],
    ["approved: nothing to decide", imp({ status: "approved", state: "decided" }), []],
    ["rejected: nothing to decide", imp({ status: "rejected", state: "decided" }), []],
  ];
  for (const [name, row, expected] of cases) {
    test(name, () => {
      expect(fakeCtx(row).available()).toEqual([...expected, ...ALWAYS]);
    });
  }

  test("t needs a source task, z needs a loaded diff, A needs the gate's state", () => {
    const f = fakeCtx(imp({ sourceTaskId: "t1" }), { autoApprove: null });
    expect(f.available()).toContain("improvement-source");
    expect(f.available()).not.toContain("improvement-expand");
    expect(f.available()).not.toContain("improvement-auto-approve");
    f.store.setImprovementDetail({ ...imp({ sourceTaskId: "t1" }), proposedText: "b", beforeText: "a", liveText: "a", diff: [{ op: "add", text: "b" }], diffBase: "live" });
    expect(f.available()).toContain("improvement-expand");
  });

  test("off board 5, or without the feature, nothing is available", () => {
    const f = fakeCtx(imp());
    f.ui.filter = "latest";
    expect(f.available()).toEqual([]);
    expect(fakeCtx(imp(), { features: [] }).available()).toEqual([]);
  });

  test("keys reach the improvement, not the draft task still selected behind the board", () => {
    const f = fakeCtx(imp());
    expect(actionForKey(f.ctx, key("a"))?.id).toBe("improvement-approve");
    expect(actionForKey(f.ctx, key("y"))?.id).toBe("improvement-approve");
    expect(actionForKey(f.ctx, key("x"))?.id).toBe("improvement-reject");
    expect(actionForKey(f.ctx, key("N"))?.id).toBe("improvement-reject");
    expect(actionForKey(f.ctx, key("e"))?.id).toBe("improvement-edit");
    expect(actionForKey(f.ctx, key("A"))?.id).toBe("improvement-auto-approve");
    expect(actionForKey(f.ctx, key("f"))?.id).toBe("improvement-scope");
    expect(actionForKey(f.ctx, key("i"))).toBeNull(); // no composer for the hidden task
    const skill = fakeCtx(imp({ kind: "skill_suggestion", state: "suggestion" }));
    expect(actionForKey(skill.ctx, key("a"))?.id).toBe("improvement-acknowledge");
    expect(actionForKey(skill.ctx, key("x"))?.id).toBe("improvement-dismiss");
  });
});

describe("improvement action requests", () => {
  test("approve sends improvements/approve and only toasts (no list reload)", async () => {
    const f = fakeCtx(imp());
    await f.run("improvement-approve");
    expect(f.requests).toEqual([{ resource: "improvements", action: "approve", params: { id: "i1" } }]);
    expect(f.toasts).toEqual([{ text: 'approved: Team "Sales" › Phase 1 "analyse"', level: "ok" }]);
    expect(f.store.improvement("i1")!.status).toBe("pending"); // the fat event, not the reply, patches the store
  });

  test("acknowledge a skill suggestion is an approve", async () => {
    const f = fakeCtx(imp({ kind: "skill_suggestion", state: "suggestion", targetLabel: 'Skill "xlsx"' }));
    await f.run("improvement-acknowledge");
    expect(f.requests).toEqual([{ resource: "improvements", action: "approve", params: { id: "i1" } }]);
    expect(f.toasts[0]!.text).toBe('acknowledged: Skill "xlsx"');
  });

  test("a refused approve shows the daemon's error", async () => {
    const f = fakeCtx(imp(), { fail: "approve" });
    await f.run("improvement-approve");
    expect(f.toasts).toEqual([{ text: "approve failed", level: "error" }]);
  });

  test("reject asks first, then sends improvements/reject", async () => {
    const f = fakeCtx(imp());
    await f.run("improvement-reject");
    expect(f.requests).toEqual([]);
    const m = f.top();
    if (m?.kind !== "confirm") throw new Error("no confirm");
    expect(m.confirmLabel).toBe("Reject");
    expect(await m.onConfirm()).toBe('rejected: Team "Sales" › Phase 1 "analyse"');
    expect(f.requests).toEqual([{ resource: "improvements", action: "reject", params: { id: "i1" } }]);
  });

  test("edit reads first, opens the proposed text, ctrl+l shows the live text, ctrl+s sends edit", async () => {
    const detail = { ...imp({ state: "conflict", liveRevision: "r2" }), proposedText: "old line\nnew rule", beforeText: "old line", liveText: "changed line", diff: [], diffBase: "live" };
    const f = fakeCtx(imp({ state: "conflict", liveRevision: "r2" }), { replies: { read: detail } });
    await f.run("improvement-edit");
    expect(f.requests).toEqual([{ resource: "improvements", action: "read", params: { id: "i1" } }]);
    expect(f.store.improvementDetail("i1")?.proposedText).toBe("old line\nnew rule");
    const form = f.top() as FormModal;
    expect(form.kind).toBe("form");
    const field = form.fields.find((x) => x.key === "text")!;
    if (field.kind !== "textarea") throw new Error("no textarea");
    expect(field.buf.value).toBe("old line\nnew rule");
    expect(form.onKey?.({ type: "ctrl", ch: "l" }, form)).toBe(true);
    const live = f.top();
    expect(live?.kind === "text" && live.body).toBe("changed line");
    f.ui.modals.pop();
    field.buf.value = "changed line\nnew rule";
    expect(await form.onSubmit(formValues(form))).toBe('saved: Team "Sales" › Phase 1 "analyse". a approves it');
    expect(f.requests[1]).toEqual({ resource: "improvements", action: "edit", params: { id: "i1", text: "changed line\nnew rule" } });
  });

  test("edit refuses with an error toast when the read fails", async () => {
    const f = fakeCtx(imp(), { fail: "read" });
    await f.run("improvement-edit");
    expect(f.ui.modals).toEqual([]);
    expect(f.toasts).toEqual([{ text: "cannot edit: read failed", level: "error" }]);
  });

  test("auto-approve: turning on asks first, turning off does not", async () => {
    const off = fakeCtx(imp(), { autoApprove: false });
    await off.run("improvement-auto-approve");
    expect(off.requests).toEqual([]);
    const m = off.top();
    if (m?.kind !== "confirm") throw new Error("no confirm");
    await m.onConfirm();
    expect(off.requests).toEqual([{ resource: "improvements", action: "set-auto-approve", params: { on: true } }]);
    expect(off.store.autoApprove).toBe(false); // the settings event flips it, not the reply

    const on = fakeCtx(imp(), { autoApprove: true });
    await on.run("improvement-auto-approve");
    expect(on.ui.modals).toEqual([]);
    expect(on.requests).toEqual([{ resource: "improvements", action: "set-auto-approve", params: { on: false } }]);
  });

  test("f loads every improvement once for All, and back to Pending without a request", async () => {
    const decided = { ...imp({ id: "d1", status: "approved", state: "decided", createdAt: "2026-09-30 16:00:00" }) };
    const f = fakeCtx(imp(), { replies: { list: [decided, imp()] } });
    await f.run("improvement-scope");
    expect(f.ui.improvementScope).toBe("all");
    expect(f.requests).toEqual([{ resource: "improvements", action: "list", params: { status: "all", limit: 500 } }]);
    expect(f.store.improvement("d1")?.status).toBe("approved");
    expect(f.ui.selectedImprovementId).toBe("i1"); // still listed: the cursor stays
    await f.run("improvement-scope");
    expect(f.ui.improvementScope).toBe("pending");
    expect(f.requests).toHaveLength(1);
  });

  test("f to Pending moves the cursor off a decided row", async () => {
    const f = fakeCtx(imp({ id: "p1" }));
    f.store.loadImprovements([imp({ id: "p1" }), imp({ id: "d1", status: "rejected", state: "decided" })], "all", 500);
    f.ui.improvementScope = "all";
    f.ui.selectedImprovementId = "d1";
    await f.run("improvement-scope");
    expect(f.ui.selectedImprovementId).toBe("p1");
  });

  test("t jumps to the source task on the All board", async () => {
    const f = fakeCtx(imp({ sourceTaskId: "t1" }));
    await f.run("improvement-source");
    expect(f.selected).toEqual(["t1"]);
    expect(f.ui.filter).toBe("all");
    expect(f.ui.railKind).toBe("task");
    const gone = fakeCtx(imp({ sourceTaskId: "nope" }));
    await gone.run("improvement-source");
    expect(gone.selected).toEqual([]);
    expect(gone.toasts[0]!.level).toBe("warn");
  });

  test("z toggles the folded diff", async () => {
    const f = fakeCtx(imp());
    f.store.setImprovementDetail({ ...imp(), proposedText: "b", beforeText: "a", liveText: "a", diff: [{ op: "add", text: "b" }], diffBase: "live" });
    await f.run("improvement-expand");
    expect(f.ui.improvementDiffExpanded).toBe(true);
    await f.run("improvement-expand");
    expect(f.ui.improvementDiffExpanded).toBe(false);
    expect(f.requests).toEqual([]);
  });
});
