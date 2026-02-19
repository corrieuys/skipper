import { ForensicsEscalation, escapeHtml } from "./components";
import { formatTimestamp } from "./formatTimestamp";


export function forensicsEscalations(escalations: ForensicsEscalation[]): string {
  if (escalations.length === 0) return "";

  const rows = escalations
    .map(
      (e) => `<tr>
    <td><span class="badge badge-${e.status}">${e.status}</span></td>
    <td>${escapeHtml(e.type)}</td>
    <td>${escapeHtml(e.severity)}</td>
    <td>${e.agent_name ? escapeHtml(e.agent_name) : escapeHtml(e.agent_id.slice(0, 8))}</td>
    <td>${escapeHtml(e.question.length > 80 ? e.question.slice(0, 80) + "…" : e.question)}</td>
    <td>${e.response ? escapeHtml(e.response.length > 60 ? e.response.slice(0, 60) + "…" : e.response) : "-"}</td>
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
