import type { Database } from "bun:sqlite";
import { getDictationModelChoice } from "../config/model-settings";
import { getAgentTypeDefinition } from "../agents/types";
import { runOneShotText, CLAUDE_ISOLATION_ARGS } from "../agents/oneshot";

/**
 * One-shot LLM cleanup of a dictated task description. The raw whisper
 * transcript is inserted into the form immediately; this pass runs after and
 * replaces it when it succeeds ("raw now, rewrite later"). Provider + model
 * come from the config page (Dictation Rewriter row, machine-scoped
 * app_settings); any allowlisted provider works via the one-shot runner.
 */

const CLEANUP_TIMEOUT_MS = 45_000;

const CLEANUP_SYSTEM_PROMPT = `You clean up dictated task descriptions. The user spoke a task description out loud and it was transcribed by speech-to-text.

Rewrite the transcript:
- Fix punctuation, casing, and obvious transcription errors.
- Remove speech disfluencies: filler words (um, uh, you know), false starts, and self-corrections (keep only the corrected version).
- Keep ALL substantive content. Do not summarize, do not invent anything that was not said.
- Keep the speaker's wording where it is already clear; format as plain prose (short paragraphs or dash lists if the speaker enumerated items).
- Never use em dashes.

Return ONLY the rewritten description. No preamble, no quotes, no commentary.`;

/** Returns the cleaned text, or null on any failure so callers keep the raw transcript. */
export async function cleanupTranscript(db: Database, raw: string): Promise<string | null> {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const choice = getDictationModelChoice(db);
  const isClaude = getAgentTypeDefinition(choice.agent_type, db)?.command === "claude";

  const result = await runOneShotText({
    db,
    agentType: choice.agent_type,
    model: choice.model,
    prompt: trimmed,
    systemPrompt: CLEANUP_SYSTEM_PROMPT,
    timeoutMs: CLEANUP_TIMEOUT_MS,
    extraArgs: isClaude ? ["--max-turns", "1", ...CLAUDE_ISOLATION_ARGS] : [],
    // Rewrites don't need extended thinking; keep the pass fast on claude.
    env: isClaude ? { MAX_THINKING_TOKENS: "0" } : {},
  });

  const cleaned = result?.text.trim();
  return cleaned ? cleaned : null;
}
