import { describe, it, expect } from "bun:test";
import { htmlToMrkdwn } from "./html-to-mrkdwn";

describe("htmlToMrkdwn", () => {
  it("passes plain text through, escaping mrkdwn specials", () => {
    expect(htmlToMrkdwn("compare a < b && c > d")).toBe("compare a &lt; b &amp;&amp; c &gt; d");
  });

  it("converts bold and italic", () => {
    expect(htmlToMrkdwn("<strong>hi</strong> and <em>there</em>")).toBe("*hi* and _there_");
    expect(htmlToMrkdwn("<b>x</b> <i>y</i>")).toBe("*x* _y_");
  });

  it("converts inline code and fenced pre", () => {
    expect(htmlToMrkdwn("run <code>npm test</code>")).toBe("run `npm test`");
    expect(htmlToMrkdwn("<pre>line1\nline2</pre>")).toBe("```\nline1\nline2\n```");
  });

  it("turns paragraphs and <br> into newlines", () => {
    expect(htmlToMrkdwn("<p>one</p><p>two</p>")).toBe("one\n\ntwo");
    expect(htmlToMrkdwn("a<br>b")).toBe("a\nb");
  });

  it("converts list items into bullets", () => {
    expect(htmlToMrkdwn("<ul><li>first</li><li>second</li></ul>")).toBe("• first\n• second");
  });

  it("converts links to Slack <url|label> syntax", () => {
    expect(htmlToMrkdwn('see <a href="https://x.com/y">the docs</a>')).toBe("see <https://x.com/y|the docs>");
  });

  it("collapses a link whose label equals its url", () => {
    expect(htmlToMrkdwn('<a href="https://x.com">https://x.com</a>')).toBe("<https://x.com>");
  });

  it("converts headings to bold lines", () => {
    expect(htmlToMrkdwn("<h2>Decision needed</h2>")).toBe("*Decision needed*");
  });

  it("decodes entities then re-escapes for mrkdwn", () => {
    expect(htmlToMrkdwn("Tom &amp; Jerry &lt;3")).toBe("Tom &amp; Jerry &lt;3");
    expect(htmlToMrkdwn("&quot;quoted&quot; &#39;apos&#39;")).toBe("\"quoted\" 'apos'");
  });

  it("strips unknown tags but keeps their text", () => {
    expect(htmlToMrkdwn('<span class="x">kept</span>')).toBe("kept");
  });

  it("handles a realistic escalation fragment", () => {
    const html =
      "<p>The staging DB is ambiguous. Which should I use?</p><ul><li><strong>postgres</strong></li>" +
      '<li>sqlite (see <a href="https://docs/db">docs</a>)</li></ul>';
    expect(htmlToMrkdwn(html)).toBe(
      "The staging DB is ambiguous. Which should I use?\n\n• *postgres*\n• sqlite (see <https://docs/db|docs>)",
    );
  });

  it("does not leave the private-use link sentinels in output", () => {
    const out = htmlToMrkdwn('<a href="https://a">a</a> and <a href="https://b">b</a>');
    expect(out).toBe("<https://a|a> and <https://b|b>");
    expect(out).not.toContain(String.fromCharCode(0xE000));
    expect(out).not.toContain(String.fromCharCode(0xE001));
  });

  it("returns empty string for empty/nullish input", () => {
    expect(htmlToMrkdwn("")).toBe("");
    expect(htmlToMrkdwn(undefined as unknown as string)).toBe("");
  });
});
