export function dashboardActiveAgentsCountFragment(count: number): string {
    return `<span id="running-instances-count"
    class="cmd-progress-value"
    hx-get="/fragments/dashboard/running-instances-count"
    hx-trigger="load"
    hx-target="this"
    hx-swap="outerHTML">${count}</span>`;
}
