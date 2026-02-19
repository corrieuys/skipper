
export function metricsFragment(metrics: {
    mttrMinutes: number | null;
    stuckTaskCount: number;
    totalRunningTasks: number;
    delegationSuccessRate: number | null;
    remediationEventCount: number;
}): string {
    function fmtPct(n: number | null): string {
        if (n == null) return "-";
        return `${Math.round(n * 100)}%`;
    }
    function fmtMin(n: number | null): string {
        if (n == null) return "-";
        if (n >= 60) return `${(n / 60).toFixed(1)}h`;
        return `${Math.round(n)}m`;
    }

    return `<div class="metrics-grid">
    <div class="metric-card"><div class="metric-value">${fmtMin(metrics.mttrMinutes)}</div><div class="metric-label">MTTR (7d avg)</div></div>
    <div class="metric-card"><div class="metric-value${metrics.stuckTaskCount > 0 ? " health-alert" : ""}">${metrics.stuckTaskCount}/${metrics.totalRunningTasks}</div><div class="metric-label">Stuck Tasks</div></div>
    <div class="metric-card"><div class="metric-value">${fmtPct(metrics.delegationSuccessRate)}</div><div class="metric-label">Delegation Success</div></div>
    <div class="metric-card"><div class="metric-value">${metrics.remediationEventCount}</div><div class="metric-label">Remediations (24h)</div></div>
  </div>`;
}
