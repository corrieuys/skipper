import type { Database } from "bun:sqlite";
import type { TaskScheduler } from "./scheduler";
import { getTaskTitleModelOverride } from "../config/model-settings";
import { getAgentTypeDefinition } from "../agents/types";
import { runOneShotText, CLAUDE_ISOLATION_ARGS } from "../agents/oneshot";
import { logError } from "../logging";

/**
 * Task title generation. When a task is created with a blank title, the daemon
 * asks the operator-configured "Task Title Generator" agent (config page) for a
 * short title built from the description (and, for a manual recurring run, the
 * run input). Provider + model come from `model-settings.ts`; if none is
 * configured a blank title is rejected at create time, so generation is only
 * reached when a generator exists. The timestamp fallback here is a runtime
 * safety net for a configured generator whose call fails, never the no-config
 * path.
 */

const TITLE_TIMEOUT_MS = 30_000;
const MAX_TITLE_LEN = 80;

const TITLE_SYSTEM_PROMPT = `You generate a short, specific title for a task, from its description.

- At most about 8 words. No trailing period. No surrounding quotes. No markdown.
- Capture the concrete action or subject. Do not invent details that are not present.
- Never use em dashes.

Return ONLY the title text, nothing else.`;

export interface TitleInputs {
  description?: string | null;
  runInput?: string | null;
}

/** ISO minute stamp, matching the recurring-run title format used elsewhere. */
export function timestampTitle(): string {
  return new Date().toISOString().slice(0, 16).replace("T", " ");
}

/** Normalise the model's reply to a single clean title line, or null if empty. */
export function cleanTitle(text: string | undefined | null): string | null {
  if (!text) return null;
  let t = (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  // Peel wrapping quotes and trailing sentence punctuation, repeatedly, since a
  // model may emit e.g. `"Fix the bug".` with the dot outside the quotes.
  let prev = "";
  while (t !== prev) {
    prev = t;
    t = t.replace(/^["'`]+/, "").replace(/["'`]+$/, "").replace(/[.\s]+$/, "").trim();
  }
  if (!t) return null;
  return t.length > MAX_TITLE_LEN ? t.slice(0, MAX_TITLE_LEN).trim() : t;
}

/**
 * Ask the configured generator for a title. Returns null when no generator is
 * configured, there is no usable input, or the call fails.
 */
export async function generateTaskTitle(db: Database, inputs: TitleInputs): Promise<string | null> {
  const choice = getTaskTitleModelOverride(db);
  if (!choice.agent_type) return null;

  const parts: string[] = [];
  const desc = inputs.description?.trim();
  const input = inputs.runInput?.trim();
  if (desc) parts.push(`Description:\n${desc}`);
  if (input) parts.push(`Run input:\n${input}`);
  if (!parts.length) return null;

  const isClaude = getAgentTypeDefinition(choice.agent_type, db)?.command === "claude";
  try {
    const result = await runOneShotText({
      db,
      agentType: choice.agent_type,
      model: choice.model ?? "default",
      prompt: parts.join("\n\n"),
      systemPrompt: TITLE_SYSTEM_PROMPT,
      timeoutMs: TITLE_TIMEOUT_MS,
      extraArgs: isClaude ? ["--max-turns", "1", ...CLAUDE_ISOLATION_ARGS] : [],
      // A title needs no extended thinking; keep the pass fast on claude.
      env: isClaude ? { MAX_THINKING_TOKENS: "0" } : {},
    });
    return cleanTitle(result?.text);
  } catch (err) {
    logError(db, "task.title_generator", { agentType: choice.agent_type }, err);
    return null;
  }
}

/**
 * Ensure a task has a title. No-op when it already has one (unless `force`).
 * Generates from the description + run input; falls back to a timestamp only if a
 * configured generator's call fails. Fire-and-forget: callers do not await it, so
 * the create request returns immediately and the title lands within a second or
 * two via `updateTitle`'s event.
 */
export async function ensureTaskTitle(
  db: Database,
  scheduler: TaskScheduler,
  taskId: string,
  opts: { runInput?: string | null; force?: boolean } = {},
): Promise<void> {
  const task = scheduler.getTask(taskId);
  if (!task) return;
  if (task.title && task.title.trim() && !opts.force) return;

  const generated = await generateTaskTitle(db, {
    description: task.description,
    runInput: opts.runInput ?? task.run_input,
  });
  scheduler.updateTitle(taskId, generated ?? timestampTitle());
}
