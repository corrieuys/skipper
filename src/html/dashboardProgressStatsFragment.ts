import type { DashboardData } from "./components";


export function dashboardProgressStatsFragment(
    runningInstances: NonNullable<DashboardData["runningInstances"]>,
    delegationGroups: NonNullable<DashboardData["activeDelegationGroups"]>,
    phaseIndicatorTask: NonNullable<DashboardData["phaseIndicatorTask"]> | null
): string {
    const phaseCountLabel = phaseIndicatorTask
        ? `phase ${phaseIndicatorTask.current_phase + 1}`
        : "idle";
    return `<div class="cmd-progress-stats">
    <span id="dashboard-progress-agents-stat" class="cmd-progress-stat">${runningInstances.length} agents</span>
    <span id="dashboard-progress-delegations-stat" class="cmd-progress-stat">${delegationGroups.length} delegations</span>
    <span id="dashboard-progress-phase-stat" class="cmd-progress-stat">${phaseCountLabel}</span>
  </div>`;
}
