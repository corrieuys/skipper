import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import {
  type AgentDefinition,
  type TeamDefinition,
  type TeamMember,
  type TeamPhase,
  getAgentType,
  setAgent,
  setTeam,
  removeAgent,
  removeTeam,
  getTeam,
} from "../config/store";
import { registerVisibleLocalTeam, unregisterVisibleLocalTeam } from "../config/feature-flags";

// ---------------------------------------------------------------------------
// A team embeds its own agents + phases and is persisted in the runtime DB.
//
// At boot and on every mutation a team is registered into the shared config
// layer (the in-memory store Maps + the agents/teams/team_agents tables) so the
// orchestrator can resolve it.
//
// Conventions:
//   - "skipper" is the implicit entrypoint of every team (level-0 member). It
//     is never authored as an inline agent; the shared "skipper" agent already
//     exists from JSON config.
//   - Every inline agent gets a NAMESPACED id of `<teamId>:<authorAgentId>`
//     when written into the shared layer, so shared.agents PRIMARY KEY can
//     never collide across teams. parent_agent_id that points at another inline
//     agent is namespaced too; a parent of "skipper" stays "skipper".
// ---------------------------------------------------------------------------

export interface LocalTeamAgent {
  id: string; // author-facing id (unique within the team)
  name: string;
  type: string;
  model: string;
  instruction?: string;
  role?: string | null;
  parent_agent_id?: string | null;
  capabilities?: string[];
}

export interface LocalTeam {
  id: string;
  name: string;
  skipper_prompt: string;
  hooks: unknown[];
  phases: TeamPhase[];
  agents: LocalTeamAgent[];
  created_at: string;
  updated_at: string;
}

export interface LocalTeamInput {
  id?: string;
  name: string;
  skipper_prompt?: string;
  hooks?: unknown[];
  phases: TeamPhase[];
  agents?: LocalTeamAgent[];
}

const SKIPPER_AGENT_ID = "skipper";

/** Namespace an inline agent id for the shared layer: `<teamId>:<authorId>`. */
export function namespacedAgentId(teamId: string, authorId: string): string {
  return `${teamId}:${authorId}`;
}

/** Namespace a parent ref; a parent of "skipper" stays literally "skipper". */
function namespacedParentId(teamId: string, parent: string | null | undefined): string | null {
  if (parent == null) return null;
  if (parent === SKIPPER_AGENT_ID) return SKIPPER_AGENT_ID;
  return namespacedAgentId(teamId, parent);
}

// ---------------------------------------------------------------------------
// Row <-> object mapping
// ---------------------------------------------------------------------------

interface LocalTeamRow {
  id: string;
  name: string;
  skipper_prompt: string;
  hooks: string;
  phases: string;
  agents: string;
  created_at: string;
  updated_at: string;
}

function parseJsonArray(raw: string): unknown[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function rowToLocalTeam(row: LocalTeamRow): LocalTeam {
  return {
    id: row.id,
    name: row.name,
    skipper_prompt: row.skipper_prompt ?? "",
    hooks: parseJsonArray(row.hooks ?? "[]"),
    phases: parseJsonArray(row.phases ?? "[]") as TeamPhase[],
    agents: parseJsonArray(row.agents ?? "[]") as LocalTeamAgent[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Flatten into the in-memory store Maps
// ---------------------------------------------------------------------------

/** Build the shared-layer AgentDefinition for an inline agent. */
function toSharedAgent(teamId: string, a: LocalTeamAgent): AgentDefinition {
  return {
    id: namespacedAgentId(teamId, a.id),
    name: a.name,
    type: a.type,
    model: a.model,
    instruction: a.instruction,
    capabilities: Array.isArray(a.capabilities) ? a.capabilities : [],
  };
}

/** Build the shared-layer TeamDefinition (skipper as level-0 lead + members). */
function toSharedTeam(team: LocalTeam): TeamDefinition {
  const members: TeamMember[] = [
    { agent_id: SKIPPER_AGENT_ID, role: "lead", level: 0, parent_agent_id: null },
    ...team.agents.map((a) => ({
      agent_id: namespacedAgentId(team.id, a.id),
      role: a.role ?? null,
      level: 1,
      parent_agent_id: namespacedParentId(team.id, a.parent_agent_id ?? SKIPPER_AGENT_ID),
    })),
  ];
  return {
    id: team.id,
    name: team.name,
    goal: null,
    entrypoint_agent_id: SKIPPER_AGENT_ID,
    phases: team.phases,
    members,
  };
}

/** Register one local team into the in-memory store Maps (idempotent). */
export function flattenLocalTeamIntoMaps(team: LocalTeam): void {
  for (const a of team.agents) {
    setAgent(toSharedAgent(team.id, a));
  }
  setTeam(toSharedTeam(team));
  registerVisibleLocalTeam(team.id);
}

/**
 * Read every local team from the runtime DB and register it into the in-memory
 * store Maps. Call this BEFORE loadConfigSnapshotIntoDb at boot so the snapshot
 * that seeds the shared.* tables already includes the local teams.
 */
export function flattenLocalTeamsIntoStore(db: Database): void {
  if (!localTeamsTableExists(db)) return;
  for (const team of listLocalTeams(db)) {
    flattenLocalTeamIntoMaps(team);
  }
}

// ---------------------------------------------------------------------------
// Live shared-table sync (no restart needed for edits)
// ---------------------------------------------------------------------------

function configSchema(db: Database): string {
  // Split mode attaches the config DB as "shared"; single mode keeps config
  // tables in "main". Detect by inspecting the attached database list.
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

/** Remove a team's namespaced rows from the config tables (NOT skipper). */
function deleteTeamFromSharedTables(db: Database, teamId: string, agentIds: string[]): void {
  const schema = configSchema(db);
  db.prepare(`DELETE FROM ${schema}.team_agents WHERE team_id = ?`).run(teamId);
  db.prepare(`DELETE FROM ${schema}.teams WHERE id = ?`).run(teamId);
  for (const authorId of agentIds) {
    db.prepare(`DELETE FROM ${schema}.agents WHERE id = ?`).run(namespacedAgentId(teamId, authorId));
  }
}

/** Upsert one team's rows into the config tables. */
function upsertTeamIntoSharedTables(db: Database, team: LocalTeam): void {
  const schema = configSchema(db);
  const ts = nowTs();

  const sharedTeam = toSharedTeam(team);

  // Agents
  const insAgent = db.prepare(
    `INSERT OR REPLACE INTO ${schema}.agents
       (id, name, type, model, config, capabilities, status, process_pid, current_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'idle', NULL, NULL, ?, ?)`,
  );
  for (const a of team.agents) {
    const shared = toSharedAgent(team.id, a);
    insAgent.run(
      shared.id,
      shared.name,
      shared.type,
      shared.model,
      JSON.stringify({ instruction: shared.instruction, environment: shared.environment, constraints: shared.constraints }),
      JSON.stringify(shared.capabilities),
      ts,
      ts,
    );
  }

  // Team
  db.prepare(
    `INSERT OR REPLACE INTO ${schema}.teams
       (id, name, entrypoint_agent_id, phases, goal, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sharedTeam.id, sharedTeam.name, sharedTeam.entrypoint_agent_id, JSON.stringify(sharedTeam.phases), sharedTeam.goal, ts, ts);

  // Members
  const insMember = db.prepare(
    `INSERT OR REPLACE INTO ${schema}.team_agents
       (id, team_id, agent_id, role, level, parent_agent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of sharedTeam.members) {
    insMember.run(`${team.id}:${m.agent_id}`, team.id, m.agent_id, m.role, m.level, m.parent_agent_id, ts);
  }
}

/**
 * Upsert ONE local team's representation into BOTH the in-memory store Maps and
 * the config tables, so an edit takes effect without a server restart. Removes
 * the previous namespaced rows first (in case inline agents were renamed or
 * removed), then re-inserts. Call after create/update.
 */
export function refreshLocalTeamInShared(db: Database, teamId: string): void {
  const team = getLocalTeam(db, teamId);
  if (!team) {
    removeLocalTeamFromShared(db, teamId);
    return;
  }

  // Remove stale namespaced agents from the Maps (renamed/removed inline agents).
  // Snapshot the prior member agent ids FIRST: removeAgent() mutates the team's
  // members array in place, so iterating it while removing would skip entries.
  const prev = getTeam(teamId);
  if (prev) {
    const prevAgentIds = prev.members
      .map((m) => m.agent_id)
      .filter((id) => id !== SKIPPER_AGENT_ID);
    for (const agentId of prevAgentIds) removeAgent(agentId);
    deleteTeamFromSharedTables(
      db,
      teamId,
      prevAgentIds.map((id) => (id.startsWith(`${teamId}:`) ? id.slice(teamId.length + 1) : id)),
    );
  }

  flattenLocalTeamIntoMaps(team);
  // Best-effort table sync: only meaningful once the shared schema exists.
  try {
    deleteTeamFromSharedTables(db, teamId, team.agents.map((a) => a.id));
    upsertTeamIntoSharedTables(db, team);
  } catch {
    /* shared tables not ready yet (pre-boot flatten path handles seeding) */
  }
}

/** Remove ONE local team from BOTH the in-memory store Maps and config tables. */
export function removeLocalTeamFromShared(db: Database, teamId: string): void {
  const prev = getTeam(teamId);
  const authorIds: string[] = [];
  if (prev) {
    // Snapshot first: removeAgent() mutates prev.members in place.
    const prevAgentIds = prev.members
      .map((m) => m.agent_id)
      .filter((id) => id !== SKIPPER_AGENT_ID);
    for (const agentId of prevAgentIds) {
      removeAgent(agentId);
      authorIds.push(agentId.startsWith(`${teamId}:`) ? agentId.slice(teamId.length + 1) : agentId);
    }
  }
  removeTeam(teamId);
  unregisterVisibleLocalTeam(teamId);
  try {
    deleteTeamFromSharedTables(db, teamId, authorIds);
  } catch {
    /* shared tables not ready */
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateInput(input: LocalTeamInput): void {
  if (!input.name || !input.name.trim()) {
    throw new Error("team: name is required");
  }
  if (!Array.isArray(input.phases) || input.phases.length === 0) {
    throw new Error("team: at least one phase is required");
  }
  const agents = input.agents ?? [];
  const seen = new Set<string>();
  for (const a of agents) {
    if (!a.id || !a.id.trim()) throw new Error("team: every inline agent needs an id");
    if (a.id === SKIPPER_AGENT_ID) throw new Error('team: "skipper" is implicit and cannot be an inline agent');
    if (seen.has(a.id)) throw new Error(`team: duplicate inline agent id "${a.id}"`);
    seen.add(a.id);
    if (!getAgentType(a.type)) throw new Error(`team: unknown agent type "${a.type}" for agent "${a.id}"`);
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function localTeamsTableExists(db: Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_teams'")
    .get() as { name: string } | null;
  return !!row;
}

export function listLocalTeams(db: Database): LocalTeam[] {
  if (!localTeamsTableExists(db)) return [];
  const rows = db.prepare("SELECT * FROM local_teams ORDER BY created_at, id").all() as LocalTeamRow[];
  return rows.map(rowToLocalTeam);
}

export function getLocalTeam(db: Database, id: string): LocalTeam | null {
  if (!localTeamsTableExists(db)) return null;
  const row = db.prepare("SELECT * FROM local_teams WHERE id = ?").get(id) as LocalTeamRow | null;
  return row ? rowToLocalTeam(row) : null;
}

export function createLocalTeam(db: Database, input: LocalTeamInput): LocalTeam {
  validateInput(input);
  const id = input.id?.trim() || randomUUID();
  if (getLocalTeam(db, id)) throw new Error(`team: id "${id}" already exists`);
  const ts = nowTs();
  db.prepare(
    `INSERT INTO local_teams (id, name, skipper_prompt, hooks, phases, agents, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.skipper_prompt ?? "",
    JSON.stringify(input.hooks ?? []),
    JSON.stringify(input.phases),
    JSON.stringify(input.agents ?? []),
    ts,
    ts,
  );
  refreshLocalTeamInShared(db, id);
  return getLocalTeam(db, id)!;
}

export function updateLocalTeam(db: Database, id: string, input: LocalTeamInput): LocalTeam {
  const existing = getLocalTeam(db, id);
  if (!existing) throw new Error(`team: id "${id}" not found`);
  validateInput(input);
  const ts = nowTs();
  db.prepare(
    `UPDATE local_teams
        SET name = ?, skipper_prompt = ?, hooks = ?, phases = ?, agents = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    input.name,
    input.skipper_prompt ?? "",
    JSON.stringify(input.hooks ?? []),
    JSON.stringify(input.phases),
    JSON.stringify(input.agents ?? []),
    ts,
    id,
  );
  refreshLocalTeamInShared(db, id);
  return getLocalTeam(db, id)!;
}

export function deleteLocalTeam(db: Database, id: string): boolean {
  const existing = getLocalTeam(db, id);
  if (!existing) return false;
  db.prepare("DELETE FROM local_teams WHERE id = ?").run(id);
  removeLocalTeamFromShared(db, id);
  return true;
}
