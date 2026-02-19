import { TaskHealthSummary } from "./components";
import { formatTimestamp } from "./formatTimestamp";


export function taskHealthSummaryFragment(health: TaskHealthSummary): string {
    return `<div class="health-summary">
    <div class="health-metric"><span class="health-value">${health.liveRuntimeCount}</span><span class="health-label">Live Runtimes</span></div>
    <div class="health-metric"><span class="health-value">${health.activeDelegationCount}</span><span class="health-label">Active Delegations</span></div>
    <div class="health-metric"><span class="health-value${health.openEscalationCount > 0 ? " health-alert" : ""}">${health.openEscalationCount}</span><span class="health-label">Open Escalations</span></div>
    <div class="health-metric"><span class="health-value">${health.remediationEventCount}</span><span class="health-label">Remediations</span></div>
    ${health.lastProgressAt ? `<div class="health-metric"><span class="health-value">${formatTimestamp(health.lastProgressAt)}</span><span class="health-label">Last Progress</span></div>` : ""}
  </div>`;
}
