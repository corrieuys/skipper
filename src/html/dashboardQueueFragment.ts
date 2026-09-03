import { escapeHtml } from "./components";
import { statusChip, displayStatusOf, modeChip } from "./fragments/status-chip.fragment";

// --- Dashboard: Task Queue ---

export function dashboardQueueFragment(
    tasks: {
        id: string;
        title: string;
        status: string;
        display_status?: string;
        mode?: string;
        task_type?: string;
        created_at?: string;
    }[]
): string {
    const pending = tasks.filter((t) => {
        const display = displayStatusOf(t);
        return display === "queued" || display === "working";
    });
    if (pending.length === 0) {
        return `<div style="padding:0.85rem;text-align:center;color:var(--muted);font-size:0.78rem;">Queue empty</div>`;
    }
    return pending
        .map((task) => {
            const href = `/?task=${escapeHtml(task.id)}`;
            return `<div class="cmd-queue-item">
      ${statusChip(displayStatusOf(task))}
      ${modeChip(task.mode)}
      <span class="cmd-queue-title"><a href="${href}">${escapeHtml(task.title)}</a></span>
    </div>`;
        })
        .join("");
}
