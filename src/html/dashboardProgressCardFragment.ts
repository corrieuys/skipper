import { DashboardData, PollIntervalSeconds } from "./components";
import { dashboardProgressStatsFragment } from "./dashboardProgressStatsFragment";
import { dashboardPhaseIndicatorFragment } from "./dashboardPhaseIndicatorFragment";
import { dashboardDelegationGroupsFragment } from "./dashboardDelegationGroupsFragment";
import { dashboardSteerListFragment, type SteeringOption } from "./dashboardLatestSteerFragment";


export function dashboardProgressCardFragment(data: {
  runningInstances: NonNullable<DashboardData["runningInstances"]>;
  delegationGroups: NonNullable<DashboardData["activeDelegationGroups"]>;
  phaseIndicatorTask: NonNullable<DashboardData["phaseIndicatorTask"]> | null;
  pollIntervalSeconds: PollIntervalSeconds;
  latestSteerOptions?: SteeringOption[];
}): string {
  const {
    runningInstances, delegationGroups, phaseIndicatorTask, pollIntervalSeconds,
    latestSteerOptions = [],
  } = data;
  const phaseCountLabel = phaseIndicatorTask
    ? `phase ${phaseIndicatorTask.current_phase + 1}`
    : "idle";

  return `<div class="cmd-panel cmd-layout-progress">
    <div class="cmd-panel-header cmd-progress-header">
      <span class="cmd-panel-title">Progress</span>
      ${dashboardProgressStatsFragment(runningInstances, delegationGroups, phaseIndicatorTask)}
    </div>
    <div class="cmd-progress-grid">
      <div class="cmd-progress-phase-wrap">
        <div class="cmd-progress-section-head cmd-progress-section-head-phase">
          <span class="cmd-progress-label">Phase</span>
          <span id="dashboard-phase-indicator-count" class="cmd-progress-value">${phaseCountLabel}</span>
        </div>
        <div id="dashboard-phase-indicator"
          class="cmd-progress-phase-body"
          hx-get="/fragments/dashboard/phase-indicator"
          hx-trigger="load"
          hx-target="this"
          hx-swap="innerHTML">
          ${dashboardPhaseIndicatorFragment(phaseIndicatorTask)}
        </div>
      </div>
      <div class="cmd-progress-columns">
        <section class="cmd-progress-section">
          <div class="cmd-progress-section-head">
            <span class="cmd-progress-label">Active Agent</span>
          </div>
          <div id="dashboard-latest-steer" style="min-height:8rem;"
            hx-get="/fragments/dashboard/latest-steer"
            hx-trigger="load"
            hx-target="this"
            hx-swap="innerHTML">
            ${dashboardSteerListFragment(latestSteerOptions)}
          </div>
        </section>
        <section class="cmd-progress-section">
          <div class="cmd-progress-section-head">
            <span class="cmd-progress-label">Delegations</span>
            <span id="dashboard-delegations-count" class="cmd-progress-value">${delegationGroups.length > 0 ? "latest" : "0"}</span>
          </div>
          <div id="dashboard-delegations" class="cmd-progress-section-body">
            ${dashboardDelegationGroupsFragment(delegationGroups)}
          </div>
        </section>
      </div>
    </div>
  </div>`;
}
