import { DashboardData, escapeHtml } from "./components";

// --- Dashboard: Agent Roster ---

export function dashboardRunningInstancesFragment(
    instances: NonNullable<DashboardData["runningInstances"]>
): string {
    if (instances.length === 0) {
        return `<div style="padding:0.85rem;text-align:center;color:var(--muted);font-size:0.78rem;">No active agents</div>`;
    }
    return instances
        .map((instance) => {
            const isRunning = instance.status === "running";
            const dotClass = isRunning
                ? "cmd-agent-dot-active"
                : "cmd-agent-dot-idle";
            const statusLabel = instance.status.replace(/_/g, " ");
            return `<div class="cmd-agent">
      <div class="cmd-agent-main">
        <span class="cmd-agent-dot ${dotClass}"></span>
        <span class="cmd-agent-name"><a href="/agents/${escapeHtml(instance.template_agent_id)}" hx-get="/agents/${escapeHtml(instance.template_agent_id)}" hx-target="body" hx-push-url="true">${escapeHtml(instance.template_agent_name)}</a></span>
      </div>
      <span class="badge badge-${isRunning ? "running" : "idle"}">${escapeHtml(statusLabel)}</span>
    </div>`;
        })
        .join("");
}
