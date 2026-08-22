import { describe, it, expect } from "bun:test";
import { renderSidebarListBody } from "./command-center.page";
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
