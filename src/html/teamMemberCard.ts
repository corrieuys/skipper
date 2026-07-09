import { type TeamData, type TeamAgentData, escapeHtml } from "./components";


export function teamMemberCard(_team: TeamData, a: TeamAgentData): string {
    return `<div class="member-card">
      <div class="member-card-head">
        <strong>${escapeHtml(a.agent_name)}</strong>
      </div>
      <dl class="data-list">
        <dt>Role</dt><dd>${a.role ? escapeHtml(a.role) : '<span class="muted">-</span>'}</dd>
        <dt>Level</dt><dd>${a.level}</dd>
        <dt>Skills</dt><dd>${a.capabilities.length > 0 ? escapeHtml(a.capabilities.join(", ")) : '<span class="muted">—</span>'}</dd>
      </dl>
    </div>`;
}
