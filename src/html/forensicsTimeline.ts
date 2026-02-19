import { ForensicsTimelineEntry, escapeHtml } from "./components";
import { formatTimestamp } from "./formatTimestamp";


export function forensicsTimeline(entries: ForensicsTimelineEntry[]): string {
    if (entries.length === 0) return "";
    const items = entries
        .map((e) => {
            let icon: string;
            let label: string;
            let detail = "";

            if (e.source === "checkpoint") {
                icon = "&#9679;";
                label = `Checkpoint: ${escapeHtml(e.checkpoint_type ?? "unknown")}`;
                if (e.context_snapshot && e.context_snapshot !== "{}") {
                    detail = `<details class="forensics-snapshot"><summary class="muted">context snapshot</summary><pre>${escapeHtml(e.context_snapshot)}</pre></details>`;
                }
            } else if (e.source === "escalation") {
                icon = "&#9888;";
                label = `Escalation [${escapeHtml(e.escalation_type ?? "")}] ${escapeHtml(e.severity ?? "")} — ${escapeHtml(e.escalation_status ?? "")}`;
                if (e.question) {
                    detail = `<div class="muted" style="margin-top:0.2rem">${escapeHtml(e.question.length > 120 ? e.question.slice(0, 120) + "…" : e.question)}</div>`;
                }
            } else if (e.source === "remediation") {
                icon = "&#9881;";
                label = `Remediation: ${escapeHtml(e.event_type ?? "unknown")}`;
                if (e.event_payload) {
                    detail = `<details class="forensics-snapshot"><summary class="muted">details</summary><pre>${escapeHtml(e.event_payload)}</pre></details>`;
                }
            } else if (e.source === "delegation") {
                icon = "&#128257;";
                label = `Delegation: ${escapeHtml(e.event_type ?? "state change")}`;
                if (e.event_payload) {
                    detail = `<details class="forensics-snapshot"><summary class="muted">details</summary><pre>${escapeHtml(e.event_payload)}</pre></details>`;
                }
            }

            return `<div class="forensics-timeline-entry">
      <span class="forensics-time">${formatTimestamp(e.created_at)}</span>
      <span class="forensics-icon">${icon}</span>
      <div class="forensics-label">${label}${detail}</div>
    </div>`;
        })
        .join("");

    return `<div class="forensics-section">
    <h3>Timeline</h3>
    <div class="forensics-timeline">${items}</div>
  </div>`;
}
