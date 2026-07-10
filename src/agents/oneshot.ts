import type { Database } from "bun:sqlite";
import { getAgentTypeDefinition } from "./types";
import { extractTextFromJsonEvent, type JsonEvent } from "./manager";
import { agentSpawnPath } from "../paths";

/**
 * Provider-generic one-shot text call: spawn a provider CLI once, feed it a
 * prompt, and return the final assistant text. Built for lightweight internal
 * consumers (Greg's brain, the dictation rewriter) that need a quick LLM answer
 * without the full AgentManager machinery (no instance rows, no MCP injection,
 * no signal parsing).
 *
 * The command line comes from the same `agent_types` definitions AgentManager
 * spawns from, so whatever provider the operator picks on the config page works
 * here too: `{{prompt}}`/`{{session_id}}` placeholders are substituted, the
 * prompt goes to stdin when the args have no placeholder (claude `--print`,
 * codex's trailing `-`), and `model_flag` is appended unless model is "default".
 */

export interface OneShotUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

export interface OneShotResult {
  text: string;
  /** Session id captured from the output stream, for callers that resume. */
  sessionId: string | null;
  /** Only populated for providers whose usage frames we parse (claude result). */
  usage: OneShotUsage | null;
}

export interface OneShotOptions {
  db?: Database;
  agentType: string;
  /** "default" (or empty) means no model flag — the CLI's own default. */
  model: string;
  prompt: string;
  /**
   * Native `--system-prompt` flag for claude-family commands; prepended to the
   * prompt text for providers without a system-prompt flag.
   */
  systemPrompt?: string;
  /** Resume a prior session where the provider supports it. */
  sessionId?: string | null;
  timeoutMs?: number;
  /** Appended verbatim — caller decides provider-specific extras. */
  extraArgs?: string[];
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// Claude-CLI-specific isolation for tool-less utility calls (Greg, dictation
// rewriter): no MCP servers (failed/needs-auth ones stall startup 30s+), no
// tools, no user/project settings or hooks. Callers pass this as extraArgs
// only when the resolved provider command is `claude`.
export const CLAUDE_ISOLATION_ARGS = [
  "--strict-mcp-config", // with no --mcp-config, this disables all MCP servers
  "--tools", "",         // no tools at all
  "--setting-sources", "", // skip user/project/local settings (and their hooks)
];

export interface OneShotCommand {
  cmd: string[];
  stdinPrompt: string | null;
}

/** Exported for tests — pure arg construction, no spawn. */
export function buildOneShotCommand(
  typeDef: {
    command: string;
    args: string[];
    resume_args: string[] | null;
    model_flag: string | null;
    supports_resume: boolean;
    resume_flag: string | null;
  },
  opts: Pick<OneShotOptions, "model" | "prompt" | "systemPrompt" | "sessionId" | "extraArgs">,
): OneShotCommand {
  const isClaude = typeDef.command === "claude";
  const effectivePrompt = !isClaude && opts.systemPrompt
    ? `${opts.systemPrompt}\n\n${opts.prompt}`
    : opts.prompt;

  const useResume = !!(opts.sessionId && typeDef.supports_resume);
  let inline = false;
  const substitute = (arg: string): string => {
    if (arg === "{{prompt}}") { inline = true; return effectivePrompt; }
    return opts.sessionId ? arg.replaceAll("{{session_id}}", opts.sessionId) : arg;
  };

  let args: string[];
  if (useResume && typeDef.resume_args && typeDef.resume_args.length > 0) {
    args = typeDef.resume_args.map(substitute);
  } else {
    args = typeDef.args.map(substitute);
    if (useResume && typeDef.resume_flag) {
      args.push(...typeDef.resume_flag.split(" "), opts.sessionId!);
    }
  }

  if (opts.model && opts.model !== "default" && typeDef.model_flag) {
    args.push(typeDef.model_flag, opts.model);
  }
  if (isClaude && opts.systemPrompt) {
    args.push("--system-prompt", opts.systemPrompt);
  }
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }

  return { cmd: [typeDef.command, ...args], stdinPrompt: inline ? null : effectivePrompt };
}

/** Exported for tests — pure stdout parsing, no spawn. */
export function parseOneShotOutput(stdout: string, priorSessionId: string | null): OneShotResult | null {
  let resultText: string | null = null;
  let lastText: string | null = null;
  let sessionId = priorSessionId;
  let usage: OneShotUsage | null = null;
  let sawJson = false;
  let sawErrorResult = false;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: JsonEvent;
    try {
      event = JSON.parse(line) as JsonEvent;
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    sawJson = true;

    sessionId = event.session_id ?? event.thread_id ?? event.sessionID ?? sessionId;

    if (event.type === "result") {
      // Claude reports failures as result events too (is_error / error subtype)
      // with the error message in .result — that's a failure, not the answer.
      const isError = event.is_error === true
        || (typeof event.subtype === "string" && event.subtype.startsWith("error"));
      if (isError) {
        console.warn("[oneshot] provider returned an error result: %s", String(event.result ?? "").slice(0, 200));
        sawErrorResult = true;
        continue;
      }
      if (typeof event.result === "string") resultText = event.result;
      if (event.usage) {
        const u = event.usage as Record<string, number | undefined>;
        usage = {
          input_tokens: u.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          cache_read_tokens: u.cache_read_input_tokens ?? 0,
          cache_write_tokens: u.cache_creation_input_tokens ?? 0,
          cost_usd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : 0,
        };
      }
      continue;
    }

    // Codex emits reasoning items with the same {item:{text}} shape as agent
    // messages — only the agent_message is the answer.
    if (event.item?.type && event.item.type !== "agent_message") continue;

    const text = extractTextFromJsonEvent(event);
    if (text && text.trim()) lastText = text;
  }

  // A failed run echoes its error into assistant text too — without a genuine
  // success result, nothing in the stream is a trustworthy answer.
  if (sawErrorResult && resultText === null) return null;

  // Plain-text CLI (or a provider format we don't know): the raw output is the answer.
  const text = (resultText ?? lastText ?? (sawJson ? "" : stdout)).trim();
  if (!text) return null;
  return { text, sessionId, usage };
}

export async function runOneShotText(opts: OneShotOptions): Promise<OneShotResult | null> {
  const typeDef = getAgentTypeDefinition(opts.agentType, opts.db);
  if (!typeDef || !typeDef.command) {
    console.warn("[oneshot] unknown agent type: %s", opts.agentType);
    return null;
  }

  const { cmd, stdinPrompt } = buildOneShotCommand(typeDef, opts);

  const env: Record<string, string> = { ...process.env as Record<string, string> };
  env.PATH = agentSpawnPath();
  for (const [key, template] of Object.entries(typeDef.env_vars)) {
    env[key] = template.replace("{{model}}", opts.model);
  }
  if (opts.env) Object.assign(env, opts.env);
  delete env.CLAUDECODE;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const proc = Bun.spawn(cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    if (stdinPrompt !== null) {
      proc.stdin.write(stdinPrompt);
    }
    proc.stdin.end();

    let killed = false;
    const timeout = setTimeout(() => { killed = true; try { proc.kill(); } catch { } }, timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timeout);

    if (killed) {
      console.warn("[oneshot] %s timed out after %dms", typeDef.command, timeoutMs);
    }
    if (stderr.trim()) {
      console.warn("[oneshot] %s stderr: %s", typeDef.command, stderr.slice(0, 300));
    }

    return parseOneShotOutput(stdout, opts.sessionId ?? null);
  } catch (err) {
    console.warn("[oneshot] %s failed: %s", typeDef.command, err instanceof Error ? err.message : String(err));
    return null;
  }
}
