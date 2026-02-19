import { DashboardData, escapeHtml } from "./components";
import { formatTimestamp } from "./formatTimestamp";


export function dashboardRealtimeTimelineFragment(
    timeline: NonNullable<DashboardData["realtimeTimeline"]> | null
): string {
    if (!timeline || timeline.entries.length === 0) {
        return `<div class="mc-activity__empty">No timeline messages</div>`;
    }

    return timeline.entries
        .map((entry) => {
            const kind = entry.entry_type === "error" ? "event"
                : entry.entry_type === "summary" ? "tool"
                : "message";
            const kindLabel = entry.entry_type === "summary" ? "sum"
                : entry.entry_type === "error" ? "err"
                : "txt";
            const preview = entry.content.length > 200
                ? `${entry.content.slice(0, 200)}...`
                : entry.content;
            const priorityTag = entry.priority === "high"
                ? `<span class="mc-activity__kind" style="color:var(--sk-warning, #f0ad4e);background:rgba(240,173,78,0.1);font-size:8px;">HIGH</span>`
                : "";
            return `<div class="mc-activity__item mc-activity__item--${kind}">
      <span class="mc-activity__kind mc-activity__kind--${kind}">${kindLabel}</span>${priorityTag}
      <span class="mc-activity__text">${escapeHtml(preview)}</span>
      <span class="mc-activity__pid">${formatTimestamp(entry.created_at)}</span>
    </div>`;
        })
        .join("");
}
