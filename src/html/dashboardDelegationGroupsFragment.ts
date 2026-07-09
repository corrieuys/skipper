import { type DashboardData } from "./components";
import { formatTimestamp } from "./formatTimestamp";

// --- Dashboard: Delegation Groups ---

export function dashboardDelegationGroupsFragment(
    groups: NonNullable<DashboardData["activeDelegationGroups"]>
): string {
    if (groups.length === 0) {
        return `<div style="padding:0.85rem;text-align:center;color:var(--muted);font-size:0.78rem;">No recent delegations</div>`;
    }
    return groups
        .slice(0, 1)
        .map((group) => {
            const pct = group.expected_count > 0
                ? Math.round((group.settled_count / group.expected_count) * 100)
                : 0;
            const failPct = group.expected_count > 0
                ? Math.round((group.failed_count / group.expected_count) * 100)
                : 0;
            const isRunning = group.status === "running";
            const stateLabel = isRunning ? "active" : "done";
            const timestamp = isRunning
                ? formatTimestamp(group.created_at)
                : formatTimestamp(group.completed_at ?? group.created_at);
            return `<div class="cmd-delegation">
      <div class="cmd-delegation-head">
        <span class="cmd-deleg-state cmd-deleg-state-${stateLabel}">${stateLabel}</span>
        <span class="cmd-deleg-label">${group.settled_count}/${group.expected_count} complete</span>
        <span class="cmd-deleg-time">${timestamp}</span>
      </div>
      <div class="cmd-deleg-bar">
        <div class="cmd-deleg-fill" style="width:${pct}%"></div>
        ${failPct > 0 ? `<div class="cmd-deleg-fill cmd-deleg-fill-failed" style="width:${failPct}%;position:absolute;right:0;top:0;"></div>` : ""}
      </div>
    </div>`;
        })
        .join("");
}
