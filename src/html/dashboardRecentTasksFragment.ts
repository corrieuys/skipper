import { escapeHtml } from "./components";

export function dashboardRecentTasksFragment(
  tasks: {
    id: string;
    title: string;
    status: string;
    task_type?: string;
  }[],
): string {
  return tasks
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
