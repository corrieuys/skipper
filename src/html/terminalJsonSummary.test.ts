import { describe, it, expect } from "bun:test";
import { terminalJsonSummary, stripThinking } from "./terminalJsonSummary";
import { parseTerminalActivity } from "./pages/command-center.page";
import { recentActivityFragment } from "./recentActivityFragment";

/**
 * The activity feed drops any row whose summary is empty, so a provider frame
 * shape that `terminalJsonSummary` doesn't recognise is not rendered badly — it
 * is not rendered at all. That is how grok's whole output went missing.
 *
 * Grok now runs with `--output-format streaming-messages-json`, one whole message
 * per line in the Anthropic wire format, so it lands in the claude-shaped branches.
 * The `{type:"text"|"thought",data}` chunk frames below are its OTHER format, kept
 * working for installs whose seeded agent_types.json still asks for it.
 */
const grokLine = (o: Record<string, unknown>) => ({ stream: "stdout", data: JSON.stringify(o), agent_name: "Skipper" });

/** The lines an operator actually reads, without the raw frame carried for the detail modal. */
function visibleText(html: string): string[] {
  return [...html.matchAll(/<span class="mc-activity__text">([\s\S]*?)<\/span>/g)]
    .map(m => m[1]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
}

/** Frame shapes captured from a real `grok --output-format streaming-messages-json` run. */
const GROK_MESSAGES_RUN = [
  { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "Hello.\n\n**Files in this directory:**\n- `notes.md`" },
  { type: "assistant", message: { role: "assistant", model: "grok-4.5", content: [{ type: "thinking", thinking: "Simple response: hello, list files, done." }, { type: "text", text: "Hello.\n\n**Files in this directory:**" }] } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "- /work/notes.md" }] } },
  { type: "assistant", message: { role: "assistant", model: "grok-4.5", content: [{ type: "thinking", thinking: "I need the listing first." }, { type: "tool_use", name: "list_dir", input: { path: "/work" } }] } },
  { type: "system", subtype: "init", session_id: "019fe72e", model: "grok-4.5" },
];

describe("grok streaming-messages-json — the format Skipper asks for", () => {
  it("renders a turn as message and tool rows, not a blank feed", () => {
    const html = parseTerminalActivity(GROK_MESSAGES_RUN.map(grokLine));

    expect(html).not.toContain("No activity yet");
    expect(html).toContain("Hello.");
    expect(html).toContain("list_dir");
    expect(html).toContain('data-activity-kind="tool"');
    expect(html).toContain('data-activity-kind="message"');
  });

  it("keeps a whole assistant message on one row", () => {
    // The point of the format: no token chunking, so one message is one row —
    // not a column of one-word rows.
    const rows = parseTerminalActivity([grokLine(GROK_MESSAGES_RUN[1]!)]).match(/mc-activity__item /g) ?? [];
    expect(rows).toHaveLength(1);
  });

  it("keeps reasoning out of the message text", () => {
    // The raw frame stays in the row's data attribute for the detail modal; it is
    // the visible line that must not be reasoning. Message rows now render inline
    // markdown, so the `**…**` shows as <strong>; the point is no thinking text.
    const shown = visibleText(parseTerminalActivity([grokLine(GROK_MESSAGES_RUN[1]!)]));
    expect(shown).toEqual(["Hello.\n\n<strong>Files in this directory:</strong>"]);
    expect(shown[0]).not.toContain("Simple response");
  });

  it("shows the init frame as a one-word system row", () => {
    // {type:"system",subtype:"init"} is where the resume session id comes from;
    // it has nothing to say to the operator beyond "started".
    expect(visibleText(parseTerminalActivity([grokLine(GROK_MESSAGES_RUN[4]!)]))).toEqual(["init"]);
  });
});

describe("terminalJsonSummary — grok streaming-json (legacy) frames", () => {
  it("summarises a response chunk as its text", () => {
    expect(terminalJsonSummary({ type: "text", data: "Reading the config file" })).toBe("Reading the config file");
  });

  it("marks a reasoning chunk so the Messages filter drops it", () => {
    const summary = terminalJsonSummary({ type: "thought", data: "Maybe the port is wrong" });
    expect(summary).toStartWith("<thinking>");
    expect(stripThinking(summary)).toBe("");
  });

  it("reads grok's top-level string error message", () => {
    expect(terminalJsonSummary({ type: "error", message: "model overloaded" })).toBe("model overloaded");
    // Claude's nested shape still wins where it is present.
    expect(terminalJsonSummary({ type: "error", error: { message: "nested" } })).toBe("nested");
  });

  it("summarises OpenCode's {type:'text',part:{text}} as the message text", () => {
    // Same `type` as grok's chunk, but text lives in `part` not top-level `data`.
    expect(terminalJsonSummary({ type: "text", part: { type: "text", text: "opencode said this" } })).toBe("opencode said this");
    // A part with no usable text (e.g. step wrappers) still drops to "".
    expect(terminalJsonSummary({ type: "text", part: { type: "step-start" } })).toBe("");
  });

  it("still summarises the shapes it already handled", () => {
    expect(terminalJsonSummary({ type: "result", result: "done" })).toBe("done");
    expect(terminalJsonSummary({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })).toBe("hi");
    expect(terminalJsonSummary({ type: "item.completed", item: { type: "agent_message", text: "codex says" } })).toBe("codex says");
  });
});

describe("activity feed — an OpenCode run is visible", () => {
  const ocLine = (o: Record<string, unknown>) => ({ stream: "stdout", data: JSON.stringify(o), agent_name: "Skipper" });

  it("renders OpenCode message text as a message row, not a dropped one", () => {
    const html = parseTerminalActivity([ocLine({ type: "text", sessionID: "ses_1", part: { type: "text", text: "notes.txt is one file here" } })]);
    expect(html).toContain("notes.txt is one file here");
    expect(html).toContain('data-activity-kind="message"');
    expect(html).not.toContain("No activity yet");
  });

  it("drops OpenCode step wrapper frames (no prose)", () => {
    expect(parseTerminalActivity([ocLine({ type: "step_start", part: { type: "step-start" } })])).toContain("No activity yet");
  });

  it("shows OpenCode text in the dashboard feed too", () => {
    const html = recentActivityFragment([
      { agent_id: "a1", agent_name: "Skipper", stream: "stdout", data: JSON.stringify({ type: "text", part: { type: "text", text: "Deploying now" } }), created_at: "2026-08-11 10:00:00" },
    ]);
    expect(html).toContain("Deploying now");
    expect(html).toContain("cmd-feed-item-message");
  });
});

describe("activity feed — a grok run is visible", () => {
  it("renders response text as a message row, not a dropped one", () => {
    const html = parseTerminalActivity([grokLine({ type: "text", data: "Patched the handler" })]);
    expect(html).toContain("Patched the handler");
    expect(html).toContain('data-activity-kind="message"');
    expect(html).not.toContain("No activity yet");
  });

  it("keeps reasoning out of the message rows", () => {
    // Classified as a message so the Messages filter is the one that governs it,
    // then dropped by stripThinking — the same treatment Claude's thinking gets.
    expect(parseTerminalActivity([grokLine({ type: "thought", data: "hmm" })])).toContain("No activity yet");
  });

  it("shows a grok error", () => {
    expect(parseTerminalActivity([grokLine({ type: "error", message: "rate limited" })])).toContain("rate limited");
  });

  it("renders a whole streamed turn in order", () => {
    // Newest-first, as the route pulls it. `end` carries no prose and stays out.
    const html = parseTerminalActivity([
      grokLine({ type: "end", sessionId: "s-1" }),
      grokLine({ type: "text", data: " the tests." }),
      grokLine({ type: "text", data: "Running" }),
    ]);
    expect(html.indexOf(" the tests.")).toBeLessThan(html.indexOf("Running"));
    expect(html).not.toContain("s-1");
  });

  it("shows grok text in the dashboard feed too", () => {
    const html = recentActivityFragment([
      { agent_id: "a1", agent_name: "Skipper", stream: "stdout", data: JSON.stringify({ type: "text", data: "Deploying" }), created_at: "2026-08-09 10:00:00" },
    ]);
    expect(html).toContain("Deploying");
    expect(html).toContain("cmd-feed-item-message");
    // The raw frame is no longer dumped in place of a summary.
    expect(html).not.toContain("&quot;type&quot;");
  });
});
