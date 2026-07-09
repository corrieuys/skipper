import { type TaskNoteData, escapeHtml } from "./components";
import { formatTimestamp } from "./formatTimestamp";

export function noteItemFragment(n: TaskNoteData): string {
    const isDeleted = !!n.deleted_at;
    // Deleted notes stay visible for operator audit but are dimmed + struck through
    // and offer a Restore action. Live notes offer a soft-delete (✕) action. Both
    // buttons swap this single row in place. deleted_at excludes the note from
    // agent context injection (handled server-side in prompt-builder).
    const action = isDeleted
      ? `<button type="button" class="note-action note-action--restore" title="Restore this note"
                hx-post="/api/tasks/${escapeHtml(n.task_id)}/notes/${escapeHtml(n.id)}/restore"
                hx-target="closest .note-item" hx-swap="outerHTML"
                style="flex:0 0 auto;font-size:0.7rem;padding:0.1rem 0.4rem;cursor:pointer;">Restore</button>`
      : `<button type="button" class="note-action note-action--delete" title="Delete this note (removes it from agent context)"
                hx-post="/api/tasks/${escapeHtml(n.task_id)}/notes/${escapeHtml(n.id)}/delete"
                hx-target="closest .note-item" hx-swap="outerHTML"
                style="flex:0 0 auto;font-size:0.75rem;line-height:1;padding:0.1rem 0.3rem;cursor:pointer;background:none;border:none;color:var(--sk-text-muted);opacity:0.25;transition:opacity 0.12s;">✕</button>`;
    return `<div class="note-item${n.source === 'user' ? ' note-item-user' : ''}${isDeleted ? ' note-item--deleted' : ''}"${isDeleted ? ' style="opacity:0.55;"' : ''}>
      <div class="note-header" style="display:flex;align-items:center;gap:0.4rem;">
        <span class="note-agent">${escapeHtml(n.source === 'user' ? 'You' : (n.agent_name || n.agent_id || "system"))}</span>
        <span class="note-time">${formatTimestamp(n.created_at)}</span>
        ${isDeleted ? `<span class="note-deleted-badge" style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.03em;color:var(--sk-accent-danger,#e06);border:1px solid currentColor;border-radius:3px;padding:0 0.3rem;">deleted</span>` : ""}
        <span style="flex:1 1 auto;"></span>
        ${action}
      </div>
      <div class="note-body"${isDeleted ? ' style="text-decoration:line-through;"' : ''}>${escapeHtml(n.content)}</div>
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
