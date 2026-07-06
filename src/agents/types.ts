import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";

export interface AgentTypeDefinition {
  name: string;
  command: string;
  args: string[];
  resume_args: string[] | null;
  model_flag: string | null;
  available_models: string[];
  env_vars: Record<string, string>;
  supports_stdin: boolean;
  supports_resume: boolean;
  resume_flag: string | null;
}

// Token/usage tracking parses provider-specific stdout frame shapes. Claude Code's
// assistant `usage` blocks and `task_progress` sub-agent frames look nothing like
// codex's `turn.completed` or opencode's `step_finish`, and each provider surfaces
// (or omits) different fields. Rather than half-support formats we can't verify,
// usage tracking is allowlisted per provider. Only claude-code is supported for now;
// add a provider here once its usage frames are parsed and tested.
export const USAGE_TRACKING_PROVIDERS = new Set<string>(["claude-code"]);

export function providerSupportsUsageTracking(agentType: string | null | undefined): boolean {
  return !!agentType && USAGE_TRACKING_PROVIDERS.has(agentType);
}

export function agentTypeUsesInlinePrompt(
  typeDef: Pick<AgentTypeDefinition, "args" | "resume_args" | "supports_resume">,
  sessionId?: string | null,
): boolean {
  const activeArgs = sessionId && typeDef.supports_resume && typeDef.resume_args
    ? typeDef.resume_args
    : typeDef.args;
  return activeArgs.includes("{{prompt}}");
}

interface AgentTypeRow {
  name: string;
  command: string;
  args: string;
  resume_args: string | null;
  model_flag: string | null;
  available_models: string;
  env_vars: string;
  supports_stdin: number;
  supports_resume: number;
  resume_flag: string | null;
}

const cache = new Map<string, AgentTypeDefinition>();

function rowToDefinition(row: AgentTypeRow): AgentTypeDefinition {
  return {
    name: row.name,
    command: row.command,
    args: JSON.parse(row.args),
    resume_args: row.resume_args ? JSON.parse(row.resume_args) : null,
    model_flag: row.model_flag,
    available_models: JSON.parse(row.available_models),
    env_vars: JSON.parse(row.env_vars),
    supports_stdin: row.supports_stdin === 1,
    supports_resume: row.supports_resume === 1,
    resume_flag: row.resume_flag,
  };
}

export function getAgentTypeDefinition(
  typeName: string,
  db?: Database,
): AgentTypeDefinition | null {
  const cached = cache.get(typeName);
  if (cached) return cached;

  const database = db ?? getDb();
  const row = database
    .prepare("SELECT * FROM agent_types WHERE name = ?")
    .get(typeName) as AgentTypeRow | null;

  if (!row) return null;

  const definition = rowToDefinition(row);
  cache.set(typeName, definition);
  return definition;
}

export function listAgentTypes(db?: Database): AgentTypeDefinition[] {
  const database = db ?? getDb();
  const rows = database
    .prepare("SELECT * FROM agent_types ORDER BY name")
    .all() as AgentTypeRow[];

  const definitions = rows.map(rowToDefinition);
  for (const def of definitions) {
    cache.set(def.name, def);
  }
  return definitions;
}

export function clearAgentTypeCache(): void {
  cache.clear();
}
