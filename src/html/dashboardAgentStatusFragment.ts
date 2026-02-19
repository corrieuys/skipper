import { escapeHtml } from "./components";

// Keep old fragment export for backward compat with agent status page

export function dashboardAgentStatusFragment(
    agents: {
        id: string;
        name: string;
        status: string;
        current_task_id?: string | null;
    }[]
): string {
    if (agents.length === 0) {
        return `<div style="padding:0.85rem;text-align:center;color:var(--muted);font-size:0.78rem;">No agents configured</div>`;
    }
    return agents
        .map(
            (agent) => `<div class="status-row">
      <span class="badge badge-${agent.status}">${agent.status}</span>
      <a href="/agents/${escapeHtml(agent.id)}" hx-get="/agents/${escapeHtml(agent.id)}" hx-target="body" hx-push-url="true" class="status-agent">${escapeHtml(agent.name)}</a>
      <span class="muted">${agent.current_task_id ? escapeHtml(agent.current_task_id.slice(0, 8)) : "-"}</span>
    </div>`
        )
        .join("");
}
