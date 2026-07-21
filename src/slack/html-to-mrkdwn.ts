// Convert an agent-authored HTML fragment into Slack mrkdwn.
//
// Escalation questions (and other agent output surfaced to Slack) are HTML, which
// Slack renders as literal tag soup (`&lt;p&gt;...`). Agents shouldn't have to know
// their output might land in Slack, so we translate at the boundary: common inline /
// block tags -> mrkdwn, links -> Slack `<url|label>` syntax, everything else stripped,
// entities decoded, and the three mrkdwn specials (& < >) re-escaped.
//
// Plain text passes through essentially unchanged - no tags means just entity decode
// + escaping, equivalent to the old `mrkdwn()` escaper - so it is safe to route any
// agent text through this, HTML or not.

// Private-use sentinels wrapping a link index, so the global escape pass can't mangle
// the `<url|label>` form we build for links.
const LINK_OPEN = String.fromCharCode(0xE000);
const LINK_CLOSE = String.fromCharCode(0xE001);

export function htmlToMrkdwn(input: string): string {
  let s = String(input ?? "");
  if (!s) return "";

  // Drop script/style content outright.
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Protect links as tokens (restored after the escape pass).
  const links: string[] = [];
  s = s.replace(
    /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, text: string) => {
      const url = escapeSpecials(decodeEntities(href.trim()));
      const label = escapeSpecials(decodeEntities(collapse(stripTags(text))));
      if (!url) return label;
      const token = `${LINK_OPEN}${links.length}${LINK_CLOSE}`;
      links.push(label && label !== url ? `<${url}|${label}>` : `<${url}>`);
      return token;
    },
  );

  // Code blocks first (raw), so a nested <code> inside <pre> is stripped, not
  // turned into an inline backtick span.
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => `\n\`\`\`\n${stripTags(inner).trim()}\n\`\`\`\n`);

  // Inline emphasis / code BEFORE block elements, so block inners (li/h/quote)
  // keep the mrkdwn we produce here rather than having their tags stripped away.
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `*${inner}*`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `_${inner}_`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => `\`${stripTags(inner)}\``);

  // Block elements (inners now carry converted inline mrkdwn).
  s = s.replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_m, inner: string) => `\n*${collapse(stripTags(inner))}*\n`);
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) =>
    "\n" + collapse(stripTags(inner)).split("\n").map((l) => `> ${l}`).join("\n") + "\n",
  );
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `• ${collapse(stripTags(inner))}\n`);

  // Structural whitespace: <br> and closing paragraph/div → blank line; other
  // closing block tags → single newline.
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\/(p|div)\s*>/gi, "\n\n");
  s = s.replace(/<\/(tr|ul|ol|h[1-6])\s*>/gi, "\n");

  // Drop any remaining *real* tags (a name after `<` or `</`), leaving stray
  // `<`/`>` from plain text (e.g. `a < b`) untouched. decode + re-escape after.
  s = stripTags(s);
  s = escapeSpecials(decodeEntities(s));

  // Restore protected links (real <url|label>, kept unescaped).
  s = s.replace(new RegExp(`${LINK_OPEN}(\\d+)${LINK_CLOSE}`, "g"), (_m, i: string) => links[Number(i)] ?? "");

  // Tidy: strip trailing spaces per line, collapse 3+ blank lines, trim ends.
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Remove HTML tags only — `<`/`>` not forming a tag (e.g. `a < b`) stay put. */
function stripTags(s: string): string {
  return String(s).replace(/<\/?[a-zA-Z][^>]*>/g, "");
}

function collapse(s: string): string {
  return String(s).replace(/\s+/g, " ").trim();
}

/** Escape the three characters Slack mrkdwn treats specially. */
function escapeSpecials(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Decode the HTML entities agents commonly emit. `&amp;` is decoded last. */
function decodeEntities(s: string): string {
  return String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}
