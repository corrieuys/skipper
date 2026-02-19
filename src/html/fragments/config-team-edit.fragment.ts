import { escapeHtml } from "../atoms/escape-html";
import type { TeamDefinition, AgentDefinition } from "../../config/store";
import { isExperimental } from "../../config/feature-flags";

export function configTeamEditFragment(team: TeamDefinition, allAgents: AgentDefinition[]): string {
  const eid = escapeHtml(team.id);

  const agentOptions = (selected: string | null) =>
    `<option value="">— none —</option>` +
    allAgents.map((a) =>
      `<option value="${escapeHtml(a.id)}"${a.id === selected ? " selected" : ""}>${escapeHtml(a.name)}</option>`
    ).join("");

  const phasesHtml = team.phases.map((p, i) => phaseForm(p, i, allAgents)).join("");
  const membersHtml = team.members.map((m, i) => memberRow(m, i, allAgents)).join("");

  return `<tr id="team-edit-${eid}" class="sk-edit-row">
    <td colspan="4">
      <form id="team-edit-form-${eid}" hx-post="/api/config/teams/${eid}" hx-target="#team-row-${eid}" hx-swap="outerHTML"
            hx-encoding="application/json" class="sk-inline-edit-form"
            onsubmit="event.preventDefault(); Skipper.submitTeamEdit('${eid}');">
        <div class="sk-inline-edit-form__grid">
          <div class="sk-inline-edit-form__field">
            <span class="sk-inline-edit-form__label">Name</span>
            <span class="sk-inline-edit-form__hint">Display name for this team in task creation and the sidebar.</span>
            <input type="text" name="name" value="${escapeHtml(team.name)}" class="sk-input sk-input--sm" required>
          </div>
          <div class="sk-inline-edit-form__field">
            <span class="sk-inline-edit-form__label">Entrypoint Agent</span>
            <span class="sk-inline-edit-form__hint">The agent that receives the initial task prompt and orchestrates the team.</span>
            <select name="entrypoint_agent_id" class="sk-select sk-select--sm">${agentOptions(team.entrypoint_agent_id)}</select>
          </div>
        </div>
        <div class="sk-inline-edit-form__field" style="margin-top:var(--sk-space-3);">
          <span class="sk-inline-edit-form__label">Goal</span>
          <span class="sk-inline-edit-form__hint">High-level objective injected into the team's system prompt. Guides phase transitions and completion criteria.</span>
          <textarea name="goal" rows="3" class="sk-textarea sk-textarea--sm">${escapeHtml(team.goal ?? "")}</textarea>
        </div>

        <!-- Phases -->
        <div class="sk-inline-edit-form__section">
          <div class="sk-inline-edit-form__section-header">
            <span class="sk-inline-edit-form__label" style="margin:0;">Phases</span>
            <span class="sk-inline-edit-form__hint" style="flex:1;">Ordered pipeline stages. The team advances through phases sequentially.</span>
            <button type="button" class="sk-btn sk-btn--sm" onclick="Skipper.addPhaseForm(this.closest('form'))">+ Add Phase</button>
          </div>
          <div id="team-phases-${eid}" class="sk-inline-edit-form__phases">
            ${phasesHtml}
          </div>
        </div>

        <!-- Members -->
        <div class="sk-inline-edit-form__section">
          <div class="sk-inline-edit-form__section-header">
            <span class="sk-inline-edit-form__label" style="margin:0;">Members</span>
            <span class="sk-inline-edit-form__hint" style="flex:1;">Agents available for delegation within this team.</span>
            <button type="button" class="sk-btn sk-btn--sm" onclick="Skipper.addMemberRow(this.closest('form'))">+ Add Member</button>
          </div>
          <table class="sk-table sk-table--compact" style="margin:0;">
            <thead><tr><th>Agent</th><th>Role</th><th style="width:70px;">Level</th><th style="width:36px;"></th></tr></thead>
            <tbody id="team-members-${eid}">
              ${membersHtml}
            </tbody>
          </table>
        </div>

        <div class="sk-inline-edit-form__actions">
          <button type="submit" class="sk-btn sk-btn--primary sk-btn--sm">Save</button>
          <button type="button" class="sk-btn sk-btn--sm" onclick="document.getElementById('team-edit-${eid}').remove()">Cancel</button>
        </div>
      </form>
    </td>
  </tr>`;
}

function phaseForm(phase: { name: string; prompt: string; review?: boolean; consensus?: { agent_count: number; strategy: string; worktree: boolean; reviewer_agent_id?: string } }, index: number, allAgents: AgentDefinition[]): string {
  const con = phase.consensus;
  const strategyOptions = ["best_of", "majority", "merge"].map((s) =>
    `<option value="${s}"${con?.strategy === s ? " selected" : ""}>${s}</option>`
  ).join("");
  const reviewerOptions = `<option value="">— none —</option>` +
    allAgents.map((a) =>
      `<option value="${escapeHtml(a.id)}"${con?.reviewer_agent_id === a.id ? " selected" : ""}>${escapeHtml(a.name)}</option>`
    ).join("");

  return `<div class="sk-phase-edit" data-phase-index="${index}">
    <div class="sk-phase-edit__header">
      <span class="sk-phase-edit__number">${index + 1}</span>
      <input type="text" data-phase-field="name" value="${escapeHtml(phase.name)}" class="sk-input sk-input--sm" placeholder="Phase name" style="flex:1;">
      <div class="sk-phase-edit__header-actions">
        <button type="button" class="sk-btn sk-btn--sm" title="Move up" onclick="Skipper.movePhase(this,-1)">&#x25B2;</button>
        <button type="button" class="sk-btn sk-btn--sm" title="Move down" onclick="Skipper.movePhase(this,1)">&#x25BC;</button>
        <button type="button" class="sk-btn sk-btn--danger sk-btn--sm" onclick="this.closest('.sk-phase-edit').remove()">&#x2715;</button>
      </div>
    </div>
    <div class="sk-phase-edit__body">
      <div class="sk-inline-edit-form__field">
        <span class="sk-inline-edit-form__label">Prompt</span>
        <span class="sk-inline-edit-form__hint">Instructions given to the entrypoint agent when this phase begins.</span>
        <textarea data-phase-field="prompt" rows="3" class="sk-textarea sk-textarea--sm" style="font-family:var(--sk-font-mono);font-size:11px;">${escapeHtml(phase.prompt)}</textarea>
      </div>

      <div class="sk-phase-edit__review-toggle${phase.review ? " sk-phase-edit__review-toggle--active" : ""}">
        <label class="sk-phase-edit__review-label">
          <input type="checkbox" data-phase-field="review"${phase.review ? " checked" : ""}
            onchange="this.closest('.sk-phase-edit__review-toggle').classList.toggle('sk-phase-edit__review-toggle--active',this.checked)">
          <div>
            <strong>Review gate</strong>
            <span class="sk-inline-edit-form__hint" style="display:block;margin-top:2px;">Pause after this phase completes and wait for operator approval before advancing to the next phase.</span>
          </div>
        </label>
      </div>

      ${isExperimental() ? `<details class="sk-phase-edit__consensus"${con ? " open" : ""}>
        <summary>Consensus settings</summary>
        <div class="sk-inline-edit-form__hint" style="margin-bottom:var(--sk-space-2);">Run multiple agents in parallel on this phase and merge or select the best result.</div>
        <div class="sk-phase-edit__consensus-fields">
          <div class="sk-inline-edit-form__field">
            <span class="sk-inline-edit-form__label">Agent count</span>
            <input type="number" data-phase-field="consensus_agent_count" value="${con?.agent_count ?? 2}" min="1" max="10" class="sk-input sk-input--sm" style="width:70px;">
          </div>
          <div class="sk-inline-edit-form__field">
            <span class="sk-inline-edit-form__label">Strategy</span>
            <select data-phase-field="consensus_strategy" class="sk-select sk-select--sm">${strategyOptions}</select>
          </div>
          <label style="display:flex;align-items:center;gap:6px;font-size:var(--sk-text-xs);color:var(--sk-text-muted);align-self:end;padding-bottom:4px;">
            <input type="checkbox" data-phase-field="consensus_worktree"${con?.worktree ? " checked" : ""}> Isolate in worktrees
          </label>
          <div class="sk-inline-edit-form__field">
            <span class="sk-inline-edit-form__label">Reviewer agent</span>
            <select data-phase-field="consensus_reviewer_agent_id" class="sk-select sk-select--sm">${reviewerOptions}</select>
          </div>
        </div>
      </details>` : ""}
    </div>
  </div>`;
}

function memberRow(member: { agent_id: string; role: string | null; level: number; parent_agent_id: string | null }, index: number, allAgents: AgentDefinition[]): string {
  const agentOptions = allAgents.map((a) =>
    `<option value="${escapeHtml(a.id)}"${a.id === member.agent_id ? " selected" : ""}>${escapeHtml(a.name)}</option>`
  ).join("");

  return `<tr class="sk-member-edit" data-member-index="${index}">
    <td><select data-member-field="agent_id" class="sk-select sk-select--sm" style="width:100%;">${agentOptions}</select></td>
    <td><input type="text" data-member-field="role" value="${escapeHtml(member.role ?? "")}" class="sk-input sk-input--sm" placeholder="e.g. developer, qa" style="width:100%;"></td>
    <td><input type="number" data-member-field="level" value="${member.level}" min="0" max="10" class="sk-input sk-input--sm" style="width:100%;"></td>
    <td><button type="button" class="sk-btn sk-btn--danger sk-btn--sm" onclick="this.closest('.sk-member-edit').remove()">&#x2715;</button></td>
  </tr>`;
}

export { phaseForm, memberRow };
