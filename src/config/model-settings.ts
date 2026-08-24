import type { Database } from "bun:sqlite";
import { getStringSetting, setStringSetting } from "./app-settings";
import { listAgentTypes } from "./store";
import { isExperimental } from "./feature-flags";
import { getSkipperConfig } from "../agents/skipper";

/**
 * Machine-scoped provider + model overrides for the first-class agents the
 * operator cares about: the root Skipper orchestrator and the Greg heckler bot.
 *
 * These live in `app_settings` (the on-disk `skipper-runtime.db`), NOT in the
 * SHARED config tables (`skipper_config` / `agents`) which are seeded from — and
 * re-seeded on restart from — the committed `config/*.json`. Storing them here
 * keeps the choice per-machine and out of version control.
 *
 * Semantics: an empty override means "use the shipped default source" (Skipper's
 * `skipper_config`, Greg's built-in Haiku). A set override wins at spawn time.
 * "Provider" is the app's agent-type concept.
 */

export const SETTING_SKIPPER_AGENT_TYPE = "skipper_agent_type";
export const SETTING_SKIPPER_MODEL = "skipper_model";
export const SETTING_GREG_AGENT_TYPE = "greg_agent_type";
export const SETTING_GREG_MODEL = "greg_model";
export const SETTING_DICTATION_AGENT_TYPE = "dictation_agent_type";
export const SETTING_DICTATION_MODEL = "dictation_model";
export const SETTING_TASK_TITLE_AGENT_TYPE = "task_title_agent_type";
export const SETTING_TASK_TITLE_MODEL = "task_title_model";

export interface ModelChoice {
  agent_type: string;
  model: string;
}

/** Greg's shipped default: the plain `claude` CLI on Haiku (see monkey/brain.ts). */
export const GREG_DEFAULT: ModelChoice = { agent_type: "claude-code", model: "claude-haiku-4-5" };

/** Dictation rewriter default: fast + cheap, same reasoning as Greg's. */
export const DICTATION_DEFAULT: ModelChoice = { agent_type: "claude-code", model: "claude-haiku-4-5" };

export interface AgentTypeOption {
  name: string;
  model_flag: string | null;
  /** "default" is always offered first so the operator can defer to the CLI's own default. */
  models: string[];
}

// The providers offered anywhere a model provider is selectable. An allowlist so
// it's one place to widen; the empty "custom" placeholder stays hidden.
export const PROVIDER_ALLOWLIST = ["claude-code"] as const;

// Providers still proving themselves; selectable only when the experimental
// feature flag is on.
const EXPERIMENTAL_PROVIDERS = ["codex", "opencode", "grok"] as const;

export function isAllowedProvider(name: string): boolean {
  if ((PROVIDER_ALLOWLIST as readonly string[]).includes(name)) return true;
  return isExperimental() && (EXPERIMENTAL_PROVIDERS as readonly string[]).includes(name);
}

/** Selectable providers + their known models, for the config-page controls. */
export function listModelOptions(): AgentTypeOption[] {
  return listAgentTypes()
    .filter((t) => isAllowedProvider(t.name))
    .map((t) => ({
      name: t.name,
      model_flag: t.model_flag,
      models: ["default", ...t.available_models.filter((m) => m !== "default")],
    }));
}

function skipperDefault(db: Database): ModelChoice {
  const cfg = getSkipperConfig(db);
  return { agent_type: cfg.agent_type, model: cfg.model };
}

/**
 * A stored override, or undefined when unset. Kept separate from the effective
 * value so spawn code can tell "operator picked this" from "fall back to the
 * committed default".
 */
export function getSkipperModelOverride(db: Database): Partial<ModelChoice> {
  const agent_type = getStringSetting(db, SETTING_SKIPPER_AGENT_TYPE, "");
  const model = getStringSetting(db, SETTING_SKIPPER_MODEL, "");
  return { agent_type: agent_type || undefined, model: model || undefined };
}

/** Greg always resolves to a concrete choice (override wins, else the built-in). */
export function getGregModelChoice(db: Database): ModelChoice {
  return {
    agent_type: getStringSetting(db, SETTING_GREG_AGENT_TYPE, "") || GREG_DEFAULT.agent_type,
    model: getStringSetting(db, SETTING_GREG_MODEL, "") || GREG_DEFAULT.model,
  };
}

/** Dictation rewriter, same override-or-default shape as Greg. */
export function getDictationModelChoice(db: Database): ModelChoice {
  return {
    agent_type: getStringSetting(db, SETTING_DICTATION_AGENT_TYPE, "") || DICTATION_DEFAULT.agent_type,
    model: getStringSetting(db, SETTING_DICTATION_MODEL, "") || DICTATION_DEFAULT.model,
  };
}

/**
 * Task-title generator override, or undefined when unset. Unlike Greg/dictation
 * there is NO built-in default: the operator must pick a provider before a blank
 * title is generated. "Unset" (undefined agent_type) is the signal the create
 * guards use to keep the title required. Mirrors Skipper's override shape.
 */
export function getTaskTitleModelOverride(db: Database): Partial<ModelChoice> {
  const agent_type = getStringSetting(db, SETTING_TASK_TITLE_AGENT_TYPE, "");
  const model = getStringSetting(db, SETTING_TASK_TITLE_MODEL, "");
  return { agent_type: agent_type || undefined, model: model || undefined };
}

/**
 * Whether a title generator is configured. When false, a blank task title is
 * rejected on every create path (the title stays required); when true, a blank
 * title is accepted and generated by the daemon.
 */
export function isTaskTitleGeneratorConfigured(db: Database): boolean {
  return !!getTaskTitleModelOverride(db).agent_type;
}

/** Effective (override-or-default) choices for all subsystems, for the config UI. */
export function getModelSettingsView(db: Database): {
  skipper: ModelChoice;
  greg: ModelChoice;
  dictation: ModelChoice;
  task_title: Partial<ModelChoice>;
  options: AgentTypeOption[];
} {
  const skOverride = getSkipperModelOverride(db);
  const skDefault = skipperDefault(db);
  return {
    skipper: {
      agent_type: skOverride.agent_type ?? skDefault.agent_type,
      model: skOverride.model ?? skDefault.model,
    },
    greg: getGregModelChoice(db),
    dictation: getDictationModelChoice(db),
    task_title: getTaskTitleModelOverride(db),
    options: listModelOptions(),
  };
}

const VALID_KEYS = {
  skipper: [SETTING_SKIPPER_AGENT_TYPE, SETTING_SKIPPER_MODEL],
  greg: [SETTING_GREG_AGENT_TYPE, SETTING_GREG_MODEL],
  dictation: [SETTING_DICTATION_AGENT_TYPE, SETTING_DICTATION_MODEL],
  task_title: [SETTING_TASK_TITLE_AGENT_TYPE, SETTING_TASK_TITLE_MODEL],
} as const;

/**
 * Persist one subsystem's provider + model. Validates the type exists and the
 * model belongs to it (or is "default"). Returns an error string on rejection.
 */
export function saveModelSetting(
  db: Database,
  target: "skipper" | "greg" | "dictation" | "task_title",
  agentType: string,
  model: string,
): string | null {
  const [typeKey, modelKey] = VALID_KEYS[target];
  // task_title alone is clearable: an empty provider unsets it (title stays
  // required). The other targets always resolve to a concrete provider.
  if (target === "task_title" && !agentType.trim()) {
    setStringSetting(db, typeKey, "");
    setStringSetting(db, modelKey, "");
    return null;
  }
  const opt = listModelOptions().find((o) => o.name === agentType);
  if (!opt) return `Unknown provider: ${agentType}`;
  // Model is free text — the operator may enter any model string the CLI accepts,
  // including ones we don't know about. Empty falls back to the CLI default.
  const resolvedModel = model.trim() || "default";
  setStringSetting(db, typeKey, agentType);
  setStringSetting(db, modelKey, resolvedModel);
  return null;
}
