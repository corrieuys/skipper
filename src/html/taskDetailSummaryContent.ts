import { TaskData, TeamOptionData, escapeHtml } from "./components";
import { taskFormFields } from "./taskFormFields";

export function taskDetailSummaryContent(
  task: TaskData,
  teams: TeamOptionData[] = [],
  editToggleId?: string): string {
  const displayView = `<div class="task-inline-edit-display">
      <div class="section-heading">
        <div>
          <h2>Task Details</h2>
          <p class="muted">Description and latest result.</p>
        </div>
      </div>
      ${task.description
      ? `<div class="task-instance-block">
        <h3>Description</h3>
        <pre class="detail-desc-body">${escapeHtml(task.description)}</pre>
      </div>`
      : ""}
      ${task.result
      ? `<div class="task-instance-block">
        <h3>Result</h3>
        <pre>${escapeHtml(JSON.stringify(task.result, null, 2))}</pre>
      </div>`
      : ""}
    </div>`;

  if (task.status !== "draft" || !editToggleId) {
    return `<section class="card task-instance-summary-card">${displayView}</section>`;
  }

  return `<section class="card task-instance-summary-card task-instance-summary-card-editable">
      ${displayView}
      <form class="task-editor-form task-inline-edit-form" hx-post="/api/tasks/${escapeHtml(task.id)}" hx-target="body" hx-swap="innerHTML">
        <div class="section-heading">
          <div>
            <h2>Edit Task</h2>
            <p class="muted">Update the task directly in context without switching panels.</p>
          </div>
        </div>
        ${taskFormFields(teams, task)}
        <div class="form-actions">
          <label class="ghost-link" for="${escapeHtml(editToggleId)}">Cancel</label>
          <button type="submit">Save Changes</button>
        </div>
      </form>
    </section>`;
}
