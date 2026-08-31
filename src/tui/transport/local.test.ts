import { describe, it, expect } from "bun:test";
import { parseEnvelope } from "./local";

describe("parseEnvelope", () => {
  it("parses a dashboard snapshot into a snapshot event", () => {
    const raw = JSON.stringify({
      event: "snapshot",
      resource: "dashboard:snapshot",
      data: {
        tasks: [{ id: "t1", title: "A", status: "running", task_type: "standard", created_at: "2026-08-27 10:00:00" }],
        running_instances: [{ id: "a1", template_agent_name: "claude", task_id: "t1", task_title: "A", status: "running", updated_at: "2026-08-27 10:01:00" }],
        metrics: { running: 1, queued: 0, completed: 2, failed: 0, activeAgentCount: 1 },
        activity: [{ agent_id: "a1", agent_name: "claude", kind: "note", text: "plan approved", stream: "note", created_at: "2026-08-27 10:01:30" }],
        phase_indicator: { id: "t1", title: "A", status: "running", current_phase: 1, needs_review: 0, phases: [{ name: "Scope" }, { name: "Build" }, { name: "Verify" }] },
      },
    });
    const ev = parseEnvelope(raw);
    expect(ev?.kind).toBe("snapshot");
    if (ev?.kind !== "snapshot") throw new Error("wrong kind");
    expect(ev.snapshot.tasks[0]?.title).toBe("A");
    expect(ev.snapshot.agents[0]?.template_agent_name).toBe("claude");
    expect(ev.snapshot.metrics.completed).toBe(2);
    expect(ev.snapshot.activity[0]?.kind).toBe("note");
    expect(ev.snapshot.phase?.current).toBe(1);
    expect(ev.snapshot.phase?.total).toBe(3);
    expect(ev.snapshot.phase?.phaseName).toBe("Build");
  });

  it("maps live resource frames to their event kinds", () => {
    expect(parseEnvelope(JSON.stringify({ resource: "dashboard:tasks", data: { tasks: [] } }))?.kind).toBe("tasks");
    expect(parseEnvelope(JSON.stringify({ resource: "dashboard:instances", data: { running_instances: [] } }))?.kind).toBe("agents");
    expect(parseEnvelope(JSON.stringify({ resource: "dashboard:activity", data: { activity: [] } }))?.kind).toBe("activity");
    expect(parseEnvelope(JSON.stringify({ resource: "dashboard:phase-indicator", data: { task: null } }))?.kind).toBe("phase");
    expect(parseEnvelope(JSON.stringify({ resource: "dashboard:metrics", data: { running: 3 } }))?.kind).toBe("metrics");
  });

  it("defaults unknown activity kinds to 'event' and keeps note", () => {
    const ev = parseEnvelope(JSON.stringify({ resource: "dashboard:activity", data: { activity: [{ agent_id: "a1", text: "x", kind: "weird" }, { agent_id: "a2", text: "y", kind: "note" }] } }));
    if (ev?.kind !== "activity") throw new Error("wrong kind");
    expect(ev.activity[0]?.kind).toBe("event");
    expect(ev.activity[1]?.kind).toBe("note");
  });

  it("maps a null phase task to null", () => {
    const ev = parseEnvelope(JSON.stringify({ resource: "dashboard:phase-indicator", data: { task: null } }));
    if (ev?.kind !== "phase") throw new Error("wrong kind");
    expect(ev.phase).toBeNull();
  });

  it("ignores heartbeats and unknown frames", () => {
    expect(parseEnvelope(JSON.stringify({ type: "ping" }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ resource: "task:notes", data: {} }))).toBeNull();
    expect(parseEnvelope("not json")).toBeNull();
    expect(parseEnvelope("")).toBeNull();
  });

  it("tolerates missing fields with safe defaults", () => {
    const ev = parseEnvelope(JSON.stringify({ resource: "dashboard:metrics", data: {} }));
    if (ev?.kind !== "metrics") throw new Error("wrong kind");
    expect(ev.metrics.running).toBe(0);
    expect(ev.metrics.activeAgentCount).toBe(0);
  });
});
