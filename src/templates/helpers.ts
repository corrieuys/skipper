import type { Database } from "bun:sqlite";
import type { Phase, ConsensusConfig } from "../teams/manager";
import type { HookDefinition } from "../hooks/types";

export function getTaskTemplateId(taskConfig: unknown): string | undefined {
  if (!taskConfig || typeof taskConfig !== "object") return undefined;
  const id = (taskConfig as Record<string, unknown>).template_id;
  return typeof id === "string" ? id : undefined;
}

export function getTaskHooks(taskConfig: unknown): HookDefinition[] {
  if (!taskConfig || typeof taskConfig !== "object") return [];
  const hooks = (taskConfig as Record<string, unknown>).hooks;
  return Array.isArray(hooks) ? hooks as HookDefinition[] : [];
}

export function getTemplateSkipperPrompt(db: Database, templateId: string | undefined): string | null {
  if (!templateId) return null;
  const row = db
    .prepare("SELECT skipper_prompt FROM task_templates WHERE id = ? AND deleted_at IS NULL")
    .get(templateId) as { skipper_prompt: string } | null;
  return row?.skipper_prompt?.trim() || null;
}

export function getTemplatePhasePrompt(
  db: Database,
  templateId: string | undefined,
  phaseName: string,
): string | null {
  if (!templateId) return null;
  const row = db
    .prepare(
      `SELECT ttp.prompt FROM task_template_phases ttp
       JOIN task_templates tt ON tt.id = ttp.task_template_id
       WHERE ttp.task_template_id = ? AND ttp.phase_name = ? AND tt.deleted_at IS NULL`,
    )
    .get(templateId, phaseName) as { prompt: string } | null;
  return row?.prompt?.trim() || null;
}

export interface TemplatePhaseOverrides {
  prompt: string | null;
  override_prompt: boolean;
  review_override: boolean | null;
  consensus_override: ConsensusConfig | null | undefined; // undefined = no override, null = disable
}

export interface ResolvedPhaseConfig {
  name: string;
  prompt: string;
  review: boolean;
  consensus: ConsensusConfig | null;
}

interface TemplatePhaseDbRow {
  prompt: string;
  override_prompt: number;
  review_override: string | null;
  consensus_override: string | null;
}

export function getTemplatePhaseOverrides(
  db: Database,
  templateId: string | undefined,
  phaseName: string,
): TemplatePhaseOverrides | null {
  if (!templateId) return null;
  const row = db
    .prepare(
      `SELECT ttp.prompt, ttp.override_prompt, ttp.review_override, ttp.consensus_override
       FROM task_template_phases ttp
       JOIN task_templates tt ON tt.id = ttp.task_template_id
       WHERE ttp.task_template_id = ? AND ttp.phase_name = ? AND tt.deleted_at IS NULL`,
    )
    .get(templateId, phaseName) as TemplatePhaseDbRow | null;

  if (!row) return null;

  let review_override: boolean | null = null;
  if (row.review_override !== null) {
    try { review_override = JSON.parse(row.review_override) as boolean; } catch { /* ignore */ }
  }

  let consensus_override: ConsensusConfig | null | undefined = undefined;
  if (row.consensus_override !== null) {
    try {
      const parsed = JSON.parse(row.consensus_override) as Record<string, unknown>;
      consensus_override = parsed?.disabled === true ? null : (parsed as unknown as ConsensusConfig);
    } catch { /* ignore */ }
  }

  return {
    prompt: row.prompt?.trim() || null,
    override_prompt: row.override_prompt === 1,
    review_override,
    consensus_override,
  };
}

export function resolvePhaseConfig(
  db: Database,
  teamPhase: Phase,
  templateId: string | undefined,
  taskConfig: Record<string, unknown> | undefined,
): ResolvedPhaseConfig {
  const templateOverrides = getTemplatePhaseOverrides(db, templateId, teamPhase.name);

  // Resolve prompt: override_prompt=1 replaces base, otherwise appends
  let prompt: string;
  if (templateOverrides?.prompt && templateOverrides.override_prompt) {
    prompt = templateOverrides.prompt;
  } else if (templateOverrides?.prompt) {
    prompt = `${teamPhase.prompt}\n\n${templateOverrides.prompt}`;
  } else {
    prompt = teamPhase.prompt;
  }

  // Resolve review: team base < template override < task override
  let review: boolean = teamPhase.review ?? false;
  if (templateOverrides?.review_override !== null && templateOverrides?.review_override !== undefined) {
    review = templateOverrides.review_override;
  }
  const phaseOverrides = taskConfig?.phase_overrides as Record<string, { review?: boolean; consensus?: ConsensusConfig | null }> | undefined;
  const taskPhaseOverride = phaseOverrides?.[teamPhase.name];
  if (taskPhaseOverride?.review !== undefined) {
    review = taskPhaseOverride.review;
  }

  // Resolve consensus: team base < template override < task override
  let consensus: ConsensusConfig | null = teamPhase.consensus ?? null;
  if (templateOverrides !== null && templateOverrides.consensus_override !== undefined) {
    consensus = templateOverrides.consensus_override;
  }
  if (taskPhaseOverride !== undefined && "consensus" in taskPhaseOverride) {
    consensus = taskPhaseOverride.consensus ?? null;
  }

  return { name: teamPhase.name, prompt, review, consensus };
}
