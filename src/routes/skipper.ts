import type { Database } from "bun:sqlite";
import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { getSkipperConfig, updateSkipperConfig } from "../agents/skipper";

function html(content: string): Response {
  return new Response(content, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function parseBody(req: Request): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await req.formData();
    const body: Record<string, string> = {};
    formData.forEach((value, key) => {
      body[key] = value.toString();
    });
    return body;
  }
  return req.json();
}

export function registerSkipperRoutes(database?: Database): void {
  const db = database ?? getDb();

  // GET config
  addRoute("GET", "/api/skipper/config", () => {
    const config = getSkipperConfig(db);

    const agentTypes = db
      .prepare("SELECT name, available_models FROM agent_types")
      .all() as { name: string; available_models: string }[];

    const availableTypes = agentTypes.map((t) => t.name);
    const currentType = agentTypes.find((t) => t.name === config.agent_type);
    let availableModels: unknown[] = [];
    if (currentType) {
      try {
        availableModels = JSON.parse(currentType.available_models);
      } catch { /* ignore invalid JSON */ }
    }

    return Response.json({
      ...config,
      available_types: availableTypes,
      available_models: availableModels,
    });
  });

  // PUT config
  addRoute("PUT", "/api/skipper/config", async (req) => {
    const body = await parseBody(req);

    // Validate agent_type if provided
    if (body.agent_type) {
      const typeExists = db
        .prepare("SELECT name FROM agent_types WHERE name = ?")
        .get(body.agent_type);
      if (!typeExists) {
        return Response.json(
          { error: `Unknown agent type: ${body.agent_type}` },
          { status: 400 },
        );
      }
    }

    const config = updateSkipperConfig(
      {
        agent_type: body.agent_type || undefined,
        model: body.model || undefined,
      },
      db,
    );

    if (req.headers.get("HX-Request")) {
      // Re-render the skipper config page content
      const { skipperConfigPage } = await import("../html/components");
      const agentTypes = db
        .prepare("SELECT name, available_models FROM agent_types")
        .all() as { name: string; available_models: string }[];
      return html(skipperConfigPage(config, agentTypes));
    }

    return Response.json(config);
  });
}
