import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { generateText, stepCountIs, type ModelMessage, type Tool } from "ai";
import { logError } from "../logging";
import { buildModel } from "./model";
import { connectMcpTools, daemonToolName } from "./mcp-tools";
import { connectServerTools } from "./server-tools";
import { listMcpServers } from "./servers";
import { resolveSessionCustomTools } from "../custom-tools/registration";
import { buildSkillsIndex, buildSkillTool } from "./skills";
import { buildLocalTools, LOCAL_TOOLS } from "./tools/registry";
import type { CustomAgent } from "./store";

/**
 * The subset of `AgentManager` the runner needs. Narrow on purpose: the runner
 * is constructed by the manager, so a full type here would be circular, and the
 * narrow one documents exactly how an in-process agent reaches the outside world.
 */
export interface RunnerHost {
  /** Text that must be scanned for stdout signal markers, exactly as a CLI's stdout is. */
  ingestSyntheticStdout(runtimeId: string, text: string): void;
  /** Text recorded for the operator's terminal view only, never signal-scanned. */
  appendSyntheticOutput(runtimeId: string, data: string, options?: { stream?: "stdout" | "stderr" }): void;
  /** Failure detail. Buffered, so it reaches `agent:exit` as the stderr snippet. */
  ingestSyntheticStderr(runtimeId: string, text: string): void;
}

export interface CustomAgentRunInput {
  db: Database;
  host: RunnerHost;
  agent: CustomAgent;
  runtimeId: string;
  workingDir: string;
  prompt: string;
  /** Prior conversation to resume, or null to start cold. */
  sessionId: string | null;
  /** Port the daemon's own MCP endpoint is listening on. */
  daemonPort: number;
  /**
   * True when this custom agent is running a task SOLO (entrypoint of a
   * team-of-one). The runner then auto-includes the solo essential daemon tools
   * (complete_task, escalate, notes, artifacts) so the sole executor can close
   * its own task even if its definition did not enable them. The daemon still
   * gates by session role, so only tools it offers a solo session are connected.
   */
  solo?: boolean;
}

/**
 * Daemon tools a solo custom agent needs to function as the sole executor of a
 * task, regardless of what its definition ticked. All are in the daemon's solo
 * (single-agent) tool profile, so connecting them is safe.
 */
const SOLO_ESSENTIAL_TOOLS = [
  "complete_task",
  "escalate",
  "post_message",
  "create_note",
  "list_notes",
  "create_artifact",
  "create_file_artifact",
  "list_artifacts",
  "get_artifact",
] as const;

export interface CustomAgentRunResult {
  exitCode: number;
  sessionId: string;
}

/**
 * A process handle for something that is not a process.
 *
 * `AgentManager` tracks every live agent through this shape — pid, kill, exited.
 * An in-process run has no pid, so `pid` is null and every liveness probe in the
 * orchestrator is taught to skip it (see `state_metadata.in_process`). `kill()`
 * aborts the model call; `exited` settles once with the resulting code, which is
 * what drives `handleProcessExit` and, through it, phase advancement.
 */
export class InProcessHandle {
  readonly pid = null;
  readonly exited: Promise<number>;
  readonly abort = new AbortController();
  private settle!: (code: number) => void;
  private settled = false;

  constructor() {
    this.exited = new Promise<number>((resolve) => {
      this.settle = resolve;
    });
  }

  kill(): void {
    if (this.settled) return;
    this.abort.abort();
  }

  /** Called by the runner when the run finishes, one way or another. */
  finish(code: number): void {
    if (this.settled) return;
    this.settled = true;
    this.settle(code);
  }

  get isSettled(): boolean {
    return this.settled;
  }
}

/** stdin for an agent that has none. Nothing calls it — custom types are inline-prompt. */
export const NOOP_STDIN = {
  write(_data: string): void {},
  flush(): void {},
  end(): void {},
};

/**
 * Run one turn of a custom agent to completion.
 *
 * The whole run is a single `generateText` call with a step cap. That mirrors
 * what a CLI provider does per spawn: one invocation, tools used in a loop
 * internally, one exit code at the end. Every respawn the orchestrator already
 * performs — resume, regression, idle poke, escalation revive — becomes another
 * call with the prior messages replayed.
 */
export async function runCustomAgent(input: CustomAgentRunInput, handle: InProcessHandle): Promise<CustomAgentRunResult> {
  const { db, host, agent, runtimeId, workingDir, prompt, daemonPort } = input;
  const sessionId = input.sessionId ?? randomUUID();

  let closeMcp: (() => Promise<void>) | null = null;
  let closeServers: (() => Promise<void>) | null = null;

  try {
    const tools: Record<string, Tool> = {
      ...buildLocalTools(agent.enabledTools, { workingDir }),
      ...buildSkillTool(agent.enabledSkills),
    };

    // Tools from registered MCP servers. Contacted before the daemon loopback
    // because a stdio server has to be spawned and could be slow; failing here
    // must not cost the agent its Skipper tools too.
    if (agent.enabledServerTools.length > 0) {
      try {
        const bridge = await connectServerTools(listMcpServers(db), agent.enabledServerTools);
        closeServers = bridge.close;
        Object.assign(tools, bridge.tools);
        if (bridge.missing.length > 0) {
          host.ingestSyntheticStderr(
            runtimeId,
            `[skipper] MCP server tools unavailable this run: ${bridge.missing.join(", ")}\n`,
          );
        }
      } catch (err) {
        logError(db, "custom_agent.server_tools", { runtimeId, agentId: agent.id }, err);
        host.ingestSyntheticStderr(
          runtimeId,
          `[skipper] could not load MCP server tools: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    // Operator-defined tools come over the same loopback as Skipper's own, so a
    // custom agent and a CLI agent execute them by the identical path. The names
    // are resolved with the same function the daemon registers by, rather than
    // from `agent.enabledCustomTools` alone — otherwise a tool granted by the
    // TEAM would be registered on the session and then filtered back out here.
    const customToolNames = resolveSessionCustomTools(db, runtimeId).map((t) => t.name);
    const daemonToolNames = Array.from(new Set([
      ...agent.enabledMcpTools,
      ...customToolNames,
      ...(input.solo ? SOLO_ESSENTIAL_TOOLS : []),
    ]));

    if (daemonToolNames.length > 0) {
      try {
        const bridge = await connectMcpTools({
          port: daemonPort,
          runtimeId,
          enabled: daemonToolNames,
        });
        closeMcp = bridge.close;
        Object.assign(tools, bridge.tools);

        // Bridge keys carry the mcp__skipper-daemon__ prefix; the enabled list is bare.
        const missing = daemonToolNames.filter((name) => !(daemonToolName(name) in bridge.tools));
        if (missing.length > 0) {
          // Usually correct rather than broken: phase-lifecycle tools are
          // root-only, so a delegated child legitimately gets fewer than the
          // definition enables. Recorded so it is visible either way.
          host.ingestSyntheticStderr(
            runtimeId,
            `[skipper] enabled tools not offered to this session: ${missing.join(", ")}\n`,
          );
        }
      } catch (err) {
        // A custom agent that cannot reach the daemon should still do its local
        // work and say so, rather than failing the task before it starts.
        logError(db, "custom_agent.mcp_connect", { runtimeId, agentId: agent.id }, err);
        host.ingestSyntheticStderr(
          runtimeId,
          `[skipper] could not reach the Skipper MCP server; running with local tools only: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    const messages = loadMessages(db, sessionId);
    messages.push({ role: "user", content: prompt });

    const system = buildSystemPrompt(agent, workingDir, Object.keys(tools));

    host.appendSyntheticOutput(
      runtimeId,
      `[skipper] ${agent.name} · ${agent.modelId} · tools: ${Object.keys(tools).join(", ") || "none"}\n`,
    );

    const result = await generateText({
      model: buildModel(agent),
      system,
      messages,
      tools,
      stopWhen: stepCountIs(agent.maxSteps),
      abortSignal: handle.abort.signal,
      ...(agent.temperature === null ? {} : { temperature: agent.temperature }),
      onStepFinish: (step) => {
        for (const call of step.toolCalls) {
          host.appendSyntheticOutput(runtimeId, `[tool] ${call.toolName} ${compact(call.input)}\n`);
          // A model can name a tool it was never given. Nothing runs, which is
          // the point — but silence here reads as "the edit worked", so the
          // refusal is stated rather than left to be inferred from a missing
          // result line.
          if (!(call.toolName in tools)) {
            host.ingestSyntheticStderr(
              runtimeId,
              `[skipper] refused: ${call.toolName} is not enabled for this agent\n`,
            );
          }
        }
        for (const toolResult of step.toolResults) {
          host.appendSyntheticOutput(runtimeId, `[tool:result] ${toolResult.toolName} ${compact(toolResult.output)}\n`);
        }
        // Assistant prose goes through the signal-scanning path so `[MSG:…]` and
        // `[DELEGATE_COMPLETE]` are picked up exactly as they are from a CLI's
        // stdout. Tool renderings above deliberately do not — a marker inside a
        // tool argument is not the agent signalling.
        if (step.text.trim()) host.ingestSyntheticStdout(runtimeId, `${step.text}\n`);
      },
    });

    // Every step's messages, not `result.response.messages` — that is the LAST
    // step only, so a run that used tools would resume having forgotten every
    // tool call it made and every result it got back. Flattening the steps keeps
    // the assistant/tool pairs intact and in order, which is the shape a provider
    // requires when the history is replayed.
    saveMessages(db, sessionId, runtimeId, [
      ...messages,
      ...result.steps.flatMap((step) => step.response.messages),
    ]);

    // Hitting the step cap is not finishing. `stopWhen` cuts the loop off
    // mid-thought: the model's last act was another tool call, so it had more to
    // do. Exiting 0 there would tell the orchestrator the phase is complete and
    // advance the task on truncated work — the same lie a killed CLI agent
    // avoids by exiting non-zero. Observed against a small local model that
    // looped on read_file until the cap and then claimed it had made an edit.
    const truncated = result.steps.length >= agent.maxSteps && result.finishReason === "tool-calls";
    if (truncated) {
      host.ingestSyntheticStderr(
        runtimeId,
        `[skipper] stopped at the ${agent.maxSteps}-step limit with work still in progress. `
        + "Anything it claimed to finish after this point is unverified. Raise Max steps on the agent, or narrow the task.\n",
      );
    }

    host.appendSyntheticOutput(
      runtimeId,
      `[skipper] ${truncated ? "stopped at the step limit" : "finished"} after ${result.steps.length} step(s), ${result.usage.totalTokens ?? 0} tokens\n`,
    );

    // Emit a turn-end marker frame on a clean finish. A CLI agent ends every turn
    // with a `result`/`turn.completed`/`step_finish` JSON frame, and the daemon's
    // exit handler FAILS a non-streaming clean exit that has none
    // (`manager-daemon.ts:hasCompletedTurnOutput`). An in-process agent otherwise
    // emits only plain text, so a turn that ends WITHOUT calling `complete_task`
    // (e.g. a small model that just answers in prose) would be wrongly failed
    // instead of parked idle for a poke. Skip it when truncated - that IS a
    // failure and must exit non-zero. `appendSyntheticOutput` stores the raw JSON
    // without signal-scanning; a text-less `step_finish` renders nothing in the
    // activity feed (see `terminalJsonSummary.ts`).
    if (!truncated) {
      host.appendSyntheticOutput(
        runtimeId,
        JSON.stringify({ type: "step_finish", subtype: "custom_agent_turn_end" }) + "\n",
      );
    }

    return { exitCode: truncated ? 1 : 0, sessionId };
  } catch (err) {
    const aborted = handle.abort.signal.aborted;
    const message = err instanceof Error ? err.message : String(err);
    if (!aborted) logError(db, "custom_agent.run", { runtimeId, agentId: agent.id }, err);
    host.ingestSyntheticStderr(
      runtimeId,
      aborted ? "[skipper] run cancelled\n" : `[skipper] run failed: ${message}\n`,
    );
    return { exitCode: 1, sessionId };
  } finally {
    if (closeMcp) await closeMcp().catch(() => {});
    // Closing a stdio server's client kills its child process. This must run on
    // every path — a cancelled run that skipped it would leave servers behind.
    if (closeServers) await closeServers().catch(() => {});
  }
}

/**
 * System prompt: the operator's text, then the facts the agent cannot infer.
 *
 * The working directory matters because every file tool resolves against it and
 * refuses to leave; without saying so, a model that guesses an absolute path
 * elsewhere just collects errors. The tool list is named because a custom agent's
 * tool set is configured per agent, so "use your tools" is otherwise ambiguous.
 */
export function buildSystemPrompt(agent: CustomAgent, workingDir: string, toolNames: string[]): string {
  const parts: string[] = [];
  if (agent.systemPrompt.trim()) parts.push(agent.systemPrompt.trim());

  parts.push(
    [
      "## Environment",
      "",
      `Working directory: ${workingDir}`,
      "File tools resolve relative paths against it and refuse paths outside it.",
    ].join("\n"),
  );

  if (toolNames.length > 0) {
    const lines = [
      "## Tools",
      "",
      `Available to you: ${toolNames.join(", ")}. You have no others.`,
    ];
    // A model asked to edit with no write tool will otherwise loop on reads and
    // then report the edit as done. Naming the limit gives it the honest answer
    // to reach for instead. Keyed off the registry rather than a name list, so a
    // new write tool is covered without touching this.
    const canWrite = LOCAL_TOOLS.some((t) => t.writes && toolNames.includes(t.id));
    if (!canWrite) {
      lines.push(
        "",
        "You cannot create or modify files — you have no tool that writes. If you are asked to change something, say plainly that you cannot and report what you found instead. Never claim to have made a change.",
      );
    }
    parts.push(lines.join("\n"));
  } else {
    parts.push("## Tools\n\nYou have no tools. Answer from the information in the prompt alone.");
  }

  const skillsIndex = buildSkillsIndex(agent.enabledSkills);
  if (skillsIndex) parts.push(skillsIndex);

  return parts.join("\n\n");
}

/** Compact a tool payload for the terminal view — enough to follow, not a dump. */
function compact(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = (text ?? "").replace(/\s+/g, " ").trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export function loadMessages(db: Database, sessionId: string): ModelMessage[] {
  const rows = db
    .prepare("SELECT message FROM custom_agent_messages WHERE session_id = ? ORDER BY seq")
    .all(sessionId) as Array<{ message: string }>;
  const messages: ModelMessage[] = [];
  for (const row of rows) {
    try {
      messages.push(JSON.parse(row.message) as ModelMessage);
    } catch {
      // A message we cannot parse is dropped rather than failing the resume —
      // a short history beats no run.
    }
  }
  return messages;
}

/**
 * Replace the session's history with the full conversation.
 *
 * Rewritten rather than appended because `generateText` returns the canonical
 * message list for the turn, including tool calls and results in the shape the
 * provider expects them back. Reconstructing that by appending deltas is where
 * resume bugs live.
 */
export function saveMessages(db: Database, sessionId: string, instanceId: string, messages: ModelMessage[]): void {
  const write = db.transaction((rows: ModelMessage[]) => {
    db.prepare("DELETE FROM custom_agent_messages WHERE session_id = ?").run(sessionId);
    const insert = db.prepare(
      "INSERT INTO custom_agent_messages (id, session_id, instance_id, seq, message) VALUES (?, ?, ?, ?, ?)",
    );
    rows.forEach((message, i) => {
      insert.run(randomUUID(), sessionId, instanceId, i, JSON.stringify(message));
    });
  });
  write(messages);
}
