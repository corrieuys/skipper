import { escapeHtml } from "./components";

// --- Dashboard: Task Queue ---

export function dashboardQueueFragment(
    tasks: {
        id: string;
        title: string;
        status: string;
        task_type?: string;
        created_at?: string;
    }[]
): string {
    const pending = tasks.filter(
        (t) => t.status === "approved" || t.status === "running"
    );
    if (pending.length === 0) {
        return `<div style="padding:0.85rem;text-align:center;color:var(--muted);font-size:0.78rem;">Queue empty</div>`;
    }
    return pending
        .map((task) => {
            const href = task.task_type === "real_time"
                ? `/realtime/${escapeHtml(task.id)}`
                : `/tasks/${escapeHtml(task.id)}`;
            return `<div class="cmd-queue-item">
      <span class="badge badge-${escapeHtml(task.status)}">${escapeHtml(task.status)}</span>
      ${task.task_type === "real_time" ? '<span class="badge badge-info">RT</span>' : ""}
      <span class="cmd-queue-title"><a href="${href}" hx-get="${href}" hx-target="body" hx-push-url="true">${escapeHtml(task.title)}</a></span>
    </div>`;
        })
        .join("");
}
