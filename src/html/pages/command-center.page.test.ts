import { describe, it, expect } from "bun:test";
import { renderSidebarListBody, escalationHeaderSlot } from "./command-center.page";
import type { CommandCenterViewModel } from "../view-models/command-center.vm";

// The classic dock sidebar has been removed — the command center now renders the
// team-center ("tc-") layout unconditionally, with no feature flag. These tests
// lock that default in so a regression can't quietly bring the old markup back.

function vm(overrides: Partial<CommandCenterViewModel> = {}): CommandCenterViewModel {
  return {
    isIdle: true,
    mission: null,
    missionsByTask: {},
    metrics: {} as CommandCenterViewModel["metrics"],
    agentTree: [],
    delegationSummary: "",
    queue: [],
    allTasks: [],
    scheduledTasks: [],
    scheduledRuns: {},
    recentTasks: [],
    teams: [],
    escalationCount: 0,
    daemonState: "idle",
    daemonUptime: 0,
    skipperConnectEnabled: false,
    realtimeSessionActive: {},
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
