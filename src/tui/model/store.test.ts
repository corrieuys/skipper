import { describe, it, expect } from "bun:test";
import { Store } from "./store";
import type { Snapshot } from "./types";

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  tasks: [],
  agents: [],
  activity: [],
  phase: null,
  metrics: { running: 0, queued: 0, completed: 0, failed: 0, activeAgentCount: 0 },
  ...over,
});

describe("Store", () => {
  it("hydrates from a snapshot", () => {
    const s = new Store();
    s.apply({ kind: "snapshot", snapshot: snap({ tasks: [{ id: "t1", title: "A", status: "running" }] }) });
    expect(s.snapshot().tasks).toHaveLength(1);
  });

  it("replaces the task set wholesale (churn drops completed tasks)", () => {
    const s = new Store();
    s.apply({ kind: "tasks", tasks: [
      { id: "t1", title: "A", status: "running" },
      { id: "t2", title: "B", status: "running" },
    ] });
    // next push omits t1 (it completed and left the active set)
    s.apply({ kind: "tasks", tasks: [{ id: "t2", title: "B", status: "running" }] });
    const ids = s.snapshot().tasks.map((t) => t.id);
    expect(ids).toEqual(["t2"]);
  });

  it("reports change only when status actually differs", () => {
    const s = new Store();
    expect(s.apply({ kind: "status", status: "connected" })).toBe(true);
    expect(s.apply({ kind: "status", status: "connected" })).toBe(false);
    expect(s.apply({ kind: "status", status: "reconnecting" })).toBe(true);
    expect(s.connStatus()).toBe("reconnecting");
  });

  it("updates agents, activity, phase and metrics independently", () => {
    const s = new Store();
    s.apply({ kind: "agents", agents: [{ id: "a1", template_agent_name: "claude", task_id: "t1", task_title: "A", status: "running" }] });
    s.apply({ kind: "activity", activity: [{ agent_id: "a1", agent_name: "claude", kind: "note", text: "plan approved", stream: "note" }] });
    s.apply({ kind: "phase", phase: { taskId: "t1", title: "A", status: "running", current: 1, total: 4, needsReview: false, phaseName: "Build" } });
    s.apply({ kind: "metrics", metrics: { running: 2, queued: 1, completed: 3, failed: 0, activeAgentCount: 2 } });
    const view = s.snapshot();
    expect(view.agents).toHaveLength(1);
    expect(view.activity[0]?.kind).toBe("note");
    expect(view.phase?.current).toBe(1);
    expect(view.metrics.running).toBe(2);
    // independent lanes: one update does not clobber another
    expect(view.activity).toHaveLength(1);
  });
});
