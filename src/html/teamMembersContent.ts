import { TeamData, TeamAgentData, AgentOptionData } from "./components";
import { teamMemberCard } from "./teamMemberCard";


export function teamMembersContent(
  team: TeamData,
  agents: TeamAgentData[],
  _availableAgents: AgentOptionData[],
  _includeAddAgentForm: boolean = true
): string {
  return `<section class="card team-section">
      <div class="team-section-header">
        <h2>Members</h2>
        <span class="muted">${agents.length} total</span>
      </div>
      ${agents.length === 0
      ? `<div class="empty-state"><div class="empty-state-icon">&#128101;</div><p>No agents in this team</p></div>`
      : `<div class="member-card-list">
        ${agents.map((a) => teamMemberCard(team, a)).join("")}
      </div>`}
    </section>`;
}
