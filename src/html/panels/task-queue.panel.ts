import { escapeHtml } from "../atoms/escape-html";
import { badgeFragment } from "../fragments/badge.fragment";
import { formatTimestamp } from "../atoms/format-timestamp";

export const FRAGMENT_ID = "sk-task-queue";

export interface QueuedTask {
  id: string;
  title: string;
  status: string;
  created_at: string;
}

export function taskQueuePanel(tasks: QueuedTask[]): string {
  if (tasks.length === 0) {
    return `<div id="${FRAGMENT_ID}" class="sk-panel">
      <div class="sk-panel__header">
        <span class="sk-panel__title">Queue</span>
        <span class="sk-panel__count">0</span>
      </div>
      <div class="sk-panel__empty">No queued tasks</div>
    </div>`;
  }

  const rows = tasks.map((t) => `
    <div class="sk-flex sk-items-center sk-gap-2" style="padding: var(--sk-space-2) var(--sk-space-3); border-bottom: 1px solid var(--sk-border);">
      <a href="/tasks/${escapeHtml(t.id)}" class="sk-truncate" style="flex:1">${escapeHtml(t.title)}</a>
      ${badgeFragment(t.status)}
      <span class="sk-muted sk-text-xs">${formatTimestamp(t.created_at)}</span>
    </div>
  `).join("");

  return `<div id="${FRAGMENT_ID}" class="sk-panel">
    <div class="sk-panel__header">
      <span class="sk-panel__title">Queue</span>
      <span class="sk-panel__count">${tasks.length}</span>
    </div>
    <div class="sk-panel__body--flush sk-scroll-y" style="max-height: 200px;">
      ${rows}
    </div>
  </div>`;
}
