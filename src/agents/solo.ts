import type { Database } from "bun:sqlite";
import {
  type AgentDefinition,
  type TeamDefinition,
  setAgent,
  setTeam,
  removeAgent,
  removeTeam,
} from "../config/store";
import { registerVisibleLocalTeam, unregisterVisibleLocalTeam } from "../config/feature-flags";

// ---------------------------------------------------------------------------
// Solo run context.
//
// "Solo" is a RUN CONTEXT, not an agent definition: an operator-defined agent
// (a single agent, or a custom agent) can be assigned to run one task ALONE -
// no delegation, no phases, but owning the task end to end (complete_task) with
// the internal tools. To run any agent solo we PROJECT it into the shared config
// layer as a team-of-one whose entrypoint is the agent itself, with NO Skipper
// lead and no phases, so the whole team-keyed pipeline runs it unchanged.
//
// The projected team + agent share an id carrying a prefix that marks the solo
// context. That prefix is the single signal every consumer keys on (prompt
// variant, restricted tool profile, iterate-resume, sidebar grouping):
//   - `sa:<id>`  a single agent run solo   (src/single-agents)
//   - `ca:<id>`  a custom agent run solo   (src/custom-agents)
// A team member (a custom agent inside a real team) is namespaced differently
// (`<teamId>:<authorId>`) and is NOT solo.
// ---------------------------------------------------------------------------

export const SINGLE_AGENT_PREFIX = "sa:";
export const CUSTOM_AGENT_SOLO_PREFIX = "ca:";
const SOLO_PREFIXES = [SINGLE_AGENT_PREFIX, CUSTOM_AGENT_SOLO_PREFIX] as const;

/** Whether a team id refers to a solo projection (single agent OR custom agent run solo). */
export function isSoloTeamId(id: string | null | undefined): boolean {
  return !!id && SOLO_PREFIXES.some((p) => id.startsWith(p));
}

/** Whether an agent (entrypoint) id refers to a solo projection. Same prefix scheme as the team. */
export function isSoloAgentId(id: string | null | undefined): boolean {
  return isSoloTeamId(id);
}

/** The projected shared team + agent id for a solo run: `<prefix><id>`. */
export function soloProjectedId(prefix: string, id: string): string {
  return `${prefix}${id}`;
}

/**
 * One solo agent to project. `type`/`model`/`instruction`/`capabilities` describe
 * the entrypoint agent; `instruction` may be empty when the underlying runner
 * supplies the agent's own system prompt (custom agents do — see runner.ts).
 */
export interface SoloAgentSpec {
  prefix: string;
  id: string;
  name: string;
  type: string;
  model: string;
  instruction?: string;
  capabilities?: string[];
}

function toSharedAgent(spec: SoloAgentSpec): AgentDefinition {
  return {
    id: soloProjectedId(spec.prefix, spec.id),
    name: spec.name,
    type: spec.type,
    model: spec.model || "default",
    instruction: spec.instruction ?? "",
    capabilities: spec.capabilities ?? [],
  };
}

function toSharedTeam(spec: SoloAgentSpec): TeamDefinition {
  const agentId = soloProjectedId(spec.prefix, spec.id);
  return {
    id: agentId,
    name: spec.name,
    goal: null,
    entrypoint_agent_id: agentId,
    phases: [],
    members: [{ agent_id: agentId, role: "lead", level: 0 }],
  };
}

/** Register one solo agent into the in-memory store Maps (idempotent). */
export function projectSoloIntoMaps(spec: SoloAgentSpec): void {
  setAgent(toSharedAgent(spec));
  setTeam(toSharedTeam(spec));
  registerVisibleLocalTeam(soloProjectedId(spec.prefix, spec.id));
}

function configSchema(db: Database): string {
  try {
    const rows = db.prepare("PRAGMA database_list").all() as { name: string }[];
    if (rows.some((r) => r.name === "shared")) return "shared";
  } catch {
    /* fall through */
  }
  return "main";
}

function nowTs(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/** Upsert one solo agent into the config tables (best-effort; skip pre-boot). */
export function upsertSoloIntoSharedTables(db: Database, spec: SoloAgentSpec): void {
  const schema = configSchema(db);
  const ts = nowTs();
  const sharedAgent = toSharedAgent(spec);
  const sharedTeam = toSharedTeam(spec);

  db.prepare(
    `INSERT OR REPLACE INTO ${schema}.agents
       (id, name, type, model, config, capabilities, status, process_pid, current_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'idle', NULL, NULL, ?, ?)`,
  ).run(
    sharedAgent.id,
    sharedAgent.name,
    sharedAgent.type,
    sharedAgent.model,
    JSON.stringify({ instruction: sharedAgent.instruction }),
    JSON.stringify(sharedAgent.capabilities),
    ts,
    ts,
  );

  db.prepare(
    `INSERT OR REPLACE INTO ${schema}.teams
       (id, name, entrypoint_agent_id, phases, goal, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sharedTeam.id, sharedTeam.name, sharedTeam.entrypoint_agent_id, JSON.stringify(sharedTeam.phases), sharedTeam.goal, ts, ts);

  const m = sharedTeam.members[0]!;
  db.prepare(
    `INSERT OR REPLACE INTO ${schema}.team_agents
       (id, team_id, agent_id, role, level, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`${sharedTeam.id}:${m.agent_id}`, sharedTeam.id, m.agent_id, m.role, m.level, ts);
}

/** Remove one solo agent from BOTH the store Maps and config tables. */
export function removeSoloFromShared(db: Database, prefix: string, id: string): void {
  const projectedId = soloProjectedId(prefix, id);
  removeTeam(projectedId);
  removeAgent(projectedId);
  unregisterVisibleLocalTeam(projectedId);
  try {
    const schema = configSchema(db);
    db.prepare(`DELETE FROM ${schema}.team_agents WHERE team_id = ?`).run(projectedId);
    db.prepare(`DELETE FROM ${schema}.teams WHERE id = ?`).run(projectedId);
    db.prepare(`DELETE FROM ${schema}.agents WHERE id = ?`).run(projectedId);
  } catch {
    /* shared tables not ready */
  }
}

/** Project one solo agent into BOTH the Maps and (best-effort) the config tables. */
export function refreshSoloInShared(db: Database, spec: SoloAgentSpec): void {
  projectSoloIntoMaps(spec);
  try {
    upsertSoloIntoSharedTables(db, spec);
  } catch {
    /* shared tables not ready yet (pre-boot flatten path handles seeding) */
  }
}
