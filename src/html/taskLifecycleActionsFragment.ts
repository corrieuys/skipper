import { type TaskData, escapeHtml } from "./components";


export function taskLifecycleActionsFragment(
    task: TaskData,
    editToggleId?: string
): string {
    const id = escapeHtml(task.id);
    const buttons: string[] = [];

    if (task.status === "draft") {
        if (editToggleId) {
            buttons.push(
                `<label class="btn btn-secondary task-edit-button task-edit-open" for="${escapeHtml(editToggleId)}">Edit</label>`
            );
            buttons.push(
                `<label class="btn btn-secondary task-edit-button task-edit-close" for="${escapeHtml(editToggleId)}">Close Editor</label>`
            );
        }
        buttons.push(
            `<button class="btn btn-primary" hx-post="/api/tasks/${id}/approve" hx-target="body" hx-swap="innerHTML">Accept</button>`
        );
        buttons.push(
            `<button class="btn btn-danger" hx-post="/api/tasks/${id}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task?">Delete</button>`
        );
    } else if (task.status === "approved") {
        buttons.push(
            `<button class="btn btn-secondary" hx-post="/api/tasks/${id}/unapprove" hx-target="body" hx-swap="innerHTML">Unapprove</button>`
        );
        buttons.push(
            `<button class="btn btn-danger" hx-post="/api/tasks/${id}/cancel" hx-target="body" hx-swap="innerHTML" hx-confirm="Cancel this task?">Cancel</button>`
        );
    } else if (task.status === "running") {
        if (task.needs_review) {
            buttons.push(
                `<button class="btn btn-primary" hx-post="/api/tasks/${id}/approve-phase" hx-target="body" hx-swap="innerHTML">Approve &amp; Advance</button>`
            );
            buttons.push(
                `<form hx-post="/api/tasks/${id}/reject-phase" hx-target="body" hx-swap="innerHTML" style="display:inline-flex; gap:0.5rem; align-items:flex-start;">` +
                `<textarea name="message" rows="2" placeholder="Rejection feedback (required)..." required style="min-width:250px; font-size:0.85rem;"></textarea>` +
                `<button class="btn btn-warning" type="submit">Reject Phase</button>` +
                `</form>`
            );
        }
        buttons.push(
            `<button class="btn btn-secondary" hx-post="/api/tasks/${id}/pause" hx-target="body" hx-swap="innerHTML" hx-confirm="Pause this task? All its agents and their subprocesses will be stopped; you can resume later.">Pause</button>`
        );
        buttons.push(
            `<button class="btn btn-danger" hx-post="/api/tasks/${id}/cancel" hx-target="body" hx-swap="innerHTML" hx-confirm="Cancel this task?">Cancel</button>`
        );
    } else if (task.status === "paused") {
        buttons.push(
            `<button class="btn btn-primary" hx-post="/api/tasks/${id}/resume-from-pause" hx-target="body" hx-swap="innerHTML">Resume</button>`
        );
        buttons.push(
            `<button class="btn btn-danger" hx-post="/api/tasks/${id}/cancel" hx-target="body" hx-swap="innerHTML" hx-confirm="Cancel this task?">Cancel</button>`
        );
    } else if (task.status === "failed") {
        buttons.push(
            `<button class="btn btn-primary" hx-post="/api/tasks/${id}/resume" hx-target="body" hx-swap="innerHTML">Resume (Current Phase)</button>`
        );
        buttons.push(
            `<button class="btn btn-secondary" hx-post="/api/tasks/${id}/retry" hx-target="body" hx-swap="innerHTML">Retry (Reset Phase)</button>`
        );
        buttons.push(
            `<button class="btn btn-danger" hx-post="/api/tasks/${id}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task?">Delete</button>`
        );
    } else if (task.status === "completed") {
        buttons.push(
            `<button class="btn btn-danger" hx-post="/api/tasks/${id}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task?">Delete</button>`
        );
    }

    if (buttons.length === 0) return "";

    const reviewBanner = task.needs_review
        ? `<div class="review-banner">
        <p class="review-banner-title">Phase Review Required</p>
        <p class="review-banner-text">Phase ${task.current_phase + 1} has completed. Review the work before advancing to the next phase.</p>
      </div>`
        : "";

    return `<div class="card operator-actions">
    <div class="section-heading"><div><h2>Task Actions</h2></div></div>
    ${reviewBanner}
    <div class="action-buttons">${buttons.join("")}</div>
  </div>`;
}
