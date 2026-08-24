import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { unlinkSync } from "fs";
import { initializeDatabase } from "../db/connection";
import { AgentManager } from "../agents/manager";
import { clearAgentTypeCache } from "../agents/types";
import { eventBus } from "../events/bus";
import type { AgentExitEvent, AgentSignalEvent } from "../events/bus";
import { createCustomAgent, customAgentTypeName, type CustomAgentInput } from "./store";
import { buildSystemPrompt, loadMessages } from "./runner";

const TEST_DB = "test-custom-agent-runner.db";

let db: Database;
let manager: AgentManager;
let workingDir: string;
let origFetch: typeof fetch;
/** Chat-completion payloads served in order, one per model turn. */
let turns: unknown[];
let requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;

function assistant(content: string | null, toolCalls?: Array<{ name: string; args: unknown }>) {
  return {
    id: "x", object: "chat.completion", created: 0, model: "fake",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content,
        ...(toolCalls
          ? {
            tool_calls: toolCalls.map((c, i) => ({
              id: `call_${i}`,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          }
          : {}),
      },
      finish_reason: toolCalls ? "tool_calls" : "stop",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function defineAgent(overrides: Partial<CustomAgentInput> = {}): string {
  const agent = createCustomAgent(db, {
    name: "Tester",
    description: "",
    baseUrl: "http://model.test/v1",
    modelId: "fake",
    apiKey: "sk-test",
    headers: {},
    queryParams: {},
    systemPrompt: "You are a tester.",
    enabledTools: ["read_file", "search_replace"],
    // Empty so the runner never opens an MCP connection; the loopback bridge is
    // covered separately by the daemon's own MCP tests.
    enabledMcpTools: [],
    enabledSkills: [],
    maxSteps: 10,
    temperature: null,
    ...overrides,
  });
  return customAgentTypeName(agent.id);
}

/** Spawn a custom agent on a task and resolve when it exits. */
async function runAgent(typeName: string, prompt: string): Promise<{ exit: AgentExitEvent; runtimeId: string }> {
  const agent = manager.createAgent({ name: "Tester", type: typeName });
  db.prepare("INSERT INTO tasks (id, title, status) VALUES ('task-1', 'T', 'running')").run();

  const exited = new Promise<AgentExitEvent>((resolve) => {
    const handler = (e: AgentExitEvent) => {
      eventBus.off("agent:exit", handler);
      resolve(e);
    };
    eventBus.on("agent:exit", handler);
  });

  const running = await manager.spawnAgent(agent.id, {
    workingDir,
    taskId: "task-1",
    initialPrompt: prompt,
  });
  return { exit: await exited, runtimeId: running.id };
}

beforeEach(() => {
  clearAgentTypeCache();
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  manager = new AgentManager(db);
  workingDir = mkdtempSync(join(tmpdir(), "skipper-runner-"));

  turns = [];
  requests = [];
  origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    const next = turns.shift() ?? assistant("done");
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  manager.close();
  db.close();
  rmSync(workingDir, { recursive: true, force: true });
  try { unlinkSync(TEST_DB); } catch { }
  clearAgentTypeCache();
});

describe("spawning a custom agent", () => {
  it("runs in-process, records the instance with no pid, and exits 0", async () => {
    turns = [assistant("All done.")];
    const typeName = defineAgent();
    const { exit, runtimeId } = await runAgent(typeName, "do the thing");

    expect(exit.code).toBe(0);

    const row = db
      .prepare("SELECT status, process_pid, state_metadata, session_id FROM agent_instances WHERE id = ?")
      .get(runtimeId) as { status: string; process_pid: number | null; state_metadata: string; session_id: string | null };
    expect(row.status).toBe("completed");
    // No pid, plus the marker that distinguishes this from a spawn that never landed.
    expect(row.process_pid).toBeNull();
    expect(JSON.parse(row.state_metadata).in_process).toBe(true);
    // A session id is what keys the conversation history for the next resume.
    expect(row.session_id).toBeTruthy();
  });

  it("sends the prompt as the user message and the definition's system prompt", async () => {
    turns = [assistant("ok")];
    await runAgent(defineAgent(), "investigate the bug");

    const body = requests[0]!.body as { messages: Array<{ role: string; content: unknown }> };
    const system = body.messages.find((m) => m.role === "system")!;
    expect(String(system.content)).toContain("You are a tester.");
    // The runner appends what the model cannot infer.
    expect(String(system.content)).toContain(workingDir);
    expect(String(system.content)).toContain("read_file");

    const user = body.messages.find((m) => m.role === "user")!;
    expect(String(user.content)).toContain("investigate the bug");
  });

  it("authenticates with the configured key and honours custom headers", async () => {
    turns = [assistant("ok")];
    await runAgent(defineAgent({ headers: { "X-Trace": "abc" } }), "go");
    expect(requests[0]!.headers.authorization).toBe("Bearer sk-test");
    expect(requests[0]!.headers["x-trace"]).toBe("abc");
    expect(requests[0]!.url).toBe("http://model.test/v1/chat/completions");
  });

  // Local runners (LM Studio, llama-server) take no key, and an empty bearer is
  // worse than none — some reject it outright.
  it("sends no Authorization header when no key is configured", async () => {
    turns = [assistant("ok")];
    await runAgent(defineAgent({ apiKey: "" }), "go");
    expect(requests[0]!.headers.authorization).toBeUndefined();
  });

  it("resolves a ${ENV_VAR} key from the environment at call time", async () => {
    process.env.SKIPPER_TEST_KEY = "sk-from-env";
    try {
      turns = [assistant("ok")];
      await runAgent(defineAgent({ apiKey: "${SKIPPER_TEST_KEY}" }), "go");
      expect(requests[0]!.headers.authorization).toBe("Bearer sk-from-env");
    } finally {
      delete process.env.SKIPPER_TEST_KEY;
    }
  });
});

describe("tools", () => {
  it("offers only the enabled tools to the model", async () => {
    turns = [assistant("ok")];
    await runAgent(defineAgent({ enabledTools: ["read_file"] }), "go");

    const body = requests[0]!.body as { tools?: Array<{ function: { name: string } }> };
    expect((body.tools ?? []).map((t) => t.function.name)).toEqual(["read_file"]);
  });

  it("sends no tools at all when none are enabled", async () => {
    turns = [assistant("ok")];
    await runAgent(defineAgent({ enabledTools: [] }), "go");
    const body = requests[0]!.body as { tools?: unknown[] };
    expect(body.tools ?? []).toHaveLength(0);
  });

  it("executes a tool call against the working directory and feeds the result back", async () => {
    writeFileSync(join(workingDir, "notes.txt"), "the answer is 42\n");
    turns = [
      assistant(null, [{ name: "read_file", args: { path: "notes.txt" } }]),
      assistant("The answer is 42."),
    ];
    const { exit, runtimeId } = await runAgent(defineAgent(), "read notes.txt");
    expect(exit.code).toBe(0);

    // Second request carries the tool result the model asked for.
    const second = requests[1]!.body as { messages: Array<{ role: string; content: unknown }> };
    expect(JSON.stringify(second.messages)).toContain("the answer is 42");

    const output = db
      .prepare("SELECT data FROM terminal_outputs WHERE agent_id = ? ORDER BY sequence")
      .all(runtimeId) as Array<{ data: string }>;
    const joined = output.map((o) => o.data).join("");
    expect(joined).toContain("[tool] read_file");
    expect(joined).toContain("[tool:result] read_file");
  });

  it("lets an enabled write tool change a file", async () => {
    writeFileSync(join(workingDir, "a.txt"), "before\n");
    turns = [
      assistant(null, [{ name: "search_replace", args: { file_path: "a.txt", old_string: "before", new_string: "after" } }]),
      assistant("Edited."),
    ];
    await runAgent(defineAgent(), "edit a.txt");
    expect(readFileSync(join(workingDir, "a.txt"), "utf-8")).toBe("after\n");
  });
});

describe("output and signals", () => {
  // Assistant prose goes through the same stdout path a CLI's output does, so
  // the surviving stdout markers keep working for in-process agents.
  it("emits a signal for a marker in assistant text", async () => {
    const signals: AgentSignalEvent[] = [];
    const handler = (e: AgentSignalEvent) => signals.push(e);
    eventBus.on("agent:signal", handler);
    try {
      turns = [assistant("Finished the survey.\n[DELEGATE_COMPLETE] survey done")];
      await runAgent(defineAgent(), "go");
      expect(signals.some((s) => s.signalType === "delegate_complete")).toBe(true);
    } finally {
      eventBus.off("agent:signal", handler);
    }
  });

  it("records the assistant text in the terminal output", async () => {
    turns = [assistant("Here is what I found.")];
    const { runtimeId } = await runAgent(defineAgent(), "go");
    const joined = (db
      .prepare("SELECT data FROM terminal_outputs WHERE agent_id = ? ORDER BY sequence")
      .all(runtimeId) as Array<{ data: string }>)
      .map((o) => o.data).join("");
    expect(joined).toContain("Here is what I found.");
  });

  it("emits a turn-end frame on a clean finish (so the daemon's completed-turn gate passes)", async () => {
    // A turn that just answers in prose and stops - no complete_task - must still
    // leave a result/step_finish frame, else manager-daemon fails the task with
    // "exited without completed turn output".
    turns = [assistant("The word was Executor.")];
    const { runtimeId } = await runAgent(defineAgent(), "what was the word?");
    const row = db.prepare(
      `SELECT json_extract(data, '$.type') AS ty FROM terminal_outputs
        WHERE agent_id = ? AND json_valid(data) AND json_extract(data, '$.type') IN ('result','turn.completed','step_finish')`,
    ).get(runtimeId) as { ty: string } | null;
    expect(row?.ty).toBe("step_finish");
  });

  it("does NOT emit a turn-end frame when truncated at the step limit", async () => {
    // Truncation is a failure (exit 1); it must not look like a completed turn.
    turns = [
      assistant(null, [{ name: "read_file", args: { path: "a.txt" } }]),
      assistant(null, [{ name: "read_file", args: { path: "a.txt" } }]),
    ];
    writeFileSync(join(workingDir, "a.txt"), "x");
    const { exit, runtimeId } = await runAgent(defineAgent({ maxSteps: 2 }), "loop");
    expect(exit.code).toBe(1);
    const row = db.prepare(
      `SELECT 1 FROM terminal_outputs
        WHERE agent_id = ? AND json_valid(data) AND json_extract(data, '$.type') IN ('result','turn.completed','step_finish')`,
    ).get(runtimeId);
    expect(row).toBeNull();
  });
});

describe("failure and cancellation", () => {
  it("exits non-zero and records the reason when the endpoint fails", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })) as typeof fetch;

    const { exit, runtimeId } = await runAgent(defineAgent(), "go");
    expect(exit.code).toBe(1);
    expect(
      (db.prepare("SELECT status FROM agent_instances WHERE id = ?").get(runtimeId) as { status: string }).status,
    ).toBe("failed");
    expect(exit.stderrSnippet).toContain("run failed");
  });

  it("exits non-zero when the type has no definition behind it", async () => {
    const typeName = defineAgent();
    // Simulate a definition deleted out from under a team still pointing at it.
    db.prepare("DELETE FROM custom_agents").run();
    const { exit } = await runAgent(typeName, "go");
    expect(exit.code).toBe(1);
  });

  it("settles as cancelled when killed mid-run", async () => {
    // Hangs until aborted, then rejects with a real AbortError so the SDK treats
    // it as a cancellation rather than a retryable failure.
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      const abortError = () => new DOMException("The operation was aborted.", "AbortError");
      if (init?.signal?.aborted) return Promise.reject(abortError());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(abortError()));
      });
    }) as typeof fetch;

    const agent = manager.createAgent({ name: "Tester", type: defineAgent() });
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('task-1', 'T', 'running')").run();
    const exited = new Promise<AgentExitEvent>((resolve) => {
      const handler = (e: AgentExitEvent) => { eventBus.off("agent:exit", handler); resolve(e); };
      eventBus.on("agent:exit", handler);
    });
    const running = await manager.spawnAgent(agent.id, { workingDir, taskId: "task-1", initialPrompt: "go" });

    expect(manager.killAgent(running.id)).toBe(true);
    const exit = await exited;
    expect(exit.code).toBe(1);
    expect(exit.stderrSnippet).toContain("cancelled");
  });
});

describe("step cap", () => {
  // Hitting the cap is not finishing — the model's last act was another tool
  // call. Exiting 0 would advance the phase on truncated work. Found against a
  // small local model that looped until the cap, then claimed it had edited a
  // file it never touched.
  it("exits non-zero and says why when the run is cut off at the step limit", async () => {
    turns = [
      assistant(null, [{ name: "read_file", args: { path: "a.txt" } }]),
      assistant(null, [{ name: "read_file", args: { path: "a.txt" } }]),
    ];
    writeFileSync(join(workingDir, "a.txt"), "x\n");

    const { exit, runtimeId } = await runAgent(defineAgent({ maxSteps: 2 }), "go");
    expect(exit.code).toBe(1);
    expect(exit.stderrSnippet).toContain("2-step limit");

    const joined = (db
      .prepare("SELECT data FROM terminal_outputs WHERE agent_id = ? ORDER BY sequence")
      .all(runtimeId) as Array<{ data: string }>).map((o) => o.data).join("");
    expect(joined).toContain("stopped at the step limit");
  });

  it("exits 0 when the model finishes inside the cap", async () => {
    turns = [assistant("done")];
    const { exit } = await runAgent(defineAgent({ maxSteps: 2 }), "go");
    expect(exit.code).toBe(0);
  });
});

describe("resume", () => {
  // `generateText`'s `response.messages` is the LAST step only. Saving that
  // alone loses every tool call and result, so a resumed run forgets everything
  // its tools told it. Verified against a real provider.
  it("persists tool calls and results, not just the final answer", async () => {
    writeFileSync(join(workingDir, "notes.txt"), "the answer is 42\n");
    turns = [
      assistant(null, [{ name: "read_file", args: { path: "notes.txt" } }]),
      assistant("The answer is 42."),
    ];
    const { runtimeId } = await runAgent(defineAgent(), "read notes.txt");

    const sessionId = (db
      .prepare("SELECT session_id FROM agent_instances WHERE id = ?")
      .get(runtimeId) as { session_id: string }).session_id;
    const stored = loadMessages(db, sessionId);

    expect(stored.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(JSON.stringify(stored)).toContain("the answer is 42");
  });

  it("persists the conversation and replays it on the next spawn", async () => {
    turns = [assistant("First answer.")];
    const typeName = defineAgent();
    const { runtimeId } = await runAgent(typeName, "first question");

    const sessionId = (db
      .prepare("SELECT session_id FROM agent_instances WHERE id = ?")
      .get(runtimeId) as { session_id: string }).session_id;
    const stored = loadMessages(db, sessionId);
    expect(stored.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored)).toContain("first question");

    // Spawn again with the same session: the prior turn must precede the new one.
    turns = [assistant("Second answer.")];
    const agent2 = manager.createAgent({ name: "Tester 2", type: typeName });
    const exited = new Promise<AgentExitEvent>((resolve) => {
      const handler = (e: AgentExitEvent) => { eventBus.off("agent:exit", handler); resolve(e); };
      eventBus.on("agent:exit", handler);
    });
    await manager.spawnAgent(agent2.id, {
      workingDir, taskId: "task-1", initialPrompt: "second question", sessionId,
    });
    await exited;

    const body = requests[1]!.body as { messages: Array<{ role: string; content: unknown }> };
    const userMessages = body.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content));
    expect(userMessages.some((c) => c.includes("first question"))).toBe(true);
    expect(userMessages.some((c) => c.includes("second question"))).toBe(true);
  });
});

describe("buildSystemPrompt", () => {
  const base = {
    id: "a", name: "A", description: "", baseUrl: "http://x/v1", modelId: "m",
    apiKey: "", headers: {}, queryParams: {}, systemPrompt: "Be terse.",
    enabledTools: [], enabledMcpTools: [], enabledSkills: [],
    maxSteps: 5, temperature: null, createdAt: "", updatedAt: "",
  };

  it("states the working directory and its boundary", () => {
    const out = buildSystemPrompt(base, "/repo", ["read_file"]);
    expect(out).toContain("Be terse.");
    expect(out).toContain("/repo");
    expect(out).toContain("refuse paths outside it");
  });

  // "Use your tools" is ambiguous when the tool set is configured per agent.
  it("says outright when there are no tools", () => {
    expect(buildSystemPrompt(base, "/repo", [])).toContain("You have no tools");
  });

  // Without this, a model asked to edit with only read tools loops on reads and
  // then reports the edit as done. Naming the limit gives it an honest answer to
  // reach for — confirmed against a local model, which went from an 8-step loop
  // plus a false claim to a 2-step "I cannot directly edit files".
  it("states it cannot write when no write tool is enabled", () => {
    const out = buildSystemPrompt(base, "/repo", ["read_file", "grep"]);
    expect(out).toContain("cannot create or modify files");
    expect(out).toContain("Never claim to have made a change");
  });

  it("says nothing about writing when a write tool is enabled", () => {
    expect(buildSystemPrompt(base, "/repo", ["read_file", "search_replace"]))
      .not.toContain("cannot create or modify files");
  });
});
