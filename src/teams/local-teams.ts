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
import { isCustomAgentType } from "../agents/types";
import { registerVisibleLocalTeam, unregisterVisibleLocalTeam } from "../config/feature-flags";
import { normalizeSlashCommand } from "../slack/slash-command";
import { getSingleAgent, isSingleAgentRefType, singleAgentIdFromRefType } from "../single-agents/store";

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
//     never collide across teams.
// ---------------------------------------------------------------------------

export interface LocalTeamAgent {
  id: string; // author-facing id (unique within the team)
  name: string;
  type: string;
  model: string;
  instruction?: string;
  role?: string | null;
  capabilities?: string[];
  /**
   * Operator-defined tool names granted to this agent on this team
   * (`src/custom-tools`). Applies to CLI agents too — it is the only way one gets
   * a custom tool. A custom agent additionally carries its own always-on list, and
   * a session receives the union.
   */
  customTools?: string[];
}

/**
 * Real-time team config (only meaningful when `mode === 'realtime'`). Drives the
 * transcription-summary step of a real-time session. See src/orchestrator/realtime-session.ts.
 */
export interface RealtimeTeamConfig {
  /**
   * When false, no summarizer agent runs; the raw transcript is fed to the
   * entrypoint instead (the existing raw-transcript fallback). Default true.
   */
  summaryEnabled?: boolean;
  /** Provider (agent_type) for the summary, e.g. "claude-code". Empty = built-in default. */
  summaryProvider?: string;
  /** Model id for the summary. Free text; empty = the provider's default model. */
  summaryModel?: string;
}

/** Per-team settings blob (runtime `local_teams.team_config` JSON column). */
export interface LocalTeamConfig {
  /**
   * Team mode. 'regular' (default) teams run standard/recurring tasks through the
   * normal queue and require >=1 phase. 'realtime' teams back real-time tasks
   * (audio/text + transcription); they carry no phases and expose `realtime`
   * below. Absent = 'regular' (back-compat for teams saved before this field).
   */
  mode?: "regular" | "realtime";
  /** Real-time config; only read when `mode === 'realtime'`. */
  realtime?: RealtimeTeamConfig;
  /** When true, this team's tasks expose the Slack MCP tools to their agents. */
  slackEnabled?: boolean;
  /**
   * Slack slash command bound to this team (e.g. "/software-team"). When an
   * allowed user invokes it, Skipper creates + auto-approves a task on this
   * team with the arg text as the description. See src/slack/commands.ts.
   */
  slashCommand?: string;
  /**
   * Operator-defined tool names granted to this team's Skipper (src/custom-tools).
   * Skipper is the implicit entrypoint and has no `agents[]` entry to carry a
   * `customTools` list, so its grant lives here.
   */
  skipperCustomTools?: string[];
}

/** Whether a team is in real-time mode (absent mode defaults to regular). */
export function isRealtimeTeam(team: Pick<LocalTeam, "config"> | LocalTeamConfig | null | undefined): boolean {
  if (!team) return false;
  const config = "config" in team ? team.config : team;
  return config?.mode === "realtime";
}

export interface LocalTeam {
  id: string;
  name: string;
  skipper_prompt: string;
  hooks: unknown[];
  phases: TeamPhase[];
  agents: LocalTeamAgent[];
  config: LocalTeamConfig;
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
  config?: LocalTeamConfig;
}

const SKIPPER_AGENT_ID = "skipper";

/** Namespace an inline agent id for the shared layer: `<teamId>:<authorId>`. */
export function namespacedAgentId(teamId: string, authorId: string): string {
  return `${teamId}:${authorId}`;
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
  team_config: string | null;
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

function parseTeamConfig(raw: string | null | undefined): LocalTeamConfig {
  try {
    const v = JSON.parse(raw ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as LocalTeamConfig) : {};
  } catch {
    return {};
  }
}

/**
 * Drop fields that were removed from the schema but may still sit in the stored
 * JSON of a team saved by an older build. Without this a legacy `parent_agent_id`
 * would keep surfacing through the API and exports until that team is re-saved.
 */
function parseAgents(raw: string): LocalTeamAgent[] {
  return parseJsonArray(raw).map((a) => {
    if (!a || typeof a !== "object") return a as LocalTeamAgent;
    const { parent_agent_id: _dropped, ...rest } = a as Record<string, unknown>;
    return rest as unknown as LocalTeamAgent;
  });
}

function rowToLocalTeam(row: LocalTeamRow): LocalTeam {
  return {
    id: row.id,
    name: row.name,
    skipper_prompt: row.skipper_prompt ?? "",
    hooks: parseJsonArray(row.hooks ?? "[]"),
    phases: parseJsonArray(row.phases ?? "[]") as TeamPhase[],
    agents: parseAgents(row.agents ?? "[]"),
    config: parseTeamConfig(row.team_config),
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
    { agent_id: SKIPPER_AGENT_ID, role: "lead", level: 0 },
    ...team.agents.map((a) => ({
      agent_id: namespacedAgentId(team.id, a.id),
      role: a.role ?? null,
      level: 1,
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

/**
 * Resolve library-reference members to their live definition before projection.
 * A `single:<id>` member (a headless CLI agent added from the library) is a LIVE
 * reference: its provider/model/instruction/capabilities/tools come from the
 * single_agents record at flatten time, so editing the record updates every team
 * that references it. A `custom:<id>` member resolves in-process at run time, so
 * it only needs its optional fields defaulted here (the runner owns its prompt +
 * model). A dangling ref (record deleted) is left as-is - deletes are blocked
 * while a team references the agent, and saves validate the ref exists, so this
 * is only reachable transiently. Returns a shallow team copy; the stored JSON
 * keeps the ref token untouched.
 */
function resolveTeamAgentRefs(db: Database, team: LocalTeam): LocalTeam {
  const agents = team.agents.map((a): LocalTeamAgent => {
    if (isSingleAgentRefType(a.type)) {
      const rec = getSingleAgent(db, singleAgentIdFromRefType(a.type));
      if (!rec) return a;
      return {
        ...a,
        type: rec.agent_type,
        model: rec.model,
        instruction: rec.instruction,
        capabilities: rec.capabilities,
        customTools: rec.config.customTools ?? [],
      };
    }
    if (isCustomAgentType(a.type)) {
      return { ...a, model: a.model || "default", instruction: a.instruction ?? "" };
    }
    return a;
  });
  return { ...team, agents };
}

/** Register one local team into the in-memory store Maps (idempotent). Expects a ref-resolved team. */
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
    flattenLocalTeamIntoMaps(resolveTeamAgentRefs(db, team));
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
       (id, team_id, agent_id, role, level, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const m of sharedTeam.members) {
    insMember.run(`${team.id}:${m.agent_id}`, team.id, m.agent_id, m.role, m.level, ts);
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

  const resolved = resolveTeamAgentRefs(db, team);
  flattenLocalTeamIntoMaps(resolved);
  // Best-effort table sync: only meaningful once the shared schema exists.
  try {
    deleteTeamFromSharedTables(db, teamId, resolved.agents.map((a) => a.id));
    upsertTeamIntoSharedTables(db, resolved);
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

function validateInput(db: Database, input: LocalTeamInput): void {
  if (!input.name || !input.name.trim()) {
    throw new Error("team: name is required");
  }
  // Real-time teams carry no phases (the session drives them, not the phase
  // loop). Only regular teams require at least one.
  if (!isRealtimeTeam(input.config) && (!Array.isArray(input.phases) || input.phases.length === 0)) {
    throw new Error("team: at least one phase is required");
  }
  const agents = input.agents ?? [];
  const seen = new Set<string>();
  for (const a of agents) {
    if (!a.id || !a.id.trim()) throw new Error("team: every inline agent needs an id");
    if (a.id === SKIPPER_AGENT_ID) throw new Error('team: "skipper" is implicit and cannot be an inline agent');
    if (seen.has(a.id)) throw new Error(`team: duplicate inline agent id "${a.id}"`);
    seen.add(a.id);
    // A `single:<id>` member is a live reference to a headless CLI agent - the
    // record must exist, since the flatten layer resolves it into a real
    // provider at run time.
    if (isSingleAgentRefType(a.type)) {
      if (!getSingleAgent(db, singleAgentIdFromRefType(a.type))) {
        throw new Error(`team: headless CLI agent for "${a.id}" no longer exists`);
      }
      continue;
    }
    // `getAgentType` reads the JSON config snapshot, which is where the CLI
    // providers live. Custom agents are registered into the in-memory
    // `agent_types` TABLE only (they carry secrets and must never reach a
    // committed snapshot), so they are absent from it — and a team containing
    // one would be rejected on save. Accept them by their type prefix.
    if (!isCustomAgentType(a.type) && !getAgentType(a.type)) {
      throw new Error(`team: unknown agent type "${a.type}" for agent "${a.id}"`);
    }
  }
}

/** Local team names that reference a given agent-type token (`single:<id>` / `custom:<id>`). */
export function teamsReferencingAgentType(db: Database, type: string): string[] {
  if (!localTeamsTableExists(db)) return [];
  return listLocalTeams(db)
    .filter((t) => t.agents.some((a) => a.type === type))
    .map((t) => t.name);
}

/**
 * Re-project every local team that references a given agent-type token, so a live
 * edit to a library agent (headless CLI agent) propagates into the shared tables
 * without re-saving each team.
 */
export function reflattenTeamsReferencingAgentType(db: Database, type: string): void {
  if (!localTeamsTableExists(db)) return;
  for (const t of listLocalTeams(db)) {
    if (t.agents.some((a) => a.type === type)) refreshLocalTeamInShared(db, t.id);
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
  validateInput(db, input);
  const id = input.id?.trim() || randomUUID();
  if (getLocalTeam(db, id)) throw new Error(`team: id "${id}" already exists`);
  const ts = nowTs();
  db.prepare(
    `INSERT INTO local_teams (id, name, skipper_prompt, hooks, phases, agents, team_config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.skipper_prompt ?? "",
    JSON.stringify(input.hooks ?? []),
    JSON.stringify(input.phases),
    JSON.stringify(input.agents ?? []),
    JSON.stringify(input.config ?? {}),
    ts,
    ts,
  );
  refreshLocalTeamInShared(db, id);
  return getLocalTeam(db, id)!;
}

export function updateLocalTeam(db: Database, id: string, input: LocalTeamInput): LocalTeam {
  const existing = getLocalTeam(db, id);
  if (!existing) throw new Error(`team: id "${id}" not found`);
  validateInput(db, input);
  const ts = nowTs();
  db.prepare(
    `UPDATE local_teams
        SET name = ?, skipper_prompt = ?, hooks = ?, phases = ?, agents = ?, team_config = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    input.name,
    input.skipper_prompt ?? "",
    JSON.stringify(input.hooks ?? []),
    JSON.stringify(input.phases),
    JSON.stringify(input.agents ?? []),
    JSON.stringify(input.config ?? {}),
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

/** Whether a team opted into the Slack integration (gates the Slack MCP tools). */
export function isSlackEnabledForTeam(db: Database, teamId: string): boolean {
  return getLocalTeam(db, teamId)?.config?.slackEnabled === true;
}

/** Find the team bound to a Slack slash command, or null. Command is normalized. */
export function findTeamBySlashCommand(db: Database, command: string): LocalTeam | null {
  const want = normalizeSlashCommand(command);
  if (!want) return null;
  for (const team of listLocalTeams(db)) {
    if (normalizeSlashCommand(team.config?.slashCommand) === want) return team;
  }
  return null;
}
