import { addRoute } from "../server";
import { AgentManager } from "../agents/manager";

export function registerAgentRoutes(): void {
  const manager = new AgentManager();

  addRoute("POST", "/api/agents", async (req) => {
    const body = await req.json();

    if (!body.name || !body.type) {
      return Response.json(
        { error: "name and type are required" },
        { status: 400 },
      );
    }

    try {
      const agent = manager.createAgent({
        name: body.name,
        type: body.type,
        model: body.model,
        capabilities: body.capabilities,
        goal: body.goal,
      });
      return Response.json(agent, { status: 201 });
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
      return Response.json({ deleted: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });
}
