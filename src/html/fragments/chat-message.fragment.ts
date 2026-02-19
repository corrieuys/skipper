import { escapeHtml } from "../atoms/escape-html";

export function chatMessageFragment(messageId: string, role: string, content: string): string {
  const cls = role === "user" ? "sk-chat__message--user"
    : role === "assistant" ? "sk-chat__message--assistant"
    : "sk-chat__message--system";

  return `<div class="sk-chat__message ${cls}" data-message-id="${escapeHtml(messageId)}">
    <div class="sk-chat__role">${escapeHtml(role)}</div>
    <div class="sk-md" data-artifact-md>${escapeHtml(content)}</div>
  </div>`;
}
