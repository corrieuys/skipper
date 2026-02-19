import { escapeHtml } from "../atoms/escape-html";
import { badgeFragment } from "../fragments/badge.fragment";
import { formatTimestamp } from "../atoms/format-timestamp";

export interface EscalationCardData {
  id: string;
  agent_id: string;
  agent_name?: string | null;
  runtime_agent_id?: string | null;
  task_id: string;
  task_title?: string;
  type: string;
  question: string;
  status: string;
  response?: string | null;
  created_at: string;
  resolved_at?: string | null;
}

export function escalationCardPanel(esc: EscalationCardData): string {
  const isOpen = esc.status === "open";
  // Prefer the human-readable agent name; fall back to a short id when the
  // join didn't resolve (deleted template, legacy row, etc.) so the card
  // still tells the operator *which* agent is asking.
  const agentLabel = esc.agent_name ?? esc.agent_id.slice(0, 12);
  const runtimeHint = esc.runtime_agent_id ? esc.runtime_agent_id.slice(0, 8) : null;

  return `<div class="sk-panel sk-mb-4" id="escalation-${escapeHtml(esc.id)}">
    <div class="sk-panel__header">
      <div class="sk-flex sk-items-center sk-gap-2">
        <span style="color: var(--sk-accent-danger); font-weight: 700;">!</span>
        <strong style="color: var(--sk-text);">${escapeHtml(agentLabel)}</strong>
        <span class="sk-text-xs sk-muted">${escapeHtml(esc.type)}</span>
        ${badgeFragment(esc.status)}
      </div>
      <span class="sk-text-xs sk-muted">${formatTimestamp(esc.created_at)}</span>
    </div>
    <div class="sk-panel__body">
      <div class="esc-q sk-mb-2">
        <input type="checkbox" id="esc-q-cb-${escapeHtml(esc.id)}" class="esc-q__cb">
        <div class="esc-q__body sk-md" data-artifact-md style="color: var(--sk-text);">${escapeHtml(esc.question)}</div>
        <label for="esc-q-cb-${escapeHtml(esc.id)}" class="esc-q__toggle"></label>
      </div>
      <div class="sk-flex sk-gap-2 sk-text-xs sk-muted sk-mb-4">
        <span title="${escapeHtml(esc.agent_id)}">Agent: ${escapeHtml(agentLabel)}${runtimeHint ? ` <span class="sk-mono">(${escapeHtml(runtimeHint)})</span>` : ""}</span>
        <span>Task: ${esc.task_title ? `<a href="/tasks/${escapeHtml(esc.task_id)}">${escapeHtml(esc.task_title)}</a>` : escapeHtml(esc.task_id.slice(0, 12))}</span>
      </div>
      ${isOpen ? `
        <form hx-post="/fragments/escalations/${escapeHtml(esc.id)}/resolve"
              hx-target="#escalation-${escapeHtml(esc.id)}" hx-swap="outerHTML">
          <textarea id="esc-response-${escapeHtml(esc.id)}" hx-preserve="true" name="response" class="sk-textarea sk-mb-2" placeholder="Your response..." rows="2"></textarea>
          <div class="sk-flex sk-gap-2">
            <button type="submit" class="sk-btn sk-btn--primary sk-btn--sm">Respond</button>
            <button type="button" class="sk-btn sk-btn--sm"
                    hx-post="/fragments/escalations/${escapeHtml(esc.id)}/dismiss"
                    hx-target="#escalation-${escapeHtml(esc.id)}" hx-swap="outerHTML">Dismiss</button>
          </div>
        </form>
      ` : `
        <div style="background: var(--sk-surface-0); padding: var(--sk-space-2) var(--sk-space-3); font-size: var(--sk-text-sm);">
          <span class="sk-text-xs sk-muted">Response:</span>
          <div class="sk-md" data-artifact-md>${escapeHtml(esc.response ?? "Dismissed")}</div>
        </div>
      `}
    </div>
  </div>`;
}
