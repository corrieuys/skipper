import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { clearAgentTypeCache } from "./types";
import { assetTextSync } from "../assets";
import {
  getStringSetting, setStringSetting,
  SETTING_SKIPPER_AGENT_COLOR, SETTING_SKIPPER_AGENT_CHARACTER,
} from "../config/app-settings";
import { sanitizeColor, isCreatureId, DEFAULT_AGENT_COLOR } from "../html/atoms/creature";

export const SKIPPER_AGENT_ID = "skipper";

function loadPrompt(filename: string): string {
  return assetTextSync(`prompts/${filename}`).trimEnd();
}

const SKIPPER_PROMPT_DEFAULT = loadPrompt("skipper.md");
const SKIPPER_REALTIME_PROMPT_DEFAULT = loadPrompt("notary.md");

export interface SkipperConfig {
  agent_type: string;
  model: string;
  prompt: string;
  realtime_prompt: string;
}

export function getSkipperConfig(db?: Database): SkipperConfig {
  const database = db ?? getDb();
  const rows = database
    .prepare("SELECT key, value FROM skipper_config")
    .all() as { key: string; value: string }[];

  const config: SkipperConfig = {
    agent_type: "claude-code",
    model: "default",
    prompt: SKIPPER_PROMPT_DEFAULT,
    realtime_prompt: SKIPPER_REALTIME_PROMPT_DEFAULT,
  };
  for (const row of rows) {
    if (row.key === "agent_type") config.agent_type = row.value;
    if (row.key === "model") config.model = row.value;
    if (row.key === "prompt") config.prompt = row.value;
    if (row.key === "realtime_prompt") config.realtime_prompt = row.value;
  }
  return config;
}

export function updateSkipperConfig(
  updates: { agent_type?: string; model?: string; prompt?: string; realtime_prompt?: string },
  db?: Database,
): SkipperConfig {
  const database = db ?? getDb();

  if (updates.agent_type) {
    database
      .prepare("INSERT OR REPLACE INTO skipper_config (key, value) VALUES ('agent_type', ?)")
      .run(updates.agent_type);
  }
  if (updates.model) {
    database
      .prepare("INSERT OR REPLACE INTO skipper_config (key, value) VALUES ('model', ?)")
      .run(updates.model);
  }
  if (updates.prompt !== undefined) {
    database
      .prepare("INSERT OR REPLACE INTO skipper_config (key, value) VALUES ('prompt', ?)")
      .run(updates.prompt);
  }
  if (updates.realtime_prompt !== undefined) {
    database
      .prepare("INSERT OR REPLACE INTO skipper_config (key, value) VALUES ('realtime_prompt', ?)")
      .run(updates.realtime_prompt);
  }

  const config = getSkipperConfig(database);


  // Invalidate cached agent type definitions since the Skipper type may have changed
  clearAgentTypeCache();

  return config;
}

// ---------------------------------------------------------------------------
// Skipper's own agent identity (color + creature character) for the orb.
// Machine-scoped settings, applied onto the config `agents` row for `skipper`.
// ---------------------------------------------------------------------------

function configSchema(db: Database): string {
  try {
    const rows = db.prepare("PRAGMA database_list").all() as { name: string }[];
    if (rows.some((r) => r.name === "shared")) return "shared";
  } catch {
    /* fall through */
  }
  return "main";
}

export interface SkipperIdentity {
  color: string;
  /** Creature id, or "" for the cube fallback. Defaults to the captain. */
  character: string;
}

export function getSkipperIdentity(db?: Database): SkipperIdentity {
  const database = db ?? getDb();
  const color = sanitizeColor(getStringSetting(database, SETTING_SKIPPER_AGENT_COLOR, DEFAULT_AGENT_COLOR));
  const raw = getStringSetting(database, SETTING_SKIPPER_AGENT_CHARACTER, "captain");
  // A stored "" is an explicit cube choice; unset (never saved) → the captain.
  const character = raw === "" ? "" : (isCreatureId(raw) ? raw : "captain");
  return { color, character };
}

/** Patch the config `agents` row for `skipper` with the stored identity. */
export function applySkipperIdentity(db?: Database): void {
  const database = db ?? getDb();
  const { color, character } = getSkipperIdentity(database);
  const schema = configSchema(database);
  try {
    database.prepare(
      `UPDATE ${schema}.agents
         SET config = json_set(CASE WHEN config IS NULL OR config = '' THEN '{}' ELSE config END,
                               '$.color', ?, '$.character', ?)
       WHERE id = ?`,
    ).run(color, character || null, SKIPPER_AGENT_ID);
  } catch {
    // The agents row may not be seeded yet at first call; boot re-applies.
  }
}

export function saveSkipperIdentity(color: string, character: string, db?: Database): SkipperIdentity {
  const database = db ?? getDb();
  setStringSetting(database, SETTING_SKIPPER_AGENT_COLOR, sanitizeColor(color));
  setStringSetting(database, SETTING_SKIPPER_AGENT_CHARACTER, isCreatureId(character) ? character : "");
  applySkipperIdentity(database);
  return getSkipperIdentity(database);
}

/** Look up the entrypoint agent ID for a task by reading tasks.team_id → teams.entrypoint_agent_id */
export function getEntrypointAgentId(db: Database, taskId: string): string | null {
  const row = db
    .prepare(
      "SELECT t.entrypoint_agent_id FROM teams t JOIN tasks tk ON tk.team_id = t.id WHERE tk.id = ?",
    )
    .get(taskId) as { entrypoint_agent_id: string | null } | null;
  return row?.entrypoint_agent_id ?? null;
}

/** Check if an agent is the entrypoint for a given team */
export function isEntrypointAgent(db: Database, agentId: string, teamId: string): boolean {
  const row = db
    .prepare("SELECT entrypoint_agent_id FROM teams WHERE id = ?")
    .get(teamId) as { entrypoint_agent_id: string | null } | null;
  return row?.entrypoint_agent_id === agentId;
}
