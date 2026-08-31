import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { clearAgentTypeCache, CUSTOM_TYPE_PREFIX, isCustomAgentType } from "../agents/types";
import { isCreatureId, sanitizeColor } from "../html/atoms/creature";
import {
  CUSTOM_AGENT_SOLO_PREFIX,
  soloProjectedId,
  upsertSoloIntoSharedTables,
  removeSoloFromShared,
  type SoloAgentSpec,
} from "../agents/solo";

export { CUSTOM_TYPE_PREFIX, isCustomAgentType };

/** Projected `ca:<id>` team/agent id for running this custom agent SOLO on a task. */
export function customAgentSoloTeamId(id: string): string {
  return soloProjectedId(CUSTOM_AGENT_SOLO_PREFIX, id);
}

/**
 * A custom agent as a generic solo-agent projection spec. Its own system prompt
 * is supplied by the in-process runner (buildSystemPrompt), so `instruction`
 * stays empty here - the prompt-builder adds only the solo framing on top.
 */
function toSoloSpec(agent: CustomAgent): SoloAgentSpec {
  return {
    prefix: CUSTOM_AGENT_SOLO_PREFIX,
    id: agent.id,
    name: agent.name,
    type: customAgentTypeName(agent.id),
    model: agent.modelId,
    instruction: "",
    capabilities: [],
    color: agent.color ?? null,
    character: agent.character ?? null,
  };
}

/**
 * Project every custom agent as a `ca:<id>` team-of-one so it can be assigned to
 * run a task SOLO (entrypoint = the custom agent, no Skipper, no phases).
 *
 * Writes the shared config TABLES directly, NOT the in-memory config-store Maps.
 * The runtime resolves the entrypoint from the tables (`AgentManager.getAgent`,
 * `TeamManager.getTeamForExecution`), and a custom agent's `custom:<id>` type is
 * DB-local, so seeding it into the global Maps (which reseed every attached DB)
 * would break sibling databases with a missing-type FK. Call AFTER
 * registerCustomAgentTypes so the `custom:<id>` agent_types row exists.
 */
export function flattenCustomAgentsAsSoloTeams(db: Database): void {
  for (const agent of listCustomAgents(db)) {
    try {
      upsertSoloIntoSharedTables(db, toSoloSpec(agent));
    } catch {
      /* shared tables not ready yet */
    }
  }
}

/** Re-project one custom agent's solo team into the config tables (after a mutation). */
function refreshCustomAgentSolo(db: Database, id: string): void {
  const agent = getCustomAgent(db, id);
  if (!agent) {
    removeSoloFromShared(db, CUSTOM_AGENT_SOLO_PREFIX, id);
    return;
  }
  try {
    upsertSoloIntoSharedTables(db, toSoloSpec(agent));
  } catch {
    /* shared tables not ready */
  }
}

/**
 * A custom agent definition. Everything Skipper needs to build and run an agent
 * inside its own process: where to call, how to authenticate, what to say, and
 * exactly which tools it is allowed to see.
 */
export interface CustomAgent {
  id: string;
  name: string;
  description: string;
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 — no /chat/completions. */
  baseUrl: string;
  modelId: string;
  /** Literal key or a ${ENV_VAR} reference; resolved at run time, never at save time. */
  apiKey: string;
  headers: Record<string, string>;
  /** Appended to every request URL. Azure OpenAI needs `api-version` here. */
  queryParams: Record<string, string>;
  systemPrompt: string;
  /** Local tool ids from `tools/registry.ts`. */
  enabledTools: string[];
  /** Skipper MCP tool names, e.g. "create_note". */
  enabledMcpTools: string[];
  /** Registered-server tools, as `<slug>__<tool>` (see `servers.ts`). */
  enabledServerTools: string[];
  /** Operator-defined tool names this agent always has (see `../custom-tools`). */
  enabledCustomTools: string[];
  /** Skill names from `config-readers/skills.ts`. */
  enabledSkills: string[];
  maxSteps: number;
  temperature: number | null;
  /** Chosen identity color (hex) — tints the orb + this agent's timeline output. */
  color: string | null;
  /** Chosen creature character id (null = cube fallback). */
  character: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CustomAgentInput = Omit<CustomAgent, "id" | "createdAt" | "updatedAt"> & { id?: string };

/**
 * Agent-type name for a definition. The prefix is the discriminator every other
 * module uses to tell a custom agent from a vendor CLI, so it must never appear
 * in a seeded `agent_types` row.
 */
export function customAgentTypeName(id: string): string {
  return `${CUSTOM_TYPE_PREFIX}${id}`;
}

export function customAgentIdFromType(typeName: string): string {
  return typeName.slice(CUSTOM_TYPE_PREFIX.length);
}

/** Upper bound on agent turns, so a looping model cannot burn a budget unattended. */
export const MAX_STEPS_LIMIT = 200;
const DEFAULT_MAX_STEPS = 40;

interface CustomAgentRow {
  id: string;
  name: string;
  description: string;
  base_url: string;
  model_id: string;
  api_key: string;
  headers: string;
  query_params: string;
  system_prompt: string;
  enabled_tools: string;
  enabled_mcp_tools: string;
  enabled_server_tools: string;
  enabled_custom_tools: string;
  enabled_skills: string;
  max_steps: number;
  temperature: number | null;
  color: string | null;
  character: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

function rowToAgent(row: CustomAgentRow): CustomAgent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    baseUrl: row.base_url,
    modelId: row.model_id,
    apiKey: row.api_key,
    headers: parseJson<Record<string, string>>(row.headers, {}),
    queryParams: parseJson<Record<string, string>>(row.query_params, {}),
    systemPrompt: row.system_prompt,
    enabledTools: parseJson<string[]>(row.enabled_tools, []),
    enabledMcpTools: parseJson<string[]>(row.enabled_mcp_tools, []),
    enabledServerTools: parseJson<string[]>(row.enabled_server_tools, []),
    enabledCustomTools: parseJson<string[]>(row.enabled_custom_tools, []),
    enabledSkills: parseJson<string[]>(row.enabled_skills, []),
    maxSteps: row.max_steps,
    temperature: row.temperature,
    color: row.color ?? null,
    character: row.character ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listCustomAgents(db: Database): CustomAgent[] {
  const rows = db
    .prepare("SELECT * FROM custom_agents ORDER BY name COLLATE NOCASE")
    .all() as CustomAgentRow[];
  return rows.map(rowToAgent);
}

export function getCustomAgent(db: Database, id: string): CustomAgent | null {
  const row = db.prepare("SELECT * FROM custom_agents WHERE id = ?").get(id) as CustomAgentRow | null;
  return row ? rowToAgent(row) : null;
}

/** Definition behind an agent-type name, or null when the name is not a custom type. */
export function getCustomAgentByType(db: Database, typeName: string): CustomAgent | null {
  if (!isCustomAgentType(typeName)) return null;
  return getCustomAgent(db, customAgentIdFromType(typeName));
}

/**
 * Validate + normalize a definition. Throws with an operator-readable message —
 * the routes surface it directly, so a bad base URL is caught at save time rather
 * than halfway through a task.
 */
export function normalizeCustomAgentInput(input: CustomAgentInput): CustomAgentInput {
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("Name is required");

  const baseUrl = (input.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Base URL is required");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Base URL is not a valid URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL must be http or https");
  }
  // The AI SDK appends /chat/completions itself. Saving the full path produces a
  // 404 at run time that reads like an auth problem, so reject it here.
  if (/\/chat\/completions$/.test(parsed.pathname)) {
    throw new Error("Base URL must be the API root (e.g. https://api.openai.com/v1), not the /chat/completions path");
  }

  const modelId = (input.modelId ?? "").trim();
  if (!modelId) throw new Error("Model is required");

  const pairs = (raw: Record<string, string> | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw ?? {})) {
      const k = key.trim();
      if (!k) continue;
      out[k] = String(value ?? "");
    }
    return out;
  };
  const headers = pairs(input.headers);
  const queryParams = pairs(input.queryParams);

  const maxSteps = Number.isFinite(input.maxSteps) ? Math.trunc(input.maxSteps) : DEFAULT_MAX_STEPS;
  if (maxSteps < 1 || maxSteps > MAX_STEPS_LIMIT) {
    throw new Error(`Max steps must be between 1 and ${MAX_STEPS_LIMIT}`);
  }

  const temperature = input.temperature === null || input.temperature === undefined
    ? null
    : Number(input.temperature);
  if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new Error("Temperature must be between 0 and 2");
  }

  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];

  return {
    ...(input.id ? { id: input.id } : {}),
    name,
    description: (input.description ?? "").trim(),
    baseUrl,
    modelId,
    apiKey: (input.apiKey ?? "").trim(),
    headers,
    queryParams,
    systemPrompt: input.systemPrompt ?? "",
    enabledTools: strings(input.enabledTools),
    enabledMcpTools: strings(input.enabledMcpTools),
    enabledServerTools: strings(input.enabledServerTools),
    enabledCustomTools: strings(input.enabledCustomTools),
    enabledSkills: strings(input.enabledSkills),
    maxSteps,
    temperature,
    color: input.color ? sanitizeColor(input.color) : null,
    character: isCreatureId(input.character) ? input.character : null,
  };
}

export function createCustomAgent(db: Database, input: CustomAgentInput): CustomAgent {
  const normalized = normalizeCustomAgentInput(input);
  const id = normalized.id?.trim() || randomUUID();
  db.prepare(
    `INSERT INTO custom_agents (
       id, name, description, base_url, model_id, api_key, headers, query_params, system_prompt,
       enabled_tools, enabled_mcp_tools, enabled_server_tools, enabled_custom_tools,
       enabled_skills, max_steps, temperature, color, character
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    normalized.name,
    normalized.description,
    normalized.baseUrl,
    normalized.modelId,
    normalized.apiKey,
    JSON.stringify(normalized.headers),
    JSON.stringify(normalized.queryParams),
    normalized.systemPrompt,
    JSON.stringify(normalized.enabledTools),
    JSON.stringify(normalized.enabledMcpTools),
    JSON.stringify(normalized.enabledServerTools),
    JSON.stringify(normalized.enabledCustomTools),
    JSON.stringify(normalized.enabledSkills),
    normalized.maxSteps,
    normalized.temperature,
    normalized.color,
    normalized.character,
  );
  registerCustomAgentTypes(db);
  refreshCustomAgentSolo(db, id);
  return getCustomAgent(db, id)!;
}

/**
 * Update in place. An empty `apiKey` keeps the stored one — the config form
 * renders secrets masked, so a save that never touched the field must not wipe
 * it (same contract as the Slack bot token).
 */
export function updateCustomAgent(db: Database, id: string, input: CustomAgentInput): CustomAgent {
  const existing = getCustomAgent(db, id);
  if (!existing) throw new Error(`Custom agent not found: ${id}`);
  const normalized = normalizeCustomAgentInput(input);
  const apiKey = normalized.apiKey || existing.apiKey;
  const headers = { ...normalized.headers };
  for (const [key, value] of Object.entries(headers)) {
    if (value === "") headers[key] = existing.headers[key] ?? "";
  }

  db.prepare(
    `UPDATE custom_agents SET
       name = ?, description = ?, base_url = ?, model_id = ?, api_key = ?, headers = ?,
       query_params = ?, system_prompt = ?, enabled_tools = ?, enabled_mcp_tools = ?,
       enabled_server_tools = ?, enabled_custom_tools = ?, enabled_skills = ?,
       max_steps = ?, temperature = ?, color = ?, character = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    normalized.name,
    normalized.description,
    normalized.baseUrl,
    normalized.modelId,
    apiKey,
    JSON.stringify(headers),
    JSON.stringify(normalized.queryParams),
    normalized.systemPrompt,
    JSON.stringify(normalized.enabledTools),
    JSON.stringify(normalized.enabledMcpTools),
    JSON.stringify(normalized.enabledServerTools),
    JSON.stringify(normalized.enabledCustomTools),
    JSON.stringify(normalized.enabledSkills),
    normalized.maxSteps,
    normalized.temperature,
    normalized.color,
    normalized.character,
    id,
  );
  registerCustomAgentTypes(db);
  refreshCustomAgentSolo(db, id);
  return getCustomAgent(db, id)!;
}

export function deleteCustomAgent(db: Database, id: string): boolean {
  const res = db.prepare("DELETE FROM custom_agents WHERE id = ?").run(id);
  db.prepare("DELETE FROM agent_types WHERE name = ?").run(customAgentTypeName(id));
  removeSoloFromShared(db, CUSTOM_AGENT_SOLO_PREFIX, id);
  clearAgentTypeCache();
  return res.changes > 0;
}

/**
 * Interpolate `${ENV_VAR}` references against the daemon's environment.
 *
 * The point is that an operator can keep the real secret out of the database
 * entirely and still configure the agent through the UI. A reference to a var
 * that is not set resolves to an empty string rather than throwing: the request
 * then fails with the provider's own 401, which is a clearer signal than a
 * spawn-time crash with no task context.
 */
export function resolveSecret(raw: string, env: Record<string, string | undefined> = process.env): string {
  return (raw ?? "").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? "");
}

export function resolveHeaders(
  headers: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key] = resolveSecret(value, env);
  return out;
}

/**
 * Mirror every definition into the in-memory `agent_types` table so custom
 * agents show up wherever a provider is selectable and `getAgentTypeDefinition`
 * resolves them like any other type.
 *
 * These rows are deliberately transient. `config/store.ts` seeds the shared
 * config tables FROM `config/*.json` and never writes them back, so nothing
 * registered here reaches disk and no API key can leak into a committed
 * snapshot. Call after any mutation; the boot path calls it once.
 *
 * The command is empty and stdin is off: `AgentManager` branches on
 * `isCustomAgentType` before it would ever build an argv. `supports_resume` is on
 * so the orchestrator threads a session id through, which is what keys the
 * conversation history in `custom_agent_messages`.
 */
export function registerCustomAgentTypes(db: Database): number {
  const agents = listCustomAgents(db);
  const known = new Set(agents.map((a) => customAgentTypeName(a.id)));

  const stale = db
    .prepare("SELECT name FROM agent_types WHERE name LIKE ?")
    .all(`${CUSTOM_TYPE_PREFIX}%`) as Array<{ name: string }>;
  for (const row of stale) {
    if (!known.has(row.name)) db.prepare("DELETE FROM agent_types WHERE name = ?").run(row.name);
  }

  const upsert = db.prepare(
    `INSERT INTO agent_types (name, command, args, resume_args, model_flag, available_models, env_vars, supports_stdin, supports_resume, resume_flag)
     VALUES (?, '', '[]', NULL, NULL, ?, '{}', 0, 1, NULL)
     ON CONFLICT(name) DO UPDATE SET available_models = excluded.available_models`,
  );
  for (const agent of agents) {
    upsert.run(customAgentTypeName(agent.id), JSON.stringify([agent.modelId]));
  }

  clearAgentTypeCache();
  return agents.length;
}

/**
 * Register placeholder `agent_types` rows for custom types that are referenced
 * but have no definition behind them.
 *
 * `agents.type` is a foreign key onto `agent_types`, and a team keeps referencing
 * a custom agent after its definition is deleted (or on a machine that never had
 * it — an imported team). Without a row the config snapshot fails to load and the
 * daemon does not boot at all. A stub keeps boot working and defers the problem
 * to that one agent's spawn, which already fails cleanly with
 * "custom agent type has no definition".
 */
export function ensureCustomAgentTypeStubs(db: Database, referencedTypes: Iterable<string>): string[] {
  const stubbed: string[] = [];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO agent_types (name, command, args, resume_args, model_flag, available_models, env_vars, supports_stdin, supports_resume, resume_flag)
     VALUES (?, '', '[]', NULL, NULL, '[]', '{}', 0, 1, NULL)`,
  );
  for (const type of referencedTypes) {
    if (!isCustomAgentType(type)) continue;
    const exists = db.prepare("SELECT 1 FROM agent_types WHERE name = ?").get(type);
    if (exists) continue;
    insert.run(type);
    stubbed.push(type);
  }
  if (stubbed.length > 0) clearAgentTypeCache();
  return stubbed;
}

/** Display label for a custom agent type, for UI that only has the type name. */
export function customAgentLabel(db: Database, typeName: string): string {
  const agent = getCustomAgentByType(db, typeName);
  return agent ? agent.name : typeName;
}
