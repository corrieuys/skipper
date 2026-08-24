import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import { getAgentType } from "../config/store";
import { isCustomAgentType } from "../agents/types";
import { normalizeSlashCommand } from "../slack/slash-command";
import {
  SINGLE_AGENT_PREFIX,
  soloProjectedId,
  projectSoloIntoMaps,
  refreshSoloInShared,
  removeSoloFromShared,
  type SoloAgentSpec,
} from "../agents/solo";

// ---------------------------------------------------------------------------
// A single agent is a standalone agent (NOT the root Skipper) that runs a
// regular/recurring task by itself: no delegation, no phases, but full access to
// the other internal tools (notes, artifacts, escalate, complete_task, ...).
//
// It is persisted in the runtime DB and PROJECTED into the shared config layer
// as a "team of one" so the entire team-keyed task pipeline (task-runner,
// recovery, slack, recurring) runs it with no new spawn/lifecycle code:
//   - a shared `agents` row      id = `sa:<id>`, type/model/instruction from the record
//   - a shared `teams` row       id = `sa:<id>`, entrypoint = that agent, NO skipper, phases []
//   - one `team_agents` row       the agent as the level-0 lead
//
// The `sa:` prefix on the projected team/agent id is the single signal every
// downstream consumer uses to recognise a single-agent-backed task (prompt
// variant, restricted tool profile, Slack enablement). A task is "assigned to a
// single agent" by setting its `team_id` to `sa:<id>`.
// ---------------------------------------------------------------------------

/** Prefix stamped on the projected shared team + agent ids (re-exported from the solo module). */
export { SINGLE_AGENT_PREFIX };

/** Projected shared team id for a single agent. */
export function singleAgentTeamId(id: string): string {
  return soloProjectedId(SINGLE_AGENT_PREFIX, id);
}

/** Projected shared agent (entrypoint) id for a single agent. */
export function singleAgentAgentId(id: string): string {
  return soloProjectedId(SINGLE_AGENT_PREFIX, id);
}

/** Whether an id refers specifically to a SINGLE-agent projection (not a custom-agent solo run). */
export function isSingleAgentId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(SINGLE_AGENT_PREFIX);
}

/** Recover the single-agent record id from a projected `sa:<id>` id. */
export function singleAgentIdFromProjected(projectedId: string): string {
  return projectedId.startsWith(SINGLE_AGENT_PREFIX)
    ? projectedId.slice(SINGLE_AGENT_PREFIX.length)
    : projectedId;
}

// ---------------------------------------------------------------------------
// Team-member reference token
//
// A headless CLI agent can also be a MEMBER of a regular team. The member stores
// `type = "single:<id>"`; the team-flatten layer resolves it LIVE from the record
// (provider, model, instruction, capabilities, tools) on every projection, so
// editing the record updates every team that references it. This is deliberately
// a DIFFERENT namespace from the `sa:<id>` SOLO projection id above - solo runs a
// whole team-of-one, a ref is one member inside a real team.
// ---------------------------------------------------------------------------

export const SINGLE_AGENT_REF_PREFIX = "single:";

/** The team-member reference token for a headless CLI agent record. */
export function singleAgentRefType(id: string): string {
  return `${SINGLE_AGENT_REF_PREFIX}${id}`;
}

/** Whether an agent-type string is a headless-CLI-agent reference token. */
export function isSingleAgentRefType(type: string | null | undefined): boolean {
  return !!type && type.startsWith(SINGLE_AGENT_REF_PREFIX);
}

/** Recover the record id from a `single:<id>` reference token. */
export function singleAgentIdFromRefType(type: string): string {
  return type.startsWith(SINGLE_AGENT_REF_PREFIX)
    ? type.slice(SINGLE_AGENT_REF_PREFIX.length)
    : type;
}

/** Per-single-agent settings blob (runtime `single_agents.config` JSON column). */
export interface SingleAgentConfig {
  /** When true, this agent's tasks expose the Slack MCP tools. */
  slackEnabled?: boolean;
  /**
   * Slack slash command bound to this agent (e.g. "/researcher"). When an
   * allowed user invokes it, Skipper creates + auto-approves a task assigned to
   * this single agent. See src/slack/commands.ts.
   */
  slashCommand?: string;
  /** Operator-defined tool names (src/custom-tools) granted to this agent. */
  customTools?: string[];
}

export interface SingleAgent {
  id: string;
  name: string;
  /** Provider agent type (e.g. "claude-code"). */
  agent_type: string;
  model: string;
  /** System prompt / instruction for the agent. */
  instruction: string;
  capabilities: string[];
  config: SingleAgentConfig;
  created_at: string;
  updated_at: string;
}

export interface SingleAgentInput {
  id?: string;
  name: string;
  agent_type: string;
  model?: string;
  instruction?: string;
  capabilities?: string[];
  config?: SingleAgentConfig;
}

// ---------------------------------------------------------------------------
// Row <-> object mapping
// ---------------------------------------------------------------------------

interface SingleAgentRow {
  id: string;
  name: string;
  agent_type: string;
  model: string;
  instruction: string;
  capabilities: string;
  config: string | null;
  created_at: string;
  updated_at: string;
}

function parseCapabilities(raw: string): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

function parseConfig(raw: string | null | undefined): SingleAgentConfig {
  try {
    const v = JSON.parse(raw ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as SingleAgentConfig) : {};
  } catch {
    return {};
  }
}

function rowToSingleAgent(row: SingleAgentRow): SingleAgent {
  return {
    id: row.id,
    name: row.name,
    agent_type: row.agent_type,
    model: row.model || "default",
    instruction: row.instruction ?? "",
    capabilities: parseCapabilities(row.capabilities ?? "[]"),
    config: parseConfig(row.config),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Projection into the shared config layer (via the shared solo helpers)
// ---------------------------------------------------------------------------

/** A single agent as a generic solo-agent projection spec. */
function toSpec(sa: SingleAgent): SoloAgentSpec {
  return {
    prefix: SINGLE_AGENT_PREFIX,
    id: sa.id,
    name: sa.name,
    type: sa.agent_type,
    model: sa.model,
    instruction: sa.instruction,
    capabilities: sa.capabilities,
  };
}

/** Register one single agent into the in-memory store Maps (idempotent). */
export function flattenSingleAgentIntoMaps(sa: SingleAgent): void {
  projectSoloIntoMaps(toSpec(sa));
}

/**
 * Read every single agent and register it into the in-memory store Maps. Call
 * BEFORE loadConfigSnapshotIntoDb at boot so the snapshot that seeds the shared.*
 * tables already includes them.
 */
export function flattenSingleAgentsIntoStore(db: Database): void {
  if (!singleAgentsTableExists(db)) return;
  for (const sa of listSingleAgents(db)) {
    flattenSingleAgentIntoMaps(sa);
  }
}

function nowTs(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/** Upsert one single agent into BOTH the store Maps and the config tables. */
export function refreshSingleAgentInShared(db: Database, id: string): void {
  const sa = getSingleAgent(db, id);
  if (!sa) {
    removeSingleAgentFromShared(db, id);
    return;
  }
  refreshSoloInShared(db, toSpec(sa));
}

/** Remove one single agent from BOTH the store Maps and config tables. */
export function removeSingleAgentFromShared(db: Database, id: string): void {
  removeSoloFromShared(db, SINGLE_AGENT_PREFIX, id);
}

// ---------------------------------------------------------------------------
// Validation + CRUD
// ---------------------------------------------------------------------------

function validateInput(input: SingleAgentInput): void {
  if (!input.name || !input.name.trim()) {
    throw new Error("single agent: name is required");
  }
  if (!input.agent_type || !input.agent_type.trim()) {
    throw new Error("single agent: a provider (agent type) is required");
  }
  // Custom agents are registered into the in-memory agent_types TABLE only, so
  // they are absent from the JSON snapshot getAgentType reads - accept them by
  // their type prefix, like teams do.
  if (!isCustomAgentType(input.agent_type) && !getAgentType(input.agent_type)) {
    throw new Error(`single agent: unknown provider "${input.agent_type}"`);
  }
}

function singleAgentsTableExists(db: Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='single_agents'")
    .get() as { name: string } | null;
  return !!row;
}

export function listSingleAgents(db: Database): SingleAgent[] {
  if (!singleAgentsTableExists(db)) return [];
  const rows = db.prepare("SELECT * FROM single_agents ORDER BY created_at, id").all() as SingleAgentRow[];
  return rows.map(rowToSingleAgent);
}

export function getSingleAgent(db: Database, id: string): SingleAgent | null {
  if (!singleAgentsTableExists(db)) return null;
  const row = db.prepare("SELECT * FROM single_agents WHERE id = ?").get(id) as SingleAgentRow | null;
  return row ? rowToSingleAgent(row) : null;
}

function serializeConfig(config: SingleAgentConfig | undefined): string {
  const c: SingleAgentConfig = { slackEnabled: config?.slackEnabled ?? false };
  if (config?.slashCommand) c.slashCommand = normalizeSlashCommand(config.slashCommand);
  if (config?.customTools && config.customTools.length > 0) c.customTools = config.customTools;
  return JSON.stringify(c);
}

export function createSingleAgent(db: Database, input: SingleAgentInput): SingleAgent {
  validateInput(input);
  const id = input.id?.trim() || randomUUID();
  if (getSingleAgent(db, id)) throw new Error(`single agent: id "${id}" already exists`);
  const ts = nowTs();
  db.prepare(
    `INSERT INTO single_agents (id, name, agent_type, model, instruction, capabilities, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name.trim(),
    input.agent_type.trim(),
    (input.model ?? "default").trim() || "default",
    input.instruction ?? "",
    JSON.stringify(input.capabilities ?? []),
    serializeConfig(input.config),
    ts,
    ts,
  );
  refreshSingleAgentInShared(db, id);
  return getSingleAgent(db, id)!;
}

export function updateSingleAgent(db: Database, id: string, input: SingleAgentInput): SingleAgent {
  if (!getSingleAgent(db, id)) throw new Error(`single agent: id "${id}" not found`);
  validateInput(input);
  const ts = nowTs();
  db.prepare(
    `UPDATE single_agents
        SET name = ?, agent_type = ?, model = ?, instruction = ?, capabilities = ?, config = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    input.name.trim(),
    input.agent_type.trim(),
    (input.model ?? "default").trim() || "default",
    input.instruction ?? "",
    JSON.stringify(input.capabilities ?? []),
    serializeConfig(input.config),
    ts,
    id,
  );
  refreshSingleAgentInShared(db, id);
  return getSingleAgent(db, id)!;
}

export function deleteSingleAgent(db: Database, id: string): boolean {
  if (!getSingleAgent(db, id)) return false;
  db.prepare("DELETE FROM single_agents WHERE id = ?").run(id);
  removeSingleAgentFromShared(db, id);
  return true;
}

// ---------------------------------------------------------------------------
// Slack + task-assignment helpers
// ---------------------------------------------------------------------------

/** The single agent behind a projected `sa:<id>` team id, or null. */
export function getSingleAgentByTeamId(db: Database, teamId: string): SingleAgent | null {
  if (!isSingleAgentId(teamId)) return null;
  return getSingleAgent(db, singleAgentIdFromProjected(teamId));
}

/** Whether a single-agent-backed task exposes the Slack tools. Accepts either the record id or the projected `sa:<id>`. */
export function isSlackEnabledForSingleAgent(db: Database, idOrTeamId: string): boolean {
  const id = isSingleAgentId(idOrTeamId) ? singleAgentIdFromProjected(idOrTeamId) : idOrTeamId;
  return getSingleAgent(db, id)?.config?.slackEnabled === true;
}

/** Find the single agent bound to a Slack slash command, or null. */
export function findSingleAgentBySlashCommand(db: Database, command: string): SingleAgent | null {
  const want = normalizeSlashCommand(command);
  if (!want) return null;
  for (const sa of listSingleAgents(db)) {
    if (normalizeSlashCommand(sa.config?.slashCommand) === want) return sa;
  }
  return null;
}
