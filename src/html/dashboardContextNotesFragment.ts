import { PollIntervalSeconds, escapeHtml } from "./components";


export function dashboardContextNotesFragment(
    task: { id: string; description?: string | null; task_type?: string; } | null,
    pollIntervalSeconds: PollIntervalSeconds
): string {
    if (!task) {
        return `<div class="cmd-panel-body"><p class="muted">No active task selected.</p></div>`;
    }
    const endpoint = task.task_type === "real_time"
        ? `/api/realtime-tasks/${escapeHtml(task.id)}/notes`
        : `/fragments/tasks/${escapeHtml(task.id)}/notes`;
    return `<div id="dashboard-context-notes"
      class="cmd-panel-body cmd-scroll-compact"
      hx-get="${endpoint}"
      hx-trigger="load"
      hx-target="this"
      hx-swap="innerHTML">
    <p class="muted">Loading notes...</p>
  </div>`;
}
