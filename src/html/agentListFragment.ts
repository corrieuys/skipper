import { AgentData, agentTableRow } from "./components";


export function agentListFragment(agents: AgentData[]): string {
    return agents.length === 0
        ? `<div class="empty-state"><div class="empty-state-icon">&#129302;</div><p>No agents configured</p><p class="muted">Create an agent to begin orchestrating</p></div>`
        : `<table class="data-table">
        <thead><tr><th>Status</th><th>Name</th><th>Model</th><th>Task</th><th>Actions</th></tr></thead>
        <tbody>${agents.map(agentTableRow).join("")}</tbody>
      </table>`;
}
