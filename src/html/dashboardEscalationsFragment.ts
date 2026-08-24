import { type DashboardData, escapeHtml } from "./components";
import { formatTimestamp } from "./formatTimestamp";
import { agentTextPreview } from "./atoms/render-agent-text";

// --- Dashboard: Escalation Alerts ---

export function dashboardEscalationsFragment(
  escalations: NonNullable<DashboardData["openEscalations"]>
): string {
  if (escalations.length === 0) return "";
  return escalations
    .map(
      (esc) => `<div class="cmd-alert">
      <span class="cmd-alert-icon">!</span>
      <div class="cmd-alert-body">
        <div class="cmd-alert-text">${escapeHtml(agentTextPreview(esc.question, 140))}</div>
        <div class="cmd-alert-meta">
          <a href="/" style="color:var(--primary);font-size:0.7rem;">Respond</a>
          &middot; ${formatTimestamp(esc.created_at)}
        </div>
      </div>
    </div>`
    )
    .join("");
}
