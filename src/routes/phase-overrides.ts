import type { ConsensusConfig } from "../teams/manager";
import { getDb } from "../db/connection";

export type PhaseOverride = { prompt?: string; review?: boolean; consensus?: ConsensusConfig | null };

const PROMPT_MODE_PREFIX = "phasePromptMode_";
const REVIEW_PREFIX = "phaseReviewOverride_";
const CONSENSUS_MODE_PREFIX = "phaseConsensusMode_";

// Parse the per-phase override form fields emitted by taskPhaseConfigFragment
// (src/html/pages/task-create.page.ts). Field names carry a sanitized phase name
// (safe = name.replace(/[^a-zA-Z0-9_-]/g, "_")); the runtime resolver
// (orchestrator/phase-config.ts) looks overrides up by the ORIGINAL phase name, so
// we translate via the team's phases. `submitted` reports whether any override
// field was present at all (lets the update route distinguish "cleared" from
// "form didn't include overrides").
export function parsePhaseOverridesFromForm(
  formData: FormData,
  teamId: string | undefined,
): { overrides: Record<string, PhaseOverride>; submitted: boolean } {
  const overrides: Record<string, PhaseOverride> = {};
  let submitted = false;

  const safeToReal: Record<string, string> = {};
  if (teamId) {
    try {
      const row = getDb().prepare("SELECT phases FROM teams WHERE id = ?").get(teamId) as { phases: string } | null;
      if (row?.phases) {
        const phases = JSON.parse(row.phases) as Array<{ name: string }>;
        for (const p of phases) {
          if (p && typeof p.name === "string") safeToReal[p.name.replace(/[^a-zA-Z0-9_-]/g, "_")] = p.name;
        }
      }
    } catch { /* fall back to safe name */ }
  }
  const real = (safe: string): string => safeToReal[safe] ?? safe;
  const upsert = (name: string, patch: PhaseOverride) => { overrides[name] = { ...overrides[name], ...patch }; };

  for (const [key, value] of formData.entries()) {
    if (key.startsWith(PROMPT_MODE_PREFIX) && key.length > PROMPT_MODE_PREFIX.length) {
      submitted = true;
      const safe = key.slice(PROMPT_MODE_PREFIX.length);
      if (value === "override") {
        const promptRaw = formData.get(`phasePromptOverride_${safe}`);
        const prompt = typeof promptRaw === "string" ? promptRaw.trim() : "";
        if (prompt) upsert(real(safe), { prompt });
      }
    } else if (key.startsWith(REVIEW_PREFIX) && key.length > REVIEW_PREFIX.length) {
      submitted = true;
      const val = typeof value === "string" ? value : "";
      if (val === "true") upsert(real(key.slice(REVIEW_PREFIX.length)), { review: true });
      else if (val === "false") upsert(real(key.slice(REVIEW_PREFIX.length)), { review: false });
    } else if (key.startsWith(CONSENSUS_MODE_PREFIX) && key.length > CONSENSUS_MODE_PREFIX.length) {
      submitted = true;
      const safe = key.slice(CONSENSUS_MODE_PREFIX.length);
      const mode = typeof value === "string" ? value : "";
      if (mode === "disabled") {
        upsert(real(safe), { consensus: null });
      } else if (mode === "override") {
        const countRaw = formData.get(`phaseConsensusAgentCount_${safe}`);
        const strategyRaw = formData.get(`phaseConsensusStrategy_${safe}`);
        const worktreeRaw = formData.get(`phaseConsensusWorktree_${safe}`);
        const reviewerRaw = formData.get(`phaseConsensusReviewerAgentId_${safe}`);
        const agent_count = Math.max(1, parseInt(typeof countRaw === "string" ? countRaw : "", 10) || 2);
        const strategy: ConsensusConfig["strategy"] = strategyRaw === "merge" ? "merge" : "best_of";
        const consensus: ConsensusConfig = {
          agent_count,
          strategy,
          worktree: typeof worktreeRaw === "string" && worktreeRaw.length > 0,
        };
        const reviewer = typeof reviewerRaw === "string" ? reviewerRaw.trim() : "";
        if (reviewer) consensus.reviewer_agent_id = reviewer;
        upsert(real(safe), { consensus });
      }
    }
  }

  return { overrides, submitted };
}
