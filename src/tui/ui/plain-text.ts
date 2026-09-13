/**
 * Terminal-friendly text from agent-authored bodies. Escalation questions,
 * operator messages and notes may arrive as HTML (the web UI renders them);
 * the terminal shows structure with newlines, bullets and backticks instead.
 * Markdown is left as-is: it already reads well in a terminal.
 */

const BLOCK_TAGS = ["p", "div", "section", "article", "header", "footer", "blockquote", "pre", "table", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "dl", "dt", "dd", "hr", "figure", "details", "summary"];

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  bull: "•",
  middot: "·",
  copy: "©",
  trade: "™",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    const v = ENTITIES[body.toLowerCase()];
    return v ?? m;
  });
}

/** True when the string carries HTML tags worth converting. */
export function looksLikeHtml(s: string): boolean {
  return /<\/?(p|div|br|ul|ol|li|strong|b|em|i|code|pre|a|h[1-6]|table|tr|td|th|blockquote|span)\b[^>]*>/i.test(s);
}

/** HTML → plain text with line structure, bullets and inline code kept readable. */
export function htmlToText(html: string): string {
  let s = html.replace(/\r\n?/g, "\n");
  // Drop invisible content.
  s = s.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Preformatted blocks keep their newlines; everything else collapses.
  const pres: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) => {
    pres.push(decodeEntities(body.replace(/<[^>]+>/g, "")));
    return `\n\u0001PRE${pres.length - 1}\u0001\n`;
  });
  s = s.replace(/\s+/g, " ");
  // Line breaks + list items.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n• ");
  s = s.replace(/<\/li>/gi, "");
  s = s.replace(/<(h[1-6])\b[^>]*>/gi, "\n");
  s = s.replace(/<\/(h[1-6])>/gi, "\n");
  s = s.replace(/<hr\b[^>]*>/gi, "\n───\n");
  // Table cells → columns separated by two spaces.
  s = s.replace(/<\/(td|th)>\s*<(td|th)\b[^>]*>/gi, "  ");
  s = s.replace(/<\/?(td|th)\b[^>]*>/gi, "");
  // Inline emphasis + code.
  s = s.replace(/<\/?(strong|b)\b[^>]*>/gi, "");
  s = s.replace(/<\/?(em|i)\b[^>]*>/gi, "");
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, body: string) => "`" + body.replace(/<[^>]+>/g, "") + "`");
  // Links: text (url) when the url adds information.
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
    const t = text.replace(/<[^>]+>/g, "").trim();
    if (!t) return href;
    return t === href || href.startsWith("#") ? t : `${t} (${href})`;
  });
  // Block boundaries → newlines.
  const block = new RegExp(`</?(${BLOCK_TAGS.join("|")})\\b[^>]*>`, "gi");
  s = s.replace(block, "\n");
  // Anything left is stripped.
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  // Restore <pre> bodies.
  s = s.replace(/\u0001PRE(\d+)\u0001/g, (_m, i: string) => pres[Number(i)] ?? "");
  // Tidy: trim line ends, collapse runs of blank lines.
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, "").replace(/^ +(?=•)/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}

/** Body text for the terminal: HTML converted, markdown/plain passed through. */
export function toPlainText(body: string, format?: string | null): string {
  if (!body) return "";
  if (format === "html" || (format !== "text" && format !== "markdown" && looksLikeHtml(body))) return htmlToText(body);
  return body.replace(/\r\n?/g, "\n");
}

/** One-line version for banners, list rows and toasts. */
export function toOneLine(body: string, format?: string | null): string {
  return toPlainText(body, format).replace(/\s*\n\s*•\s*/g, " • ").replace(/\s+/g, " ").trim();
}
