import { TaskNoteData, escapeHtml } from "./components";
import { formatTimestamp } from "./formatTimestamp";

export function noteItemFragment(n: TaskNoteData): string {
    return `<div class="note-item${n.source === 'user' ? ' note-item-user' : ''}">
      <div class="note-header">
        <span class="note-agent">${escapeHtml(n.source === 'user' ? 'You' : (n.agent_name || n.agent_id || "system"))}</span>
        <span class="note-time">${formatTimestamp(n.created_at)}</span>
      </div>
      <div class="note-body">${escapeHtml(n.content)}</div>
    </div>`;
}

export function dashboardNotesFragment(notes: TaskNoteData[], taskId?: string): string {
    const notesList = `<div id="dashboard-notes-list" style="display:flex;flex-direction:column;gap:0.55rem;">${
        notes.map(noteItemFragment).join("")
    }</div>`;

    const formId = taskId ? `note-add-form-${escapeHtml(taskId)}` : "";
    const textareaId = taskId ? `note-add-textarea-${escapeHtml(taskId)}` : "";
    const manualNoteForm = taskId ? `
    <form id="${formId}" class="note-add-form"
          hx-preserve="true"
          hx-post="/api/tasks/${escapeHtml(taskId)}/notes"
          hx-target="#dashboard-notes-list"
          hx-swap="afterbegin"
          hx-on::after-request="this.reset()"
          style="margin-bottom:0.75rem;display:flex;flex-direction:row;align-items:flex-start;gap:0.4rem;">
      <textarea id="${textareaId}" name="content"
                placeholder="Add a note for agents..."
                rows="2"
                style="flex:1;min-width:0;min-height:3rem;resize:vertical;font-size:0.82rem;padding:0.35rem 0.5rem;border:1px solid var(--sk-border-subtle);border-radius:var(--sk-radius-sm);background:color-mix(in srgb, var(--sk-surface-0) 28%, transparent);color:var(--on-surface);outline:none;"></textarea>
      <button type="submit"
              style="flex:0 0 auto;align-self:flex-start;font-size:0.78rem;padding:0.25rem 0.85rem;">Add Note</button>
    </form>` : "";

    return manualNoteForm + notesList;
}
