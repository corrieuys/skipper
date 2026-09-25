import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../../db/connection";
import {
  renderSidebarListBody,
  escalationHeaderSlot,
  renderPhaseStripFragment,
  renderTaskPhaseStrip,
} from "./command-center.page";
import { buildCommandCenterViewModel, type CommandCenterViewModel } from "../view-models/command-center.vm";

// The classic dock sidebar has been removed — the command center now renders the
// team-center ("tc-") layout unconditionally, with no feature flag. These tests
// lock that default in so a regression can't quietly bring the old markup back.

function vm(overrides: Partial<CommandCenterViewModel> = {}): CommandCenterViewModel {
  return {
    isIdle: true,
    mission: null,
    missionsByTask: {},
    allTasks: [],
    scheduledTasks: [],
    scheduledRuns: {},
    teams: [],
    escalationCount: 0,
    daemonState: "idle",
    daemonUptime: 0,
    skipperConnectEnabled: false,
    ...overrides,
  };
}

describe("escalationHeaderSlot", () => {
  it("renders an empty stable-id slot when there are no open escalations", () => {
    const html = escalationHeaderSlot("task-1", 0);
    expect(html).toContain('id="mc-task-escalation-task-1"'); // stable id → OOB-swappable live
    expect(html).not.toContain("escalation<"); // no badge text
    expect(html).not.toContain("sk-badge");
  });

  it("renders a singular label for one escalation", () => {
    const html = escalationHeaderSlot("task-1", 1);
    expect(html).toContain("1 escalation");
    expect(html).not.toContain("1 escalations");
    expect(html).toContain("sk-badge");
  });

  it("renders a pluralised count for multiple escalations", () => {
    expect(escalationHeaderSlot("task-1", 3)).toContain("3 escalations");
  });
});

describe("command center sidebar (v2 is the only UI)", () => {
  it("renders the tc- liveness sections by default", () => {
    const html = renderSidebarListBody(vm(), null);
    expect(html).toContain("tc-side");
    expect(html).toContain("Active");
    expect(html).toContain("Teams");
    expect(html).toContain("Task history");
  });

  it("does not render any classic dock sidebar markup", () => {
    const html = renderSidebarListBody(vm(), null);
    expect(html).not.toContain("mc-sidebar__group-label");
    expect(html).not.toContain("Queue (");
  });
});

describe("renderTaskPhaseStrip (the 5 s phase-strip poll)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDatabase(db);
    db.exec("INSERT INTO agents (id, name, type, model, config, capabilities) VALUES ('lead', 'Lead', 'codex', 'default', '{}', '[]')");
    db.prepare("INSERT INTO teams (id, name, entrypoint_agent_id, phases) VALUES ('team-p', 'Phased', 'lead', ?)")
      .run(JSON.stringify([{ name: "Plan" }, { name: "Build" }, { name: "Ship" }]));
    db.exec("INSERT INTO teams (id, name, entrypoint_agent_id, phases) VALUES ('team-n', 'Flat', 'lead', '[]')");
    const task = db.prepare(
      `INSERT INTO tasks (id, title, team_id, status, current_phase, needs_review, result, source_scheduled_task_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    );
    task.run("working", "Working", "team-p", "active", 1, 0, null, null);
    task.run("review", "Review", "team-p", "active", 1, 1, null, null);
    task.run("idle", "Idle", "team-p", "active", 2, 0, null, null);
    task.run("done", "Done", "team-p", "settled", 2, 0, JSON.stringify({ summary: "ok" }), null);
    task.run("failed", "Failed", "team-p", "settled", 1, 0, JSON.stringify({ error: "boom" }), null);
    task.run("flat", "Flat", "team-n", "active", 0, 0, null, null);
    task.run("run-ok", "Run", "team-p", "settled", 2, 0, JSON.stringify({ summary: "ok" }), "series-1");
    db.exec("INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('i1', 'working', 'lead', 'running')");
  });

  afterEach(() => {
    db.close();
  });

  // What the route rendered before, from the whole view model.
  function viaFullViewModel(taskId: string): string {
    const full = buildCommandCenterViewModel(db);
    const task = full.allTasks.find((t) => t.id === taskId);
    if (!task) return "";
    const mission = full.missionsByTask[taskId];
    return renderPhaseStripFragment(mission?.phases ?? [], taskId, task.display_status === "working");
  }

  it("renders the same strip the full view model did, per task", () => {
    for (const id of ["working", "review", "idle", "done", "failed", "flat", "run-ok", "missing"]) {
      expect(renderTaskPhaseStrip(db, id)).toBe(viaFullViewModel(id));
    }
  });

  it("keeps polling only while the task works, and is empty when there is nothing to show", () => {
    expect(renderTaskPhaseStrip(db, "working")).toContain('hx-get="/workspace/task/working/phase-strip" hx-trigger="every 5s"');
    expect(renderTaskPhaseStrip(db, "idle")).toContain('id="mc-phase-stepper-idle"');
    expect(renderTaskPhaseStrip(db, "idle")).not.toContain("hx-trigger");
    expect(renderTaskPhaseStrip(db, "flat")).toBe(""); // team without phases
    expect(renderTaskPhaseStrip(db, "run-ok")).toBe(""); // cleanly settled run: not in the list
    expect(renderTaskPhaseStrip(db, "missing")).toBe("");
  });
});
