import { addRoute } from "../server";
import { AgentManager } from "../agents/manager";
import type { ManagerDaemon } from "../agents/manager-daemon";
import { parseRequestBody } from "./utils";

export function registerAgentRoutes(
  daemon?: Pick<ManagerDaemon, "listRuntimeSteeringOptions" | "steerRuntime" | "getStatus">,
): void {
  const manager = new AgentManager();

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

  addRoute("POST", "/api/agents/:id/steer", async (req, params) => {
    if (!daemon) {
      return Response.json({ error: "Runtime steering is unavailable" }, { status: 503 });
    }

    const body = await parseRequestBody<Record<string, string>>(req);
    const runtimeId = body.runtime_id?.trim();
    const message = body.message?.trim();
    if (!runtimeId) {
      return Response.json({ error: "runtime_id is required" }, { status: 400 });
    }
    if (!message) {
      return Response.json({ error: "message is required" }, { status: 400 });
    }

    try {
      await daemon.steerRuntime(params.id, runtimeId, message);
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const messageText = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: messageText }, { status: 400 });
    }
  });
}
