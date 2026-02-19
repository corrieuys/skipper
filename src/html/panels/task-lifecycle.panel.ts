import { escapeHtml } from "../atoms/escape-html";

export interface TaskLifecycleData {
  taskId: string;
  status: string;
  needsReview: boolean;
}

export function taskLifecyclePanel(data: TaskLifecycleData): string {
  const actions: string[] = [];

  if (data.status === "draft") {
    actions.push(`<button class="sk-btn sk-btn--primary sk-btn--sm" hx-post="/api/tasks/${escapeHtml(data.taskId)}/approve" hx-swap="none">Approve</button>`);
    actions.push(`<button class="sk-btn sk-btn--danger sk-btn--sm" hx-post="/api/tasks/${escapeHtml(data.taskId)}/delete" hx-swap="none" hx-confirm="Delete this task?">Delete</button>`);
  } else if (data.status === "approved") {
    actions.push(`<button class="sk-btn sk-btn--sm" hx-post="/api/tasks/${escapeHtml(data.taskId)}/unapprove" hx-swap="none">Unapprove</button>`);
  } else if (data.status === "running") {
    if (data.needsReview) {
      actions.push(`<button class="sk-btn sk-btn--primary sk-btn--sm" hx-post="/api/tasks/${escapeHtml(data.taskId)}/approve-phase" hx-swap="none">Approve Phase</button>`);
      actions.push(`<button class="sk-btn sk-btn--sm" hx-post="/api/tasks/${escapeHtml(data.taskId)}/reject-phase" hx-swap="none">Reject Phase</button>`);
    }
    actions.push(`<button class="sk-btn sk-btn--danger sk-btn--sm" hx-post="/api/tasks/${escapeHtml(data.taskId)}/cancel" hx-swap="none" hx-confirm="Cancel this task?">Cancel</button>`);
  } else if (data.status === "failed") {
    actions.push(`<button class="sk-btn sk-btn--primary sk-btn--sm" hx-post="/api/tasks/${escapeHtml(data.taskId)}/resume" hx-swap="none" title="Resume at the current phase. Skipper inspects notes/artifacts/delegations and continues from where the task left off.">Resume</button>`);
    actions.push(`<button class="sk-btn sk-btn--sm" hx-post="/api/tasks/${escapeHtml(data.taskId)}/retry" hx-swap="none" title="Reset to phase 0 and start over.">Retry</button>`);
    actions.push(`<button class="sk-btn sk-btn--danger sk-btn--sm" hx-post="/api/tasks/${escapeHtml(data.taskId)}/delete" hx-swap="none" hx-confirm="Delete this task?">Delete</button>`);
  }

  if (actions.length === 0) return "";

  return `<div class="sk-flex sk-gap-2" style="flex-wrap: wrap;">${actions.join("")}</div>`;
}
