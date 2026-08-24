import { type ForensicsEscalation, escapeHtml } from "./components";
import { formatTimestamp } from "./formatTimestamp";
import { agentTextPreview } from "./atoms/render-agent-text";


export function forensicsEscalations(escalations: ForensicsEscalation[]): string {
  if (escalations.length === 0) return "";

  const rows = escalations
    .map(
      (e) => `<tr>
    <td><span class="badge badge-${e.status}">${e.status}</span></td>
    <td>${escapeHtml(e.type)}</td>
    <td>${escapeHtml(e.severity)}</td>
    <td>${e.agent_name ? escapeHtml(e.agent_name) : escapeHtml(e.agent_id.slice(0, 8))}</td>
    <td>${escapeHtml(agentTextPreview(e.question, 80))}</td>
    <td>${e.response ? escapeHtml(agentTextPreview(e.response, 60)) : "-"}</td>
    <td>${formatTimestamp(e.created_at)}</td>
    <td>${e.resolved_at ? formatTimestamp(e.resolved_at) : "-"}</td>
  </tr>`
    )
    .join("");

  return `<div class="forensics-section">
    <h3>Escalations</h3>
    <table class="data-table">
      <thead><tr><th>Status</th><th>Type</th><th>Severity</th><th>Agent</th><th>Question</th><th>Response</th><th>Created</th><th>Resolved</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}
