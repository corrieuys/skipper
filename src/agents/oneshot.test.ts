import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { clearAgentTypeCache } from "./types";
import { buildOneShotCommand, parseOneShotOutput, runOneShotText } from "./oneshot";

const CLAUDE_DEF = {
  command: "claude",
  args: ["--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
  resume_args: null,
  model_flag: "--model",
  supports_resume: true,
  resume_flag: "--resume",
};

const CODEX_DEF = {
  command: "codex",
  args: ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-"],
  resume_args: ["exec", "resume", "{{session_id}}", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-"],
  model_flag: "-m",
  supports_resume: true,
  resume_flag: null,
};

const OPENCODE_DEF = {
  command: "opencode",
  args: ["run", "{{prompt}}", "--format", "json"],
  resume_args: ["run", "{{prompt}}", "--format", "json", "--session", "{{session_id}}"],
  model_flag: "-m",
  supports_resume: true,
  resume_flag: null,
};

const GROK_DEF = {
  command: "grok",
  args: ["-p", "{{prompt}}", "--output-format", "streaming-json", "--always-approve", "--no-auto-update"],
  resume_args: null,
  model_flag: "-m",
  supports_resume: true,
  resume_flag: "--resume",
};

describe("buildOneShotCommand", () => {
  it("claude: stdin prompt, model flag, native system prompt, resume flag", () => {
    const { cmd, stdinPrompt } = buildOneShotCommand(CLAUDE_DEF, {
      model: "claude-haiku-4-5",
      prompt: "hello",
      systemPrompt: "be brief",
      sessionId: "sess-1",
      extraArgs: ["--max-turns", "1"],
    });
    expect(cmd[0]).toBe("claude");
    expect(cmd).toContain("--resume");
    expect(cmd[cmd.indexOf("--resume") + 1]).toBe("sess-1");
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("claude-haiku-4-5");
    expect(cmd[cmd.indexOf("--system-prompt") + 1]).toBe("be brief");
    expect(cmd.slice(-2)).toEqual(["--max-turns", "1"]);
    // No {{prompt}} placeholder — prompt goes to stdin, unmodified (system prompt is a flag)
    expect(stdinPrompt).toBe("hello");
  });

  it("claude: 'default' model adds no model flag", () => {
    const { cmd } = buildOneShotCommand(CLAUDE_DEF, { model: "default", prompt: "x" });
    expect(cmd).not.toContain("--model");
  });

  it("codex: resume args replace base args and substitute the session id", () => {
    const { cmd, stdinPrompt } = buildOneShotCommand(CODEX_DEF, {
      model: "default",
      prompt: "fix it",
      systemPrompt: "sys",
      sessionId: "thread-9",
    });
    expect(cmd).toEqual(["codex", "exec", "resume", "thread-9", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-"]);
    // No system-prompt flag — prepended to the stdin prompt instead
    expect(stdinPrompt).toBe("sys\n\nfix it");
  });

  it("opencode: inline {{prompt}} substitution includes the prepended system prompt", () => {
    const { cmd, stdinPrompt } = buildOneShotCommand(OPENCODE_DEF, {
      model: "opencode/big-pickle",
      prompt: "do thing",
      systemPrompt: "sys",
    });
    expect(stdinPrompt).toBeNull();
    expect(cmd).toContain("sys\n\ndo thing");
    expect(cmd[cmd.indexOf("-m") + 1]).toBe("opencode/big-pickle");
    expect(cmd).not.toContain("{{prompt}}");
  });

  it("grok: inline {{prompt}}, model flag, resume flag appended", () => {
    const { cmd, stdinPrompt } = buildOneShotCommand(GROK_DEF, {
      model: "grok-4.5",
      prompt: "do thing",
      systemPrompt: "sys",
      sessionId: "grok-sess-1",
    });
    expect(stdinPrompt).toBeNull();
    expect(cmd[0]).toBe("grok");
    expect(cmd).toContain("sys\n\ndo thing");
    expect(cmd).toContain("streaming-json");
    expect(cmd[cmd.indexOf("--resume") + 1]).toBe("grok-sess-1");
    expect(cmd[cmd.indexOf("-m") + 1]).toBe("grok-4.5");
    expect(cmd).not.toContain("{{prompt}}");
  });
});

describe("parseOneShotOutput", () => {
  it("claude: prefers the result event and captures session + usage", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "thinking out loud" }] } }),
      JSON.stringify({ type: "result", result: "final answer", session_id: "s-1", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 }),
    ].join("\n");
    const res = parseOneShotOutput(stdout, null);
    expect(res?.text).toBe("final answer");
    expect(res?.sessionId).toBe("s-1");
    expect(res?.usage?.input_tokens).toBe(10);
    expect(res?.usage?.cost_usd).toBe(0.01);
  });

  it("codex: takes the last agent_message and skips reasoning items", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t-2" }),
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "hmm" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "the answer" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3 } }),
    ].join("\n");
    const res = parseOneShotOutput(stdout, null);
    expect(res?.text).toBe("the answer");
    expect(res?.sessionId).toBe("t-2");
    expect(res?.usage).toBeNull();
  });

  it("opencode: reads part.text events", () => {
    const stdout = JSON.stringify({ type: "text", part: { text: "opencode says hi" }, sessionID: "oc-3" });
    const res = parseOneShotOutput(stdout, null);
    expect(res?.text).toBe("opencode says hi");
    expect(res?.sessionId).toBe("oc-3");
  });

  it("grok: joins text chunks, skips thoughts, captures sessionId from end", () => {
    const stdout = [
      JSON.stringify({ type: "thought", data: "pondering" }),
      JSON.stringify({ type: "text", data: "grok " }),
      JSON.stringify({ type: "text", data: "says hi" }),
      JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "g-4", requestId: "r-1" }),
    ].join("\n");
    const res = parseOneShotOutput(stdout, null);
    expect(res?.text).toBe("grok says hi");
    expect(res?.sessionId).toBe("g-4");
    expect(res?.usage).toBeNull();
  });

  it("plain-text CLI output falls back to raw stdout", () => {
    const res = parseOneShotOutput("just some text\n", "keep-me");
    expect(res?.text).toBe("just some text");
    expect(res?.sessionId).toBe("keep-me");
  });

  it("empty output returns null", () => {
    expect(parseOneShotOutput("", null)).toBeNull();
    expect(parseOneShotOutput(JSON.stringify({ type: "result", result: "" }), null)).toBeNull();
  });

  it("claude error results fail the whole call, even with assistant-echoed text", () => {
    const errorResult = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Model not found: bogus" });
    expect(parseOneShotOutput(errorResult, null)).toBeNull();
    // Failed runs echo the error into assistant text — that echo is not an answer.
    const mixed = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Model not found: bogus" }] } }),
      errorResult,
    ].join("\n");
    expect(parseOneShotOutput(mixed, null)).toBeNull();
    // A genuine success result still wins over an earlier error frame.
    const recovered = [errorResult, JSON.stringify({ type: "result", result: "real answer" })].join("\n");
    expect(parseOneShotOutput(recovered, null)?.text).toBe("real answer");
  });
});

describe("runOneShotText", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDatabase(db);
    clearAgentTypeCache();
  });

  it("returns null for an unknown agent type", async () => {
    const res = await runOneShotText({ db, agentType: "no-such-provider", model: "default", prompt: "x" });
    expect(res).toBeNull();
  });
});
