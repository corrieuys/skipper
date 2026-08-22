import { escapeHtml } from "../atoms/escape-html";
import { formatTimestamp } from "../atoms/format-timestamp";
import { renderMessageBody } from "../atoms/render-message-body";
import type { TaskMessage } from "../../messages/manager";

/**
 * One operator message: who said it, when, and the sentence itself. The body is
 * usually plain text — the register's default and preferred format — but an agent
 * may pick markdown or html, so it renders by the stored format (see
 * render-message-body).
 */
export function taskMessageFragment(message: TaskMessage): string {
  const who = message.agent_name || message.agent_id || "agent";
  return `<div class="sk-message">
    <div class="sk-message__head">
      <span class="sk-message__agent">${escapeHtml(who)}</span>
      <span class="sk-message__time">${formatTimestamp(message.created_at)}</span>
    </div>
    <div class="sk-message__body">${renderMessageBody(message.content, message.format)}</div>
  </div>`;
}

/** The Messages column body: newest first, with an empty state. */
export function taskMessagesFragment(messages: TaskMessage[]): string {
  if (messages.length === 0) {
    return `<p class="sk-muted sk-text-sm" style="padding:var(--sk-space-3);margin:0;">
      No messages yet. Agents post here when something happens that is worth knowing about.
    </p>`;
  }
  return `<div class="sk-message-list">${messages.map(taskMessageFragment).join("")}</div>`;
}
