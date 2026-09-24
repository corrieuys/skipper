import { describe, it, expect } from "bun:test";
import { mapConnectEvent, parseDashboardFrame, toTask } from "./local";

const taskWire = {
  id: "t1",
  title: "A",
  status: "active",
  display_status: "working",
  mode: "workflow",
  paused: false,
  memory_enabled: true,
  memory_mode: "run",
  team_id: "team",
  team_name: "Team",
  current_phase: 2,
  phase_count: 4,
  needs_review: false,
  starred: true,
  icon: "rocket",
  icon_color: "#fff",
  created_at: "2026-09-01 10:00:00",
  updated_at: null,
  started_at: "2026-09-01 10:01:00",
  source_scheduled_task_id: null,
};

describe("mapConnectEvent", () => {
  it("turns fat task events into task patches", () => {
    const ev = mapConnectEvent("task:state_changed", { taskId: "t1", previousStatus: "active", newStatus: "active", task: taskWire });
    expect(ev?.kind).toBe("task");
    if (ev?.kind !== "task") throw new Error("wrong kind");
    expect(ev.task.starred).toBe(true);
    expect(ev.task.current_phase).toBe(2);
    expect(ev.task.icon).toBe("rocket");
  });

  it("maps a deletion to task_deleted even without a projection", () => {
    expect(mapConnectEvent("task:state_changed", { taskId: "t1", previousStatus: "draft", newStatus: "deleted" })).toEqual({ kind: "task_deleted", taskId: "t1" });
  });

  it("maps escalations, notes, messages, timeline entries and artifacts", () => {
    expect(mapConnectEvent("escalation:created", { escalationId: "e1", escalation: { id: "e1", taskId: "t1", agentId: "a", status: "open", question: "?", createdAt: "x" } })?.kind).toBe("escalation");
    expect(mapConnectEvent("escalation:resolved", { escalationId: "e1", taskId: "t1" })).toEqual({ kind: "escalation_resolved", escalationId: "e1", taskId: "t1" });
    expect(mapConnectEvent("task:note_added", { noteId: "n1", note: { id: "n1", taskId: "t1", content: "hi", createdAt: "x" } })?.kind).toBe("note");
    expect(mapConnectEvent("task:message_posted", { messageId: "m1", message: { id: "m1", taskId: "t1", content: "hi", createdAt: "x" } })?.kind).toBe("message");
    const tl = mapConnectEvent("realtime:timeline_updated", { entryId: "x", entry: { id: "x", taskId: "t1", entryType: "image", content: "", fedToSkipper: false, createdAt: "x", artifact: { name: "shot.png" } } });
    if (tl?.kind !== "timeline") throw new Error("wrong kind");
    expect(tl.entry.artifactName).toBe("shot.png");
    expect(mapConnectEvent("artifact:created", { artifactId: "a1", artifact: { id: "a1", taskId: "t1", name: "plan", kind: "doc", version: 1, createdAt: "x", storage: "inline" } })?.kind).toBe("artifact");
  });

  it("ignores events it does not render and fat events missing their projection", () => {
    expect(mapConnectEvent("realtime:audio_lock", {})).toBeNull();
    expect(mapConnectEvent("task:created", { taskId: "t1" })).toBeNull();
    expect(mapConnectEvent("connect:capabilities", { protocolVersion: 3, features: ["snapshot"] })).toEqual({ kind: "capabilities", protocolVersion: 3, features: ["snapshot"] });
  });
});

describe("parseDashboardFrame", () => {
  it("splits a dashboard snapshot into roster, activity and metrics lanes", () => {
    const raw = JSON.stringify({
      resource: "dashboard:snapshot",
      data: {
        running_instances: [{ id: "i1", template_agent_name: "claude", task_id: "t1", task_title: "A", status: "running" }],
        activity: [{ agent_id: "i1", agent_name: "claude", kind: "weird", text: "x" }],
        metrics: { running: 1, completed: 2 },
      },
    });
    const evs = parseDashboardFrame(raw);
    expect(evs.map((e) => e.kind)).toEqual(["agents", "activity", "metrics"]);
    const act = evs[1];
    if (act?.kind !== "activity") throw new Error("wrong kind");
    expect(act.activity[0]?.kind).toBe("event"); // unknown kinds default to event
  });

  it("maps live frames and drops heartbeats / unknown resources", () => {
    expect(parseDashboardFrame(JSON.stringify({ resource: "dashboard:instances", data: { running_instances: [] } }))[0]?.kind).toBe("agents");
    expect(parseDashboardFrame(JSON.stringify({ resource: "dashboard:metrics", data: { running: 3 } }))[0]?.kind).toBe("metrics");
    expect(parseDashboardFrame(JSON.stringify({ type: "ping" }))).toEqual([]);
    expect(parseDashboardFrame(JSON.stringify({ resource: "dashboard:tasks", data: {} }))).toEqual([]);
    expect(parseDashboardFrame("nope")).toEqual([]);
  });
});

describe("toTask", () => {
  it("fills safe defaults for a sparse projection", () => {
    const t = toTask({ id: "x" });
    expect(t.display_status).toBe("");
    expect(t.mode).toBe("workflow");
    expect(t.phase_count).toBeNull();
    expect(t.starred).toBe(false);
  });
});

describe("mapConnectEvent: edits, recurring and team changes", () => {
  it("flags a same-status task event as an edit, a transition not", () => {
    const edit = mapConnectEvent("task:state_changed", { taskId: "t1", previousStatus: "active", newStatus: "active", task: taskWire });
    expect(edit).toMatchObject({ kind: "task", edited: true });
    const move = mapConnectEvent("task:state_changed", { taskId: "t1", previousStatus: "active", newStatus: "settled", task: taskWire });
    expect(move?.kind).toBe("task");
    expect((move as { edited?: boolean }).edited).toBeUndefined();
  });

  it("maps recurring:changed and team:changed with their fat rows", () => {
    expect(mapConnectEvent("recurring:changed", { scheduledTaskId: "s1", change: "updated", recurring: { id: "s1", title: "Nightly" } })).toEqual({
      kind: "recurring_changed", id: "s1", deleted: false, row: { id: "s1", title: "Nightly" },
    });
    expect(mapConnectEvent("recurring:changed", { scheduledTaskId: "s1", change: "deleted" })).toEqual({ kind: "recurring_changed", id: "s1", deleted: true, row: null });
    expect(mapConnectEvent("team:changed", { teamId: "tm", change: "created", team: { id: "tm", name: "Crew" } })).toEqual({
      kind: "team_changed", id: "tm", deleted: false, row: { id: "tm", name: "Crew" },
    });
  });

  it("maps remote_team_repo:changed so an open repos browser reloads", () => {
    expect(mapConnectEvent("remote_team_repo:changed", { repoId: "abcd1234", change: "updated", repo: { id: "abcd1234" } })).toEqual({
      kind: "remote_repo_changed", id: "abcd1234", deleted: false,
    });
    expect(mapConnectEvent("remote_team_repo:changed", { repoId: "abcd1234", change: "deleted" })).toEqual({
      kind: "remote_repo_changed", id: "abcd1234", deleted: true,
    });
  });
});
