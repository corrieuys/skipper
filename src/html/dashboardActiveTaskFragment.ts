import { escapeHtml } from "./components";
import { dashboardInlineTaskCreationFragment } from "./dashboardInlineTaskCreationFragment";


export function dashboardActiveTaskFragment(
    tasks: {
        id: string;
        title: string;
        status: string;
        task_type?: string;
        description?: string | null;
        created_at?: string;
    }[]
): string {
    if (tasks.length === 0 || !tasks.some((task) => task.status === "running")) {
        return dashboardInlineTaskCreationFragment([]);
    }

    const [current, ...queued] = tasks;
    const isRT = current.task_type === "real_time";
    const detailHref = isRT
        ? `/realtime/${escapeHtml(current.id)}`
        : `/tasks/${escapeHtml(current.id)}`;

    const eyebrow = current.status === "running"
        ? "Active Mission"
        : current.status === "approved"
            ? "Next in Queue"
            : "Latest Completed";

    return `<div class="cmd-focus">
    <div class="cmd-focus-eyebrow">${eyebrow}</div>
    <a href="${detailHref}" hx-get="${detailHref}" hx-target="body" hx-push-url="true" class="cmd-focus-title" style="display:block;color:var(--on-surface);text-decoration:none;">${escapeHtml(current.title)}</a>
    <div class="cmd-focus-meta">
      <span class="badge badge-${current.status}">${current.status}</span>
      ${isRT ? '<span class="badge badge-info">RT</span>' : ""}
      ${queued.length > 0 ? `<span style="font-size:0.72rem;color:var(--muted);">+${queued.length} queued</span>` : ""}
    </div>
  </div>`;
}
