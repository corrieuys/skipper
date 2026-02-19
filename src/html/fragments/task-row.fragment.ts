import { escapeHtml } from "../atoms/escape-html";
import { badgeFragment } from "./badge.fragment";
import { formatTimestamp } from "../atoms/format-timestamp";

export interface TaskRowData {
  id: string;
  title: string;
  status: string;
  team_name: string | null;
  current_phase: number;
  task_type: string;
  created_at: string;
}

export function taskRowFragment(task: TaskRowData): string {
  return `<tr>
    <td><a href="/?task=${escapeHtml(task.id)}">${escapeHtml(task.title)}</a></td>
    <td>${badgeFragment(task.status)}</td>
    <td>${escapeHtml(task.team_name ?? "—")}</td>
    <td>${task.task_type === "real_time" ? '<span class="sk-badge sk-badge--waiting">RT</span>' : `Phase ${task.current_phase + 1}`}</td>
    <td class="sk-muted">${formatTimestamp(task.created_at)}</td>
    <td style="text-align:right;">${taskDeleteButton(task.id, task.status)}</td>
  </tr>`;
}

export function taskDeleteButton(taskId: string, status: string): string {
  if (status === "running") return "";
  return `<button type="button"
    class="sk-btn sk-btn--sm sk-btn--danger"
    hx-delete="/api/tasks/${escapeHtml(taskId)}"
    hx-headers='{"X-Skip-Redirect":"1"}'
    hx-confirm="Delete this task and all its data?"
    hx-target="closest tr"
    hx-swap="outerHTML">Delete</button>`;
}
