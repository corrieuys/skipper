import { describe, it, expect } from "bun:test";
import { artifactViewDocument } from "./artifact-view";

describe("artifactViewDocument", () => {
  it("serves a full html document untouched", () => {
    const doc = "<!doctype html><html><body><h1>app</h1><script>x()</script></body></html>";
    expect(artifactViewDocument("proto", doc, "html")).toBe(doc);
    expect(artifactViewDocument("proto", "<html><body>x</body></html>", "html")).toBe("<html><body>x</body></html>");
  });

  it("wraps an html fragment in the themed shell", () => {
    const out = artifactViewDocument("frag", "<p>hi</p>", "html");
    expect(out).toContain("<!doctype html>");
    expect(out).toContain('<div class="art"><p>hi</p></div>');
    expect(out).toContain("--sk-text");
    expect(out).toContain("window.parent.document.documentElement");
    expect(out).not.toContain("marked");
  });

  it("renders markdown through marked with the escaped source as fallback", () => {
    const out = artifactViewDocument("plan", "# Plan <b>\n\n- one | two", "markdown");
    expect(out).toContain('<pre id="src" class="art-src"># Plan &lt;b&gt;\n\n- one | two</pre>');
    expect(out).toContain('<div id="out" class="art" hidden>');
    expect(out).toContain("unpkg.com/marked@15.0.7/marked.min.js");
    expect(out).toContain("marked.setOptions({breaks:true,gfm:true})");
    expect(out).toContain("<title>plan</title>");
  });

  it("falls back to sniffing when the format is unknown", () => {
    expect(artifactViewDocument("x", "<!doctype html><p>a</p>", null)).toBe("<!doctype html><p>a</p>");
    expect(artifactViewDocument("x", "plain words", null)).toContain('<pre id="src"');
  });
});
