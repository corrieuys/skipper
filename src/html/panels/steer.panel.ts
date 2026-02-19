import { escapeHtml } from "../atoms/escape-html";

export interface SteerTarget {
  instanceId: string;
  templateAgentId: string;
  agentName: string;
  canSteer: boolean;
  disabledReason: string | null;
}

export function steerPanel(targets: SteerTarget[]): string {
  if (targets.length === 0) {
    return `<div class="sk-panel">
      <div class="sk-panel__header"><span class="sk-panel__title">Steer Agent</span></div>
      <div class="sk-panel__empty">No steerable agents</div>
    </div>`;
  }

  const t = targets[0]; // default to first
  return `<div class="sk-panel">
    <div class="sk-panel__header"><span class="sk-panel__title">Steer Agent</span></div>
    <div class="sk-panel__body">
      <form hx-post="/api/dashboard/steer" hx-swap="none"
            hx-on::after-request="if(event.detail.successful){this.reset();}">
        <div class="sk-form-group">
          <label class="sk-label">Target</label>
          <select name="runtime_id" class="sk-select"
            onchange="this.form.querySelector('input[name=template_agent_id]').value = this.options[this.selectedIndex].dataset.tpl || ''">
            ${targets.map((target) => `<option value="${escapeHtml(target.instanceId)}" data-tpl="${escapeHtml(target.templateAgentId)}" ${!target.canSteer ? "disabled" : ""}>${escapeHtml(target.agentName)} ${target.disabledReason ? `(${escapeHtml(target.disabledReason)})` : ""}</option>`).join("")}
          </select>
          <input type="hidden" name="template_agent_id" value="${escapeHtml(t.templateAgentId)}">
        </div>
        <div class="sk-form-group">
          <textarea name="message" class="sk-textarea" placeholder="Guidance for the agent..." rows="3" required></textarea>
        </div>
        <button type="submit" class="sk-btn sk-btn--sm"${!t.canSteer ? " disabled" : ""}>Send</button>
      </form>
    </div>
  </div>`;
}
