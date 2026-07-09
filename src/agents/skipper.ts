import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { clearAgentTypeCache } from "./types";
import { assetTextSync } from "../assets";

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
