import { escapeHtml } from "../atoms/escape-html";
import { noteItemFragment, type NoteData } from "../fragments/note-item.fragment";

export const FRAGMENT_ID = "sk-notes";

export function notesPanel(taskId: string, notes: NoteData[]): string {
  const rows = notes.map((n) => noteItemFragment(n)).join("");
  return `<div id="${FRAGMENT_ID}" class="sk-panel">
    <div class="sk-panel__header">
      <span class="sk-panel__title">Notes</span>
      <span class="sk-panel__count">${notes.length}</span>
    </div>
    ${notes.length > 0
      ? `<div class="sk-panel__body--flush sk-scroll-y" style="max-height:250px">${rows}</div>`
      : `<div class="sk-panel__empty">No notes yet</div>`
    }
    <div style="padding: var(--sk-space-2) var(--sk-space-3); border-top: 1px solid var(--sk-border);">
      <form class="sk-flex sk-gap-2" hx-post="/api/tasks/${escapeHtml(taskId)}/notes" hx-swap="none"
            hx-on::after-request="if(event.detail.successful){this.reset();}">
        <input type="text" name="content" class="sk-input" placeholder="Add a note..." style="flex:1" maxlength="280">
        <button type="submit" class="sk-btn sk-btn--sm">Add</button>
      </form>
    </div>
  </div>`;
}
