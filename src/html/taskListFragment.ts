import { type TaskData, taskTableRow } from "./components";


export function taskListFragment(tasks: TaskData[]): string {
    return tasks.length === 0
        ? `<div class="empty-state"><div class="empty-state-icon">&#128203;</div><p>No tasks yet</p><p class="muted">Create your first task to get started</p></div>`
        : `<table class="data-table task-table">
        <thead><tr><th>Status</th><th>Title</th><th>Team</th><th>Phase</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>${tasks.map(taskTableRow).join("")}</tbody>
      </table>`;
}
