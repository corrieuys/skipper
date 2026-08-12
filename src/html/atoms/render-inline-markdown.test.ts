import { describe, it, expect } from "bun:test";
import { renderInlineMarkdown } from "./render-inline-markdown";

describe("renderInlineMarkdown", () => {
  it("renders bold, inline code, and italic", () => {
    expect(renderInlineMarkdown("**Fish Eagle Lodge**")).toBe("<strong>Fish Eagle Lodge</strong>");
    expect(renderInlineMarkdown("shipped at `3ec508b` now")).toBe("shipped at <code>3ec508b</code> now");
    expect(renderInlineMarkdown("a *word* here")).toBe("a <em>word</em> here");
  });

  it("strips heading markers and bolds the heading", () => {
    expect(renderInlineMarkdown("## Re-test complete")).toBe("<strong>Re-test complete</strong>");
  });

  it("turns leading list bullets into •", () => {
    expect(renderInlineMarkdown("- first\n- second")).toBe("• first\n• second");
  });

  it("is XSS-safe — escapes before formatting", () => {
    const out = renderInlineMarkdown("<img src=x onerror=alert(1)> **bold**");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).toContain("<strong>bold</strong>");
  });

  it("keeps HTML inside a code span escaped", () => {
    expect(renderInlineMarkdown("`<b>`")).toBe("<code>&lt;b&gt;</code>");
  });

  it("does not mangle snake_case or paths (no underscore emphasis)", () => {
    expect(renderInlineMarkdown("call some_long_name here")).toBe("call some_long_name here");
    expect(renderInlineMarkdown("/Users/x/my_file_path.ts")).toBe("/Users/x/my_file_path.ts");
  });

  it("leaves arithmetic and globs alone (safe italic boundaries)", () => {
    expect(renderInlineMarkdown("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(renderInlineMarkdown("build *.ts files")).toBe("build *.ts files");
  });

  it("passes an unbalanced marker (from truncation) through as text", () => {
    expect(renderInlineMarkdown("full write-up **qa-security-re…")).toBe("full write-up **qa-security-re…");
    expect(renderInlineMarkdown("read `qa-security-re…")).toBe("read `qa-security-re…");
  });

  it("falls back to escaped plain text when there is no markdown", () => {
    expect(renderInlineMarkdown("just a plain sentence.")).toBe("just a plain sentence.");
  });
});
