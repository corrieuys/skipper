import { AgentData, escapeHtml } from "./components";


export function agentDetailSummaryContent(agent: AgentData): string {
    const instanceCount = agent.running_instance_count ?? 0;
    const instancesHtml = instanceCount > 0
        ? `<span class="badge badge-running">${instanceCount} running</span>`
        : `<span class="muted">None</span>`;
    return `<div class="card">
      <div class="detail-grid">
        <div><strong>Status:</strong> <span class="badge badge-${agent.status}">${agent.status}</span></div>
        <div><strong>Model:</strong> ${escapeHtml(agent.model)}</div>
        <div><strong>Active Instances:</strong> ${instancesHtml}</div>
        <div><strong>Task:</strong> ${agent.current_task_id ?? "None"}</div>
      </div>
      ${agent.config.instruction ? `<div class="detail-desc"><strong>Instruction:</strong><p>${escapeHtml(String(agent.config.instruction))}</p></div>` : ""}
    </div>`;
}
