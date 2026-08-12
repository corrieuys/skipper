import { escapeHtml } from "./escape-html";

/**
 * Render a SMALL, safe subset of inline markdown for the activity feed. Every CLI
 * emits markdown prose, so the raw `**`, `` ` `` and `#` markers show up as noise
 * in the feed. This turns the common ones into formatting and leaves everything
 * else as plain text.
 *
 * Safe by construction: the input is HTML-escaped FIRST, then a fixed set of
 * markers is rewrapped in an allowlist of tags (`<strong>`, `<em>`, `<code>`,
 * `<br>`). The model's text can never inject raw HTML — anything we do not
 * recognise stays as the escaped plain text, which is the exact prior behaviour,
 * so a non-markdown line (or a marker split by truncation) renders unchanged.
 *
 * Deliberately conservative for CLI output, where false positives mangle code:
 *  - `**bold**` and `` `code` `` only; NO underscore emphasis (it would wreck
 *    snake_case identifiers and file paths).
 *  - single-`*` italic requires non-space at both inner edges, so `2 * 3` and
 *    `*.ts` are left alone.
 *  - leading `#` heading markers are stripped and the heading bolded; `-`/`*`
 *    list bullets at a line start become `•`.
 *  - unbalanced markers (e.g. a `` ` `` left dangling by truncation) never match,
 *    so they pass through as literal text.
 */
export function renderInlineMarkdown(raw: string): string {
  const escaped = escapeHtml(raw ?? "");
  try {
    let out = escaped;
    // Inline code first, so emphasis markers inside a code span are left alone.
    out = out.replace(/`([^`\n]+?)`/g, (_m, c) => `<code>${c}</code>`);
    // Bold: **x** (non-greedy, no inner asterisk).
    out = out.replace(/\*\*([^*\n]+?)\*\*/g, (_m, t) => `<strong>${t}</strong>`);
    // Italic: *x* — non-space at both inner edges so `2 * 3` / `*.ts` don't match.
    out = out.replace(
      /(^|[^*\w])\*([^*\s](?:[^*\n]*?[^*\s])?)\*(?=[^*\w]|$)/g,
      (_m, pre, t) => `${pre}<em>${t}</em>`,
    );
    // Heading markers at a line start: drop the `#`s, bold the heading text.
    out = out.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, (_m, t) => `<strong>${t}</strong>`);
    // List bullets at a line start → a real bullet.
    out = out.replace(/^\s{0,3}[-*]\s+/gm, "• ");
    return out;
  } catch {
    // Safe fallback: plain escaped text, identical to not parsing at all.
    return escaped;
  }
}
