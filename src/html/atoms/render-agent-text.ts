import { escapeHtml } from "./escape-html";
import { looksLikeHtml } from "./sniff-html";

// Agent-authored text (escalation questions/responses, notes) reaches us in one
// of two shapes: raw HTML (`<p>…`) or entity-encoded HTML (`&lt;p&gt;…`, how some
// providers emit it through the tool-call boundary). The web used to sniff the
// string as-is: an encoded body failed the HTML sniff, went down the markdown
// path, and — because it was escaped again server-side and only decoded once by
// the client `marked` pass — the raw tags leaked as visible text.
//
// The iOS RichTextView solved this by decoding entities via a textarea BEFORE
// sniffing (see skipper-ios RichTextView.document). We mirror that here: recover
// the raw source first, then decide HTML vs markdown on the decoded text. Same
// trust model as artifacts — agent HTML is rendered as HTML (see sniff-html).

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/**
 * Decode the common named + numeric HTML entities in one pass, recovering the
 * raw source. A single pass intentionally undoes exactly one level of encoding
 * (so double-encoded `&amp;lt;` becomes `&lt;`, not `<`), matching a textarea's
 * `.value`. Returns the input unchanged when it holds no entities.
 */
export function decodeHtmlEntities(s: string): string {
  if (!s || s.indexOf("&") === -1) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X"
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ent) ? NAMED_ENTITIES[ent]! : m;
  });
}

/**
 * Render an agent-authored string for a card body: decode entities, then render
 * HTML as HTML or fall back to the client markdown pass (`data-artifact-md`,
 * handled by skipper.js:renderMarkdownBlocks). Shared by the escalation card and
 * the timeline so the two never drift.
 */
export function renderAgentText(text: string): string {
  const raw = decodeHtmlEntities(text ?? "");
  return looksLikeHtml(raw)
    ? `<div class="sk-md">${raw}</div>`
    : `<div class="sk-md" data-artifact-md>${escapeHtml(raw)}</div>`;
}

/**
 * Plain-text preview of agent HTML/markdown for a truncated list row: decode
 * entities, strip tags, collapse whitespace, then clip. Mirrors the iOS
 * `String.richTextPreview`. The caller still `escapeHtml`s the result for display.
 */
export function agentTextPreview(text: string, max = 140): string {
  let s = decodeHtmlEntities(text ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = s.slice(0, max).trimEnd() + "…";
  return s;
}
