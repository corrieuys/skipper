import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { clearAgentTypeCache } from "./types";

export const SKIPPER_AGENT_ID = "skipper";
export const SKIPPER_AGENT_NAME = "Skipper";

export function isSkipperAgent(agentId: string): boolean {
  return agentId === SKIPPER_AGENT_ID;
}

export interface SkipperConfig {
  agent_type: string;
  model: string;
}

export function getSkipperConfig(db?: Database): SkipperConfig {
  const database = db ?? getDb();
  const rows = database
    .prepare("SELECT key, value FROM skipper_config")
    .all() as { key: string; value: string }[];

  const config: SkipperConfig = { agent_type: "claude-code", model: "default" };
  for (const row of rows) {
    if (row.key === "agent_type") config.agent_type = row.value;
    if (row.key === "model") config.model = row.value;
  }
  return config;
}

export function updateSkipperConfig(
  updates: { agent_type?: string; model?: string },
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

  // Sync the agents row
  const config = getSkipperConfig(database);
  database
    .prepare("UPDATE agents SET type = ?, model = ?, updated_at = datetime('now') WHERE id = ?")
    .run(config.agent_type, config.model, SKIPPER_AGENT_ID);

  // Invalidate cached agent type definitions since the Skipper type may have changed
  clearAgentTypeCache();

  return config;
}
