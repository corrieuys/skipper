import { describe, it, expect } from "bun:test";
import { validateArtifactHtml } from "./html-validator";

describe("validateArtifactHtml", () => {
  it("accepts well-formed, nested HTML", () => {
    const body = `<h2>Title</h2>
<p>Some <strong>bold</strong> and <em>italic</em> text.</p>
<ul><li>one</li><li>two</li></ul>
<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>`;
    expect(validateArtifactHtml(body)).toEqual({ ok: true });
  });

  it("accepts void elements without a closing tag", () => {
    expect(validateArtifactHtml("<p>line<br>break</p><hr>").ok).toBe(true);
  });

  it("accepts self-closing syntax", () => {
    expect(validateArtifactHtml("<p>x</p><br/>").ok).toBe(true);
  });

  it("accepts a stray '<' in prose (not a tag start)", () => {
    expect(validateArtifactHtml("<p>a < b and c > d</p>").ok).toBe(true);
  });

  it("accepts attribute values containing '>'", () => {
    expect(validateArtifactHtml(`<a href="x?a=1&b=2" title="a > b">link</a>`).ok).toBe(true);
  });

  it("rejects an unclosed tag and reports where it opened", () => {
    const res = validateArtifactHtml("<ul><li>x</ul>");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.tag).toBe("ul");
      expect(res.message).toContain("Mismatched closing tag </ul>");
      expect(res.message).toContain("expected </li>");
      expect(res.message).toMatch(/line \d+, col \d+/);
    }
  });

  it("rejects a tag left open at end of document", () => {
    const res = validateArtifactHtml("<div><p>hello</p>");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.tag).toBe("div");
      expect(res.message).toContain("Unclosed <div>");
    }
  });

  it("rejects an unexpected closing tag with no open element", () => {
    const res = validateArtifactHtml("<p>x</p></div>");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("Unexpected closing tag </div>");
  });

  it("reports an accurate line and column", () => {
    const res = validateArtifactHtml("<p>ok</p>\n<p>ok</p>\n  <ul></p>");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.line).toBe(3);
      expect(res.column).toBe(7); // position of </p>
    }
  });

  it("rejects disallowed document-wrapper and script tags", () => {
    expect(validateArtifactHtml("<body><p>x</p></body>").ok).toBe(false);
    expect(validateArtifactHtml("<script>alert(1)</script>").ok).toBe(false);
    expect(validateArtifactHtml("<p>ok</p><style>p{}</style>").ok).toBe(false);
    expect(validateArtifactHtml("<iframe src='x'></iframe>").ok).toBe(false);
  });

  it("rejects an unterminated tag", () => {
    const res = validateArtifactHtml("<p>text <a href='x'");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("Unterminated");
  });

  it("skips comments", () => {
    expect(validateArtifactHtml("<!-- a comment --><p>x</p>").ok).toBe(true);
  });
});
