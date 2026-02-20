import { addRoute } from "../server";
import { AgentManager } from "../agents/manager";
import { agentListFragment, agentsPage } from "../html/components";
import type { AgentData } from "../html/components";

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

    try {
      manager.createAgent({
        name: body.name,
        type: body.type,
        model: body.model,
        capabilities: body.capabilities ? JSON.parse(body.capabilities) : undefined,
        goal: body.goal,
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
