import { describe, it, expect } from "bun:test";
import { chatPartFragment, chatUserBubble, chatAssistantMessage } from "./chatPartFragment";
import type { MessagePart } from "../events/bus";

describe("chatPartFragment", () => {
  it("renders a plain-text block escaped inside a full-width bubble", () => {
    const html = chatPartFragment({ kind: "text", content: "hello <world>\nline2" });
    expect(html).toContain('class="chat-bubble chat-bubble-text"');
    expect(html).toContain("hello &lt;world&gt;");
    // Plain text is wrapped in a client-side markdown container, newlines intact
    expect(html).toContain("data-artifact-md");
    expect(html).toContain("line2");
    expect(html).not.toContain("<script");
  });

  it("renders HTML-looking text content as-is so the agent can emit semantic markup", () => {
    const html = chatPartFragment({
      kind: "text",
      content: "<p>Hello <strong>world</strong></p>",
    });
    expect(html).toContain("<p>Hello <strong>world</strong></p>");
  });

  it("renders HTML tags when prose leads before the first tag", () => {
    const html = chatPartFragment({
      kind: "text",
      content: "Import Policy done.\n\n<p>Updated <strong>file.bru</strong>:</p>\n<ul><li>change</li></ul>",
    });
    expect(html).toContain("<p>Updated <strong>file.bru</strong>:</p>");
    expect(html).toContain("<ul><li>change</li></ul>");
    expect(html).not.toContain("&lt;p&gt;");
    expect(html).not.toContain("&lt;strong&gt;");
  });

  it("strips dangerous wrappers from HTML text content", () => {
    const html = chatPartFragment({
      kind: "text",
      content: "<p>safe</p><script>alert(1)</script><style>bad{}</style>",
    });
    expect(html).toContain("<p>safe</p>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<style");
  });

  it("renders thinking blocks as a collapsed details bubble with low-accent class", () => {
    const html = chatPartFragment({ kind: "thinking", content: "consider this" });
    expect(html).toContain("<details");
    expect(html).toContain('class="chat-bubble chat-bubble-thinking"');
    expect(html).toContain("<summary>thinking</summary>");
    expect(html).toContain("consider this");
    expect(html).not.toContain(" open");
  });

  it("renders tool_use blocks with tool name in summary and JSON input in preformatted body", () => {
    const html = chatPartFragment({
      kind: "tool_use",
      name: "Bash",
      input: { command: "ls" },
      content: '{\n  "command": "ls"\n}',
    });
    expect(html).toContain("chat-bubble-tool-use");
    expect(html).toContain("tool · Bash");
    expect(html).toContain("&quot;command&quot;: &quot;ls&quot;");
  });

  it("renders tool_result blocks distinct from tool_use", () => {
    const html = chatPartFragment({
      kind: "tool_result",
      toolUseId: "tu-1",
      content: "exit 0",
    });
    expect(html).toContain("chat-bubble-tool-result");
    expect(html).toContain("tool result");
    expect(html).toContain("exit 0");
  });
});

describe("chatAssistantMessage", () => {
  it("renders each part as its own bubble when parts are present", () => {
    const parts: MessagePart[] = [
      { kind: "thinking", content: "reasoning" },
      { kind: "tool_use", name: "Read", input: { path: "/a" }, content: '{"path":"/a"}' },
      { kind: "text", content: "<p>done</p>" },
    ];
    const html = chatAssistantMessage("msg-1", "done", parts);
    expect(html).toContain("chat-bubble-thinking");
    expect(html).toContain("chat-bubble-tool-use");
    expect(html).toContain("chat-bubble-text");
    // Order preserved
    const thinkingIdx = html.indexOf("chat-bubble-thinking");
    const toolIdx = html.indexOf("chat-bubble-tool-use");
    const textIdx = html.indexOf("chat-bubble-text");
    expect(thinkingIdx).toBeLessThan(toolIdx);
    expect(toolIdx).toBeLessThan(textIdx);
  });

  it("falls back to a single text bubble when parts is empty (non-streaming agent path)", () => {
    const html = chatAssistantMessage("msg-2", "<p>final only</p>", []);
    expect(html).toContain("chat-bubble-text");
    expect(html).toContain("<p>final only</p>");
    expect(html).not.toContain("chat-bubble-thinking");
  });
});

describe("chatUserBubble", () => {
  it("escapes user content and renders right-aligned bubble class", () => {
    const html = chatUserBubble("u-1", "hi <there>");
    expect(html).toContain("chat-message-user");
    expect(html).toContain("hi &lt;there&gt;");
    expect(html).not.toContain("hi <there>");
  });
});
