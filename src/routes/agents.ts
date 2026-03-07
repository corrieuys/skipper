import { addRoute } from "../server";
import { AgentManager } from "../agents/manager";
import { getDb } from "../db/connection";
import { agentDetailPage, agentListFragment, agentsPage } from "../html/components";
import type { AgentData, AgentSessionData } from "../html/components";
import { getPollIntervalSeconds } from "./pages";

function htmlResponse(content: string, status = 200): Response {
  return new Response(content, {
    status,
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

export function registerAgentRoutes(): void {
  const manager = new AgentManager();

  addRoute("POST", "/api/agents", async (req) => {
    const body = await parseBody(req);

    if (!body.name || !body.type) {
      return Response.json(
        { error: "name and type are required" },
        { status: 400 },
      );
    }
    if (Object.prototype.hasOwnProperty.call(body, "goal")) {
      return Response.json(
        { error: "goal is no longer supported; use instruction" },
        { status: 400 },
      );
    }

    try {
      manager.createAgent({
        name: body.name,
        type: body.type,
        model: body.model,
        capabilities: body.capabilities ? JSON.parse(body.capabilities) : undefined,
        instruction: body.instruction,
      });
      const agents = manager.listAgents() as unknown as AgentData[];
      return htmlResponse(agentListFragment(agents), 201);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("GET", "/api/agents", () => {
    const agents = manager.listAgents();
    return Response.json(agents);
  });

  addRoute("GET", "/api/agents/:id", (_req, params) => {
    const agent = manager.getAgent(params.id);
    if (!agent) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    return Response.json(agent);
  });

  addRoute("POST", "/api/agents/:id", async (req, params) => {
    const body = await parseBody(req);

    if (!body.name || !body.type) {
      return Response.json(
        { error: "name and type are required" },
        { status: 400 },
      );
    }
    if (Object.prototype.hasOwnProperty.call(body, "goal")) {
      return Response.json(
        { error: "goal is no longer supported; use instruction" },
        { status: 400 },
      );
    }

    try {
      const updated = manager.updateAgent(params.id, {
        name: body.name,
        type: body.type,
        model: body.model,
        instruction: body.instruction,
        capabilities: body.capabilities ? JSON.parse(body.capabilities) : undefined,
      }) as unknown as AgentData;

      if (req.headers.get("HX-Request")) {
        const db = getDb();
        const sessions = db.prepare(
          "SELECT id, created_at FROM agent_sessions WHERE agent_id = ? ORDER BY created_at DESC",
        ).all(updated.id) as AgentSessionData[];
        return htmlResponse(agentDetailPage(updated, sessions, undefined, getPollIntervalSeconds(db)));
      }

      return Response.json(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("DELETE", "/api/agents/:id", (_req, params) => {
    try {
      const deleted = manager.deleteAgent(params.id);
      if (!deleted) {
        return Response.json({ error: "Agent not found" }, { status: 404 });
      }
      const agents = manager.listAgents() as unknown as AgentData[];
      return htmlResponse(agentsPage(agents));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });
}
