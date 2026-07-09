import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { AgentTypeDefinition } from "../agents/types";
import { BUILTIN_REALTIME_AGENTS, BUILTIN_REALTIME_TEAMS } from "./builtin-realtime";
import { BUILTIN_INFRA_AGENTS } from "./builtin-infra";
import type { Database } from "bun:sqlite";
import { getConfigDir, ensureConfigSeeded } from "../paths";
import { assetTextSync, listAssets } from "../assets";
import { getStringSetting, setStringSetting, SETTING_ACTIVE_WALLPAPER } from "./app-settings";

export interface AgentDefinition {
  id: string;
  name: string;
  type: string;
  model: string;
  instruction?: string;
  environment?: Record<string, string>;
  constraints?: Record<string, string>;
  capabilities: string[];
}

export interface TeamMember {
  agent_id: string;
  role: string | null;
  level: number;
  parent_agent_id: string | null;
}

export interface TeamConsensusConfig {
  agent_count: number;
  strategy: string;
  worktree: boolean;
  reviewer_agent_id?: string;
}

export interface TeamPhase {
  name: string;
  prompt: string;
  review?: boolean;
  consensus?: TeamConsensusConfig;
}

export interface TeamDefinition {
  id: string;
  name: string;
  goal: string | null;
  entrypoint_agent_id: string | null;
  phases: TeamPhase[];
  members: TeamMember[];
}

export interface SkipperConfig {
  agent_type: string;
  model: string;
  prompt: string;
  realtime_prompt: string;
}

export interface AppearanceConfig {
  gallery: string[];
  active: string;
}

const CONFIG_DIR = getConfigDir();

const CONFIG_FILES = {
  agent_types: resolve(CONFIG_DIR, "agent_types.json"),
  skipper_config: resolve(CONFIG_DIR, "skipper_config.json"),
  realtime_config: resolve(CONFIG_DIR, "realtime_config.json"),
  appearance: resolve(CONFIG_DIR, "appearance.json"),
} as const;


let agentTypes: Map<string, AgentTypeDefinition> = new Map();
let agents: Map<string, AgentDefinition> = new Map();
let teams: Map<string, TeamDefinition> = new Map();
let skipperConfig: SkipperConfig = {
  agent_type: "claude-code",
  model: "default",
  prompt: "",
  realtime_prompt: "",
};
let realtimeConfigDefaults: Array<{ key: string; value: string }> = [];
let appearanceConfig: AppearanceConfig = {
  gallery: [], active: "",
};
let initialized = false;

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v));
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = String(v);
  }
  return out;
}

function parseContainer<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>)[key])) {
    return (raw as Record<string, unknown>)[key] as T[];
  }
  return [];
}

function loadAgentTypes(): Map<string, AgentTypeDefinition> {
  const raw = readJson(CONFIG_FILES.agent_types);
  const rows = parseContainer<Record<string, unknown>>(raw, "agent_types");
  const map = new Map<string, AgentTypeDefinition>();
  for (const row of rows) {
    const name = String(row.name ?? "");
    if (!name) continue;
    map.set(name, {
      name,
      command: String(row.command ?? ""),
      args: toStringArray(row.args),
      resume_args: row.resume_args == null ? null : toStringArray(row.resume_args),
      model_flag: row.model_flag == null ? null : String(row.model_flag),
      available_models: toStringArray(row.available_models),
      env_vars: toStringRecord(row.env_vars),
      supports_stdin: row.supports_stdin === true,
      supports_resume: row.supports_resume === true,
      resume_flag: row.resume_flag == null ? null : String(row.resume_flag),
    });
  }
  return map;
}

function loadSkipperConfig(): SkipperConfig {
  const raw = readJson(CONFIG_FILES.skipper_config);
  const promptDefault = assetTextSync("prompts/skipper.md").trimEnd();
  const realtimePromptDefault = assetTextSync("prompts/notary.md").trimEnd();

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      agent_type: String(obj.agent_type ?? "claude-code"),
      model: String(obj.model ?? "default"),
      prompt: typeof obj.prompt === "string" && obj.prompt.length > 0
        ? obj.prompt
        : promptDefault,
      realtime_prompt: typeof obj.realtime_prompt === "string" && obj.realtime_prompt.length > 0
        ? obj.realtime_prompt
        : realtimePromptDefault,
    };
  }

  return {
    agent_type: "claude-code",
    model: "default",
    prompt: promptDefault,
    realtime_prompt: realtimePromptDefault,
  };
}

function loadRealtimeConfigDefaults(): Array<{ key: string; value: string }> {
  const raw = readJson(CONFIG_FILES.realtime_config);
  const rows = parseContainer<Record<string, unknown>>(raw, "realtime_config");
  const out: Array<{ key: string; value: string }> = [];
  for (const row of rows) {
    const key = typeof row.key === "string" ? row.key : "";
    if (!key) continue;
    out.push({ key, value: row.value == null ? "" : String(row.value) });
  }
  return out;
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "avif", "gif"]);

// Shipped default wallpapers are embedded assets under public/wallpapers/defaults/.
function scanDefaultWallpapers(): string[] {
  return listAssets("public/wallpapers/defaults/")
    .filter((logical) => IMAGE_EXTS.has(logical.split(".").pop()?.toLowerCase() || ""))
    .map((logical) => `/${logical.slice("public/".length)}`);
}

let cachedDefaults: string[] | null = null;

export function getDefaultWallpapers(): string[] {
  if (cachedDefaults === null) cachedDefaults = scanDefaultWallpapers();
  return cachedDefaults;
}

export function isDefaultWallpaper(url: string): boolean {
  return url.startsWith("/wallpapers/defaults/");
}

function pickRandom(arr: string[]): string {
  if (arr.length === 0) return "";
  return arr[Math.floor(Math.random() * arr.length)];
}

function loadAppearance(): AppearanceConfig {
  const raw = readJson(CONFIG_FILES.appearance);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;

    // Current format
    if (Array.isArray(obj.gallery)) {
      const g = (obj.gallery as unknown[]).filter((u): u is string => typeof u === "string");
      return { gallery: g, active: pickRandom(g) };
    }

    // Migrate from old dark/light split format
    if (Array.isArray(obj.gallery_dark)) {
      const g = (obj.gallery_dark as unknown[]).filter((u): u is string => typeof u === "string");
      return { gallery: g, active: pickRandom(g) };
    }

    // Legacy single-URL format
    const dark = typeof obj.background_image_dark === "string" ? obj.background_image_dark : "";
    return { gallery: dark ? [dark] : [], active: dark };
  }
  return { gallery: [], active: "" };
}

export function initializeConfigStore(): void {
  ensureConfigSeeded();
  agentTypes = loadAgentTypes();
  // Agents and teams are not read from JSON: infra + realtime agents are code
  // defaults (per-machine model overrides live in runtime app_settings), and
  // teams are stored in the runtime DB and registered into this Map at boot.
  // The built-in "Real Time" team and its agents are always present.
  agents = new Map();
  teams = new Map();
  for (const agent of BUILTIN_INFRA_AGENTS) agents.set(agent.id, agent);
  for (const agent of BUILTIN_REALTIME_AGENTS) agents.set(agent.id, agent);
  for (const team of BUILTIN_REALTIME_TEAMS) teams.set(team.id, team);
  skipperConfig = loadSkipperConfig();
  realtimeConfigDefaults = loadRealtimeConfigDefaults();
  appearanceConfig = loadAppearance();
  initialized = true;
}

export function resetConfigStore(): void {
  agentTypes = new Map();
  agents = new Map();
  teams = new Map();
  skipperConfig = {
    agent_type: "claude-code",
    model: "default",
    prompt: "",
    realtime_prompt: "",
  };
  realtimeConfigDefaults = [];
  appearanceConfig = {
    gallery: [], active: "",
  };
  initialized = false;
}

function ensureInitialized(): void {
  if (!initialized) initializeConfigStore();
}

export function isConfigStoreInitialized(): boolean {
  return initialized;
}

export function getAgentType(name: string): AgentTypeDefinition | undefined {
  ensureInitialized();
  return agentTypes.get(name);
}

export function listAgentTypes(): AgentTypeDefinition[] {
  ensureInitialized();
  return [...agentTypes.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getAgent(id: string): AgentDefinition | undefined {
  ensureInitialized();
  return agents.get(id);
}

export function listAgents(): AgentDefinition[] {
  ensureInitialized();
  return [...agents.values()];
}

export function listAgentsByType(type: string): AgentDefinition[] {
  ensureInitialized();
  return [...agents.values()].filter((a) => a.type === type);
}

export function getTeam(id: string): TeamDefinition | undefined {
  ensureInitialized();
  return teams.get(id);
}

export function listTeams(): TeamDefinition[] {
  ensureInitialized();
  return [...teams.values()];
}

export function getTeamMembers(teamId: string): TeamMember[] {
  ensureInitialized();
  return teams.get(teamId)?.members ?? [];
}

export function getAgentTeams(agentId: string): TeamDefinition[] {
  ensureInitialized();
  return [...teams.values()].filter((t) =>
    t.members.some((m) => m.agent_id === agentId),
  );
}

export function getSkipperConfig(): SkipperConfig {
  ensureInitialized();
  return skipperConfig;
}

export function getAppearanceConfig(db: Database): AppearanceConfig {
  ensureInitialized();
  const defaults = getDefaultWallpapers();
  const existing = new Set(appearanceConfig.gallery);
  const merged = defaults.length === 0
    ? appearanceConfig.gallery
    : [...defaults.filter((u) => !existing.has(u)), ...appearanceConfig.gallery];

  // Active wallpaper lives in runtime app_settings (persists across restarts,
  // shared by dev + binary) — not appearance.json. If none is stored (or it was
  // removed from the gallery), pick one at random and persist it so the choice
  // stays stable until changed.
  const stored = getStringSetting(db, SETTING_ACTIVE_WALLPAPER, "");
  let active = stored && merged.includes(stored) ? stored : "";
  if (!active) {
    active = pickRandom(merged);
    if (active) setStringSetting(db, SETTING_ACTIVE_WALLPAPER, active);
  }
  return { gallery: merged, active };
}

/** Persist the active wallpaper selection to runtime app_settings. */
export function setActiveWallpaper(db: Database, url: string): void {
  setStringSetting(db, SETTING_ACTIVE_WALLPAPER, url);
}

/**
 * Update appearance settings (wallpapers) from the config UI. Updates the
 * in-memory cache so the next page render reflects it immediately, and writes
 * `config/appearance.json` so it survives a restart. The persisted file only
 * stores the gallery — `active` is picked randomly on each server start.
 */
export function setAppearanceConfig(config: AppearanceConfig): void {
  ensureInitialized();
  appearanceConfig = {
    gallery: config.gallery ?? [],
    active: config.active ?? "",
  };
  try {
    const persisted = { gallery: appearanceConfig.gallery };
    writeFileSync(CONFIG_FILES.appearance, JSON.stringify(persisted, null, 2) + "\n");
  } catch (err) {
    console.warn("[config] could not write appearance.json:", err);
  }
}

// Mutation helpers used by AgentManager/TeamManager for in-process state
// updates (e.g. test fixtures). They mutate the in-memory Maps only and never
// write back to the config/*.json files.
export function setAgent(agent: AgentDefinition): void {
  ensureInitialized();
  agents.set(agent.id, agent);
}

export function removeAgent(id: string): boolean {
  ensureInitialized();
  const had = agents.delete(id);
  // Also strip the agent from any team memberships and entrypoint refs.
  for (const team of teams.values()) {
    team.members = team.members.filter((m) => m.agent_id !== id);
    if (team.entrypoint_agent_id === id) team.entrypoint_agent_id = null;
  }
  return had;
}

export function setTeam(team: TeamDefinition): void {
  ensureInitialized();
  teams.set(team.id, team);
}

export function removeTeam(id: string): boolean {
  ensureInitialized();
  return teams.delete(id);
}

export function setAgentType(def: AgentTypeDefinition): void {
  ensureInitialized();
  agentTypes.set(def.name, def);
}

export function removeAgentType(name: string): boolean {
  ensureInitialized();
  return agentTypes.delete(name);
}

export function setSkipperConfig(config: SkipperConfig): void {
  ensureInitialized();
  skipperConfig = { ...config };
}

// ---------------------------------------------------------------------------
// Legacy snapshot API — used by db/connection.ts to seed the in-memory
// "shared" config tables at boot. The DB tables now serve as a runtime cache
// of the JSON files; mutations against them are not persisted back to disk.
// ---------------------------------------------------------------------------

export interface ConfigSnapshot {
  agent_types: Record<string, unknown>[];
  agents: Record<string, unknown>[];
  teams: Record<string, unknown>[];
  team_agents: Record<string, unknown>[];
  skipper_config: Record<string, unknown>[];
}

export function readConfigSnapshot(): ConfigSnapshot {
  ensureInitialized();
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  return {
    agent_types: [...agentTypes.values()].map((t) => ({
      name: t.name,
      command: t.command,
      args: JSON.stringify(t.args),
      resume_args: t.resume_args ? JSON.stringify(t.resume_args) : null,
      model_flag: t.model_flag,
      available_models: JSON.stringify(t.available_models),
      env_vars: JSON.stringify(t.env_vars),
      supports_stdin: t.supports_stdin ? 1 : 0,
      supports_resume: t.supports_resume ? 1 : 0,
      resume_flag: t.resume_flag,
      created_at: ts,
    })),
    agents: [...agents.values()].map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      model: a.model,
      config: JSON.stringify({
        instruction: a.instruction,
        environment: a.environment,
        constraints: a.constraints,
      }),
      capabilities: JSON.stringify(a.capabilities),
      status: "idle",
      process_pid: null,
      current_task_id: null,
      created_at: ts,
      updated_at: ts,
    })),
    teams: [...teams.values()].map((t) => ({
      id: t.id,
      name: t.name,
      entrypoint_agent_id: t.entrypoint_agent_id,
      phases: JSON.stringify(t.phases),
      goal: t.goal,
      created_at: ts,
      updated_at: ts,
    })),
    team_agents: [...teams.values()].flatMap((t) =>
      t.members.map((m) => ({
        id: `${t.id}:${m.agent_id}`,
        team_id: t.id,
        agent_id: m.agent_id,
        role: m.role,
        level: m.level,
        parent_agent_id: m.parent_agent_id,
        created_at: ts,
      })),
    ),
    skipper_config: [
      { key: "agent_type", value: skipperConfig.agent_type },
      { key: "model", value: skipperConfig.model },
      { key: "prompt", value: skipperConfig.prompt },
      { key: "realtime_prompt", value: skipperConfig.realtime_prompt },
    ],
  };
}

interface SqlDatabase {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  exec(sql: string): unknown;
}

export function loadConfigSnapshotIntoDb(database: SqlDatabase, schema = "shared"): void {
  const snapshot = readConfigSnapshot();
  const q = (table: string) => `${schema}.${table}`;

  // INSERT OR IGNORE: in production the shared schema is a fresh in-memory DB
  // so every row is new; in single-mode tests, any pre-inserted rows survive.
  const insertAgentType = database.prepare(
    `INSERT OR IGNORE INTO ${q("agent_types")}
     (name, command, args, resume_args, model_flag, available_models, env_vars, supports_stdin, supports_resume, resume_flag, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  );
  for (const row of snapshot.agent_types) {
    insertAgentType.run(
      row.name, row.command, row.args, row.resume_args, row.model_flag,
      row.available_models, row.env_vars, row.supports_stdin, row.supports_resume,
      row.resume_flag, row.created_at,
    );
  }

  const insertAgent = database.prepare(
    `INSERT OR IGNORE INTO ${q("agents")}
     (id, name, type, model, config, capabilities, status, process_pid, current_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`,
  );
  for (const row of snapshot.agents) {
    insertAgent.run(
      row.id, row.name, row.type, row.model, row.config, row.capabilities,
      "idle", null, null, row.created_at, row.updated_at,
    );
  }

  const insertTeam = database.prepare(
    `INSERT OR IGNORE INTO ${q("teams")}
     (id, name, entrypoint_agent_id, phases, goal, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`,
  );
  for (const row of snapshot.teams) {
    insertTeam.run(
      row.id, row.name, row.entrypoint_agent_id, row.phases, row.goal,
      row.created_at, row.updated_at,
    );
  }

  const insertTeamAgent = database.prepare(
    `INSERT OR IGNORE INTO ${q("team_agents")}
     (id, team_id, agent_id, role, level, parent_agent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  );
  for (const row of snapshot.team_agents) {
    insertTeamAgent.run(
      row.id, row.team_id, row.agent_id, row.role, row.level,
      row.parent_agent_id, row.created_at,
    );
  }

  const insertSkipper = database.prepare(
    `INSERT OR IGNORE INTO ${q("skipper_config")} (key, value) VALUES (?, ?)`,
  );
  for (const row of snapshot.skipper_config) {
    insertSkipper.run(row.key, row.value);
  }
}

export function getRealtimeConfigDefaults(): Array<{ key: string; value: string }> {
  ensureInitialized();
  return realtimeConfigDefaults;
}

/**
 * Apply realtime_config defaults from `config/realtime_config.json` using
 * `INSERT OR IGNORE`, so user edits made via the UI persist across restarts.
 * The defaults only fill in keys that are missing from the runtime DB.
 */
export function loadRealtimeDefaultsIntoDb(database: SqlDatabase): void {
  ensureInitialized();
  const stmt = database.prepare(
    "INSERT OR IGNORE INTO realtime_config (key, value) VALUES (?, ?)",
  );
  for (const row of realtimeConfigDefaults) {
    stmt.run(row.key, row.value);
  }
}

