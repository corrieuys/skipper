// Structural HTML validator for artifact bodies.
//
// Why this exists: agents occasionally store malformed HTML (mismatched or
// unclosed tags) which then breaks the artifact viewer's layout in the UI.
// Bun's built-in HTMLRewriter is a lenient streaming parser — it silently
// accepts the exact malformation we want to catch — so we run a small
// tag-stack parser inline at create time and reject the write, reporting the
// tag and the line/column where the node tree broke.
//
// Scope: this checks *structure* (balanced, well-nested tags) and bans a small
// set of tags that don't belong in an in-container artifact (document wrappers,
// scripts, styles, embedded frames). It is intentionally not a full HTML5
// conformance checker — it targets the failure modes that break rendering.

// Elements that never have a closing tag and must not be pushed onto the stack.
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

// Tags rejected outright: document wrappers (the body renders inside an existing
// styled container), and script/style/frames (unsafe or stripped downstream).
const DISALLOWED_ELEMENTS = new Set([
  "html", "head", "body", "script", "style", "iframe", "object", "embed", "base",
]);

export interface HtmlValidationOk {
  ok: true;
}

export interface HtmlValidationError {
  ok: false;
  /** Human-readable message including the location and the reason. */
  message: string;
  line: number;
  column: number;
  /** The tag involved, when applicable (lowercased, no brackets). */
  tag?: string;
}

export type HtmlValidationResult = HtmlValidationOk | HtmlValidationError;

interface OpenTag {
  name: string;
  line: number;
  column: number;
}

/** 1-based line/column for a byte offset into `s`. */
function positionAt(s: string, index: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < index && i < s.length; i++) {
    if (s[i] === "\n") {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: index - lastNewline };
}

/**
 * Validate that `body` is well-formed, safely-nested HTML suitable for the
 * artifact viewer. Returns `{ ok: true }` or a structured error pinpointing
 * where the node tree broke.
 */
export function validateArtifactHtml(body: string): HtmlValidationResult {
  const stack: OpenTag[] = [];
  const len = body.length;
  let i = 0;

  const errAt = (index: number, message: string, tag?: string): HtmlValidationError => {
    const { line, column } = positionAt(body, index);
    return { ok: false, message: `${message} (line ${line}, col ${column})`, line, column, tag };
  };

  while (i < len) {
    const lt = body.indexOf("<", i);
    if (lt === -1) break;

    const next = body[lt + 1];

    // Not a tag start (e.g. "a < b" in prose) — treat as literal text.
    if (next === undefined || !/[a-zA-Z!/]/.test(next)) {
      i = lt + 1;
      continue;
    }

    // Comments: <!-- ... -->
    if (body.startsWith("<!--", lt)) {
      const end = body.indexOf("-->", lt + 4);
      if (end === -1) return errAt(lt, "Unterminated HTML comment");
      i = end + 3;
      continue;
    }

    // Declarations / CDATA: <!DOCTYPE ...>, <![CDATA[...]]> — skip to '>'.
    if (next === "!") {
      const end = body.indexOf(">", lt);
      if (end === -1) return errAt(lt, "Unterminated declaration");
      i = end + 1;
      continue;
    }

    const isClosing = next === "/";
    const nameStart = lt + (isClosing ? 2 : 1);
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(body.slice(nameStart));
    if (!nameMatch) {
      // '<' followed by '/' or letter but no valid name — malformed.
      return errAt(lt, "Malformed tag: expected a tag name after '<'");
    }
    const tagName = nameMatch[0].toLowerCase();

    // Find the tag's closing '>', respecting quoted attribute values so a '>'
    // inside an attribute doesn't end the tag early.
    let j = nameStart + nameMatch[0].length;
    let quote: string | null = null;
    let gt = -1;
    for (; j < len; j++) {
      const c = body[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        gt = j;
        break;
      }
    }
    if (gt === -1) return errAt(lt, `Unterminated <${isClosing ? "/" : ""}${tagName}> tag: no closing '>'`, tagName);

    const selfClosing = body[gt - 1] === "/";

    if (isClosing) {
      if (DISALLOWED_ELEMENTS.has(tagName)) {
        return errAt(lt, `Disallowed </${tagName}> tag — not permitted in artifact HTML`, tagName);
      }
      if (VOID_ELEMENTS.has(tagName)) {
        return errAt(lt, `Void element </${tagName}> should not have a closing tag`, tagName);
      }
      if (stack.length === 0) {
        return errAt(lt, `Unexpected closing tag </${tagName}> — no open element to close`, tagName);
      }
      const top = stack[stack.length - 1]!;
      if (top.name !== tagName) {
        return errAt(
          lt,
          `Mismatched closing tag </${tagName}> — expected </${top.name}> (opened at line ${top.line}, col ${top.column})`,
          tagName,
        );
      }
      stack.pop();
    } else {
      if (DISALLOWED_ELEMENTS.has(tagName)) {
        return errAt(lt, `Disallowed <${tagName}> tag — not permitted in artifact HTML`, tagName);
      }
      if (!selfClosing && !VOID_ELEMENTS.has(tagName)) {
        const { line, column } = positionAt(body, lt);
        stack.push({ name: tagName, line, column });
      }
    }

    i = gt + 1;
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1]!;
    const { line, column } = unclosed;
    return {
      ok: false,
      message: `Unclosed <${unclosed.name}> tag (opened at line ${line}, col ${column}) — reached end of document`,
      line,
      column,
      tag: unclosed.name,
    };
  }

  return { ok: true };
}
