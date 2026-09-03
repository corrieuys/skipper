import { escapeHtml } from "../atoms/escape-html";
import { formatTimestamp } from "../atoms/format-timestamp";
import { statusChip, displayStatusOf, modeChip } from "./status-chip.fragment";

export interface TaskRowData {
  id: string;
  title: string;
  /** Stored status: draft | active | settled. */
  status: string;
  /** Derived presentation status (queued/working/idle/...). */
  display_status?: string;
  /** True when the task result carries an error (settled-with-error = old "failed"). */
  result_has_error?: boolean;
  team_name: string | null;
  current_phase: number;
  /** Task mode: workflow | conversational. */
  mode?: string;
  /** True when the task's team defines phases. */
  has_phases?: boolean;
  created_at: string;
}

export function taskRowFragment(task: TaskRowData): string {
  return `<tr>
    <td><a href="/?task=${escapeHtml(task.id)}">${escapeHtml(task.title)}</a></td>
    <td>${statusChip(displayStatusOf(task), task.result_has_error ?? false)}</td>
    <td>${escapeHtml(task.team_name ?? "-")}</td>
    <td>${taskPhaseCell(task)}</td>
    <td class="sk-muted">${formatTimestamp(task.created_at)}</td>
    <td style="text-align:right;">${taskDeleteButton(task.id, task.display_status ?? task.status)}</td>
  </tr>`;
}

/** Phase cell: phase progress when the team has phases, the mode chip otherwise. */
export function taskPhaseCell(task: Pick<TaskRowData, "has_phases" | "current_phase" | "mode">): string {
  if (task.has_phases) return `Phase ${task.current_phase + 1}`;
  return modeChip(task.mode) || `<span class="sk-muted">-</span>`;
}

export function taskDeleteButton(taskId: string, displayStatus: string): string {
  if (displayStatus === "working") return "";
  return `<button type="button"
    class="sk-btn sk-btn--sm sk-btn--danger"
    hx-delete="/api/tasks/${escapeHtml(taskId)}"
    hx-headers='{"X-Skip-Redirect":"1"}'
    hx-confirm="Delete this task and all its data?"
    hx-target="closest tr"
    hx-swap="outerHTML">Delete</button>`;
}
