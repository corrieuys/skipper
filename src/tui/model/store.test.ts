import { describe, it, expect } from "bun:test";
import { Store } from "./store";
import type { TaskItem } from "./types";

function task(over: Partial<TaskItem> = {}): TaskItem {
  return {
    id: "t1",
    title: "A",
    status: "active",
    display_status: "working",
    mode: "workflow",
    paused: false,
    memory_enabled: false,
    memory_mode: "off",
    team_id: "team",
    team_name: "Team",
    current_phase: 0,
    phase_count: 3,
    needs_review: false,
    starred: false,
    icon: null,
    icon_color: null,
    created_at: "2026-09-01 10:00:00",
    updated_at: null,
    started_at: null,
    source_scheduled_task_id: null,
    ...over,
  };
}

describe("Store", () => {
  it("hydrates from a snapshot and patches tasks from fat events", () => {
    const s = new Store();
    s.apply({ kind: "snapshot", tasks: [task(), task({ id: "t2", title: "B" })], escalations: [], titleGeneratorConfigured: false });
    expect(s.isHydrated).toBe(true);
    expect(s.allTasks()).toHaveLength(2);
    s.apply({ kind: "task", task: task({ id: "t1", starred: true, display_status: "idle" }) });
    expect(s.task("t1")?.starred).toBe(true);
    expect(s.task("t1")?.display_status).toBe("idle");
    // a fat event for an unknown task inserts it
    s.apply({ kind: "task", task: task({ id: "t3" }) });
    expect(s.allTasks()).toHaveLength(3);
  });

  it("drops a deleted task and its bundle", () => {
    const s = new Store();
    s.apply({ kind: "snapshot", tasks: [task()], escalations: [], titleGeneratorConfigured: false });
    s.bundle("t1").notes.push({ id: "n1", taskId: "t1", agentName: "a", content: "x", createdAt: null });
    expect(s.apply({ kind: "task_deleted", taskId: "t1" })).toBe(true);
    expect(s.task("t1")).toBeUndefined();
    expect(s.peekBundle("t1")).toBeNull();
  });

  it("tracks open escalations by id", () => {
    const s = new Store();
    const e = { id: "e1", taskId: "t1", agentId: "a", agentName: "coder", type: "question", status: "open", question: "?", response: null, createdAt: "2026-09-01 10:00:00" };
    s.apply({ kind: "escalation", escalation: e });
    expect(s.openEscalations()).toHaveLength(1);
    expect(s.escalationsFor("t1")).toHaveLength(1);
    s.apply({ kind: "escalation_resolved", escalationId: "e1", taskId: "t1" });
    expect(s.openEscalations()).toHaveLength(0);
  });

  it("dedupes notes and messages arriving twice (bundle load + fat event)", () => {
    const s = new Store();
    const note = { id: "n1", taskId: "t1", agentName: "a", content: "hello", createdAt: "2026-09-01 10:00:00" };
    expect(s.apply({ kind: "note", note })).toBe(true);
    expect(s.apply({ kind: "note", note })).toBe(false);
    expect(s.bundle("t1").notes).toHaveLength(1);
  });

  it("caps the live output tail and replaces it on backfill", () => {
    const s = new Store();
    const row = (i: number) => ({ agent_id: "a", agent_name: "a", kind: "message" as const, text: `l${i}`, stream: "stdout", created_at: null });
    s.apply({ kind: "output", taskId: "t1", rows: [row(1), row(2)], backfill: true });
    s.apply({ kind: "output", taskId: "t1", rows: Array.from({ length: 500 }, (_, i) => row(i)), backfill: false });
    expect(s.bundle("t1").output.length).toBeLessThanOrEqual(400);
    s.apply({ kind: "output", taskId: "t1", rows: [row(9)], backfill: true });
    expect(s.bundle("t1").output).toHaveLength(1);
  });

  it("reports status change only when it differs and bumps version on change", () => {
    const s = new Store();
    const v0 = s.version;
    expect(s.apply({ kind: "status", status: "connected" })).toBe(true);
    expect(s.version).toBe(v0 + 1);
    expect(s.apply({ kind: "status", status: "connected" })).toBe(false);
    expect(s.version).toBe(v0 + 1);
  });

  it("narrows the global activity feed to a task via the live roster", () => {
    const s = new Store();
    s.apply({ kind: "agents", agents: [{ id: "i1", template_agent_name: "coder", task_id: "t1", task_title: "A", status: "running", updated_at: null }] });
    s.apply({
      kind: "activity",
      activity: [
        { agent_id: "i1", agent_name: "coder", kind: "message", text: "mine", stream: "stdout", created_at: null },
        { agent_id: "i2", agent_name: "other", kind: "message", text: "theirs", stream: "stdout", created_at: null },
      ],
    });
    expect(s.activityFor("t1").map((a) => a.text)).toEqual(["mine"]);
    expect(s.counts().agents).toBe(1);
  });
});

describe("Store remote roster", () => {
  it("builds the agent roster from per-instance liveness events", () => {
    const s = new Store();
    const inst = (id: string, status: string) => ({ id, template_agent_name: "coder", task_id: "t1", task_title: "A", status, updated_at: null });
    s.apply({ kind: "instance", instance: inst("i1", "running") });
    s.apply({ kind: "instance", instance: inst("i2", "waiting_delegation") });
    expect(s.agentInstances().map((a) => a.id)).toEqual(["i2", "i1"]);
    s.apply({ kind: "instance", instance: inst("i1", "completed") });
    expect(s.agentInstances().map((a) => a.id)).toEqual(["i2"]);
  });

  it("records a permanent auth failure", () => {
    const s = new Store();
    s.apply({ kind: "auth_failed", message: "bad key" });
    expect(s.authError).toBe("bad key");
    expect(s.connStatus()).toBe("closed");
  });
});
