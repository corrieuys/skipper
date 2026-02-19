import type { PollIntervalSeconds } from "./components";


export function dashboardActiveAgentsCountFragment(
    count: number,
    pollIntervalSeconds: PollIntervalSeconds
): string {
    return `<span id="running-instances-count"
    class="cmd-progress-value"
    hx-get="/fragments/dashboard/running-instances-count"
    hx-trigger="load"
    hx-target="this"
    hx-swap="outerHTML">${count}</span>`;
}
