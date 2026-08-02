import { escapeHtml } from "../atoms/escape-html";
import { formatTimestamp } from "../atoms/format-timestamp";
import type { TaskMessage } from "../../messages/manager";

/**
 * One operator message: who said it, when, and the sentence itself. Rendered as
 * plain text, never Markdown or HTML — the whole point of the register is that an
 * agent writes a sentence a person can read, so there is no formatting to honour.
 */
export function taskMessageFragment(message: TaskMessage): string {
  const who = message.agent_name || message.agent_id || "agent";
  return `<div class="sk-message">
    <div class="sk-message__head">
      <span class="sk-message__agent">${escapeHtml(who)}</span>
      <span class="sk-message__time">${formatTimestamp(message.created_at)}</span>
    </div>
    <div class="sk-message__body">${escapeHtml(message.content)}</div>
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
