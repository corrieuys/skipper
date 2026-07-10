import type { MessagePart } from "../events/bus";
import { escapeHtml } from "./atoms/escape-html";

/**
 * Heuristic: does this string contain HTML the agent intentionally emitted?
 * Detects recognizable tags anywhere — agents often lead with plain prose and
 * then drop into HTML, so anchoring to the start renders those mixed messages
 * as escaped source.
 */
function looksLikeHtml(text: string): boolean {
  return /<(p|div|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|pre|code|blockquote|hr|strong|em|a|span|br)\b[^>]*>/i.test(
    text,
  );
}

/**
 * Strip tags we never want to render inside the chat container.
 * The skipper prompt forbids <html>/<head>/<body>/<style>/<script>, but the model
 * sometimes wraps output in them anyway — strip defensively rather than rejecting.
 */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<\/?html[^>]*>/gi, "")
    .replace(/<\/?head[^>]*>/gi, "")
    .replace(/<\/?body[^>]*>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
}

function renderTextContent(content: string): string {
  if (looksLikeHtml(content)) return sanitizeHtml(content);
  // Plain text: defer to client-side markdown rendering (data-artifact-md is
  // swept by skipper.js → marked.parse). Newlines and inline syntax like
  // **bold** become real HTML once rendered.
  return `<div class="sk-md" data-artifact-md>${escapeHtml(content)}</div>`;
}

/** Render a single MessagePart as a self-contained bubble. */
export function chatPartFragment(part: MessagePart): string {
  switch (part.kind) {
    case "text":
      return `<div class="chat-bubble chat-bubble-text">${renderTextContent(part.content)}</div>`;
    case "thinking":
      return `<details class="chat-bubble chat-bubble-thinking"><summary>thinking</summary><div class="chat-bubble-body">${escapeHtml(part.content).replace(/\n/g, "<br>")}</div></details>`;
    case "tool_use": {
      const name = part.name ?? "tool";
      // content normally carries the stringified input; fall back to the raw
      // input field for parts persisted without it.
      const inputFallback = part.input === undefined || part.input === null
        ? ""
        : typeof part.input === "string" ? part.input : JSON.stringify(part.input, null, 2);
      const body = part.content?.trim() ? part.content : inputFallback.trim() ? inputFallback : "(no input)";
      return `<details class="chat-bubble chat-bubble-tool-use"><summary>tool · ${escapeHtml(name)}</summary><pre class="chat-bubble-body chat-bubble-pre">${escapeHtml(body)}</pre></details>`;
    }
    case "tool_result": {
      const body = part.content?.trim() ? part.content : "(empty result)";
      return `<details class="chat-bubble chat-bubble-tool-result"><summary>tool result</summary><pre class="chat-bubble-body chat-bubble-pre">${escapeHtml(body)}</pre></details>`;
    }
    default:
      return `<div class="chat-bubble chat-bubble-text">${escapeHtml(String(part.content ?? ""))}</div>`;
  }
}

/** Render a user message as a (always plain-text) bubble. */
export function chatUserBubble(messageId: string, content: string): string {
  return `<div class="chat-message chat-message-user" data-message-id="${escapeHtml(messageId)}"><div class="chat-message-content sk-md" data-artifact-md>${escapeHtml(content)}</div></div>`;
}

/**
 * Render a stored assistant message as its bubble set.
 * When `parts` is present and non-empty, each part renders as its own bubble.
 * Otherwise fall back to a single consolidated text bubble.
 */
export function chatAssistantMessage(messageId: string, content: string, parts: MessagePart[]): string {
  const bubbles = parts.length > 0
    ? parts.map(chatPartFragment).join("")
    : `<div class="chat-bubble chat-bubble-text">${renderTextContent(content)}</div>`;
  return `<div class="chat-message chat-message-assistant" data-message-id="${escapeHtml(messageId)}">${bubbles}</div>`;
}
