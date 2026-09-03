import { escapeHtml } from "./components";
import { dashboardInlineTaskCreationFragment } from "./dashboardInlineTaskCreationFragment";
import { statusChip, displayStatusOf, modeChip } from "./fragments/status-chip.fragment";


export function dashboardActiveTaskFragment(
    tasks: {
        id: string;
        title: string;
        status: string;
        display_status?: string;
        mode?: string;
        task_type?: string;
        description?: string | null;
        created_at?: string;
    }[]
): string {
    if (tasks.length === 0 || !tasks.some((task) => displayStatusOf(task) === "working")) {
        return dashboardInlineTaskCreationFragment([]);
    }

    const [current, ...queued] = tasks;
    if (!current) return dashboardInlineTaskCreationFragment([]);
    const display = displayStatusOf(current);
    const detailHref = `/?task=${escapeHtml(current.id)}`;

    const eyebrow = display === "working"
        ? "Active Mission"
        : display === "queued"
            ? "Next in Queue"
            : "Latest Task";

    return `<div class="cmd-focus">
    <div class="cmd-focus-eyebrow">${eyebrow}</div>
    <a href="${detailHref}" class="cmd-focus-title" style="display:block;color:var(--on-surface);text-decoration:none;">${escapeHtml(current.title)}</a>
    <div class="cmd-focus-meta">
      ${statusChip(display)}
      ${modeChip(current.mode)}
      ${queued.length > 0 ? `<span style="font-size:0.72rem;color:var(--muted);">+${queued.length} queued</span>` : ""}
    </div>
  </div>`;
}
