import { escapeHtml } from "./escape-html";

/**
 * Render an operator message body according to its stored format. Shared by the
 * timeline entry and the Messages dock column so the two never diverge.
 *
 * - `text` (and NULL/legacy): plain, escaped — the register's default and
 *   overwhelmingly common case.
 * - `markdown`: escaped into a `[data-artifact-md]` block; the client marked
 *   pass (skipper.js:renderMarkdownBlocks) renders it after swap.
 * - `html`: trusted and inlined (scripts stripped), same trust model as agent
 *   text in escalations and artifacts.
 */
export function renderMessageBody(content: string, format: string | null | undefined): string {
  if (format === "html") {
    return `<div class="sk-md">${content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")}</div>`;
  }
  if (format === "markdown") {
    return `<div class="sk-md" data-artifact-md>${escapeHtml(content)}</div>`;
  }
  return escapeHtml(content);
}
