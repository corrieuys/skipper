import { escapeHtml } from "../atoms/escape-html";
import { formatTimestamp } from "../atoms/format-timestamp";

export interface NoteData {
  id: string;
  agent_id: string;
  agent_name?: string;
  content: string;
  created_at: string;
}

export function noteItemFragment(note: NoteData): string {
  return `<div style="padding: var(--sk-space-2) var(--sk-space-3); border-bottom: 1px solid var(--sk-border); font-size: var(--sk-text-sm);">
    <div class="sk-flex sk-items-center sk-gap-2 sk-mb-2">
      <strong class="sk-text-xs" style="color: var(--sk-accent-secondary)">${escapeHtml(note.agent_name ?? note.agent_id.slice(0, 8))}</strong>
      <span class="sk-muted sk-text-xs">${formatTimestamp(note.created_at)}</span>
    </div>
    <div class="sk-md" data-artifact-md style="color: var(--sk-text-muted);">${escapeHtml(note.content)}</div>
  </div>`;
}
