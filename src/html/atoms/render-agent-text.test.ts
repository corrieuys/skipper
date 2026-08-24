import { describe, it, expect } from "bun:test";
import { renderAgentText, decodeHtmlEntities, agentTextPreview } from "./render-agent-text";

describe("decodeHtmlEntities", () => {
  it("decodes named + numeric entities in one pass", () => {
    expect(decodeHtmlEntities("&lt;p&gt;hi&lt;/p&gt;")).toBe("<p>hi</p>");
    expect(decodeHtmlEntities("a &amp; b")).toBe("a & b");
    expect(decodeHtmlEntities("&#39;x&#39; &#x27;y&#x27;")).toBe("'x' 'y'");
  });
  it("undoes exactly one level (double-encoded stays half-decoded)", () => {
    expect(decodeHtmlEntities("&amp;lt;p&amp;gt;")).toBe("&lt;p&gt;");
  });
  it("is a no-op without entities", () => {
    expect(decodeHtmlEntities("plain text")).toBe("plain text");
  });
});

describe("renderAgentText", () => {
  it("renders entity-encoded HTML as real HTML (the escalation bug)", () => {
    const out = renderAgentText("&lt;p&gt;Body empty&lt;/p&gt;&lt;ul&gt;&lt;li&gt;a&lt;/li&gt;&lt;/ul&gt;");
    expect(out).toBe('<div class="sk-md"><p>Body empty</p><ul><li>a</li></ul></div>');
    expect(out).not.toContain("&lt;");
  });
  it("renders raw HTML as HTML", () => {
    expect(renderAgentText("<p>hi</p>")).toBe('<div class="sk-md"><p>hi</p></div>');
  });
  it("routes plain/markdown text through the client markdown pass", () => {
    const out = renderAgentText("**bold** text");
    expect(out).toContain("data-artifact-md");
    expect(out).toContain("**bold** text");
  });
});

describe("agentTextPreview", () => {
  it("decodes, strips tags, collapses whitespace", () => {
    expect(agentTextPreview("&lt;p&gt;hello   world&lt;/p&gt;")).toBe("hello world");
  });
  it("clips to max with an ellipsis", () => {
    const out = agentTextPreview("x".repeat(200), 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
  });
});
