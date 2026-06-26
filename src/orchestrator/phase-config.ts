import type { Phase, ConsensusConfig } from "../teams/manager";

export interface ResolvedPhaseConfig {
  name: string;
  prompt: string;
  review: boolean;
  consensus: ConsensusConfig | null;
}

// Resolve a team's base phase against any per-task overrides stored in
// task_config.phase_overrides. Task overrides (prompt + review gate + consensus)
// win over the team's base setting.
export function resolvePhaseConfig(
  teamPhase: Phase,
  taskConfig: Record<string, unknown> | undefined,
): ResolvedPhaseConfig {
  const phaseOverrides = taskConfig?.phase_overrides as
    | Record<string, { prompt?: string; review?: boolean; consensus?: ConsensusConfig | null }>
    | undefined;
  const taskPhaseOverride = phaseOverrides?.[teamPhase.name];

  let prompt = teamPhase.prompt;
  if (typeof taskPhaseOverride?.prompt === "string" && taskPhaseOverride.prompt.trim().length > 0) {
    prompt = taskPhaseOverride.prompt;
  }

  let review = teamPhase.review ?? false;
  if (taskPhaseOverride?.review !== undefined) {
    review = taskPhaseOverride.review;
  }

  let consensus: ConsensusConfig | null = teamPhase.consensus ?? null;
  if (taskPhaseOverride !== undefined && "consensus" in taskPhaseOverride) {
    consensus = taskPhaseOverride.consensus ?? null;
  }

  return { name: teamPhase.name, prompt, review, consensus };
}
