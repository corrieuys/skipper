import { describe, it, expect } from "bun:test";
import { htmlToText, toPlainText, toOneLine, decodeEntities } from "./plain-text";

describe("htmlToText", () => {
  it("turns an escalation body into readable lines with bullets and code", () => {
    const html =
      "<p>A test is ready to run, but the exact target needs confirmation.</p><p><strong>Which test should I run?</strong></p>" +
      "<ul><li>Run a basic <code>Hello world</code> smoke test</li><li>Run the current <code>dash</code> test task</li><li>Run a different test you specify</li></ul>";
    expect(htmlToText(html)).toBe(
      "A test is ready to run, but the exact target needs confirmation.\n\nWhich test should I run?\n\n• Run a basic `Hello world` smoke test\n• Run the current `dash` test task\n• Run a different test you specify",
    );
  });

  it("keeps preformatted blocks, decodes entities and renders links", () => {
    const html = "<pre>line 1\n  line 2</pre><p>See <a href=\"https://x.io/docs\">the docs</a> &amp; &lt;stuff&gt; &#8212; &#x2713;</p>";
    expect(htmlToText(html)).toBe("line 1\n  line 2\nSee the docs (https://x.io/docs) & <stuff> — ✓");
  });

  it("drops scripts, comments and unknown tags", () => {
    expect(htmlToText("<script>x()</script><!-- c --><span data-x=1>hi</span><br>there")).toBe("hi\nthere");
  });
});

describe("toPlainText / toOneLine", () => {
  it("passes markdown and plain text through untouched", () => {
    expect(toPlainText("**bold** and `code`\n- item", "markdown")).toBe("**bold** and `code`\n- item");
    expect(toPlainText("a < b and c > d", "text")).toBe("a < b and c > d");
    expect(toPlainText("plain with no tags")).toBe("plain with no tags");
  });

  it("detects html without a format hint and flattens for one-line use", () => {
    expect(toPlainText("<p>hi</p><ul><li>a</li><li>b</li></ul>")).toBe("hi\n\n• a\n• b");
    expect(toOneLine("<p>hi</p><ul><li>a</li><li>b</li></ul>")).toBe("hi • a • b");
  });

  it("decodes numeric and named entities", () => {
    expect(decodeEntities("&quot;q&quot; &#65;&#x42; &nbsp;&unknown;")).toBe('"q" AB  &unknown;');
  });
});
