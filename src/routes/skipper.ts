import type { Database } from "bun:sqlite";
import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { getSkipperConfig } from "../agents/skipper";
import { listAgentTypes } from "../config/store";

export function registerSkipperRoutes(database?: Database): void {
  const db = database ?? getDb();

  addRoute("GET", "/api/skipper/config", () => {
    const config = getSkipperConfig(db);
    const types = listAgentTypes();
    const availableTypes = types.map((t) => t.name);
    const currentType = types.find((t) => t.name === config.agent_type);
    const availableModels = currentType?.available_models ?? [];

    return Response.json({
      ...config,
      available_types: availableTypes,
      available_models: availableModels,
    });
  });
}
