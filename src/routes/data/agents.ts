import type { Database } from "bun:sqlite";
import { addRoute } from "../../server";
import { AgentManager } from "../../agents/manager";
import type { ManagerDaemon } from "../../agents/manager-daemon";
import { parseRequestBody } from "../utils";

function ok(data: unknown, status: number = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

function err(message: string, status: number = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export function registerDataAgentRoutes(
  db: Database,
  daemon?: Pick<ManagerDaemon, "listRuntimeSteeringOptions" | "steerRuntime">,
): void {
  const manager = new AgentManager(db);

  // GET /data/agents — list agents
  addRoute("GET", "/data/agents", () => {
    const agents = manager.listAgents();
    return ok(agents);
  });

  // GET /data/agents/:id — agent detail
  addRoute("GET", "/data/agents/:id", (_req, params) => {
    const row = db.prepare(
      `SELECT a.*,
         (SELECT COUNT(*) FROM agent_instances ai WHERE ai.template_agent_id = a.id AND ai.status IN ('running', 'waiting_delegation')) AS running_instance_count
       FROM agents a WHERE a.id = ?`,
    ).get(params.id) as Record<string, unknown> | null;
    if (!row) return err("Agent not found", 404);
    const agent = {
      ...row,
      config: JSON.parse(String(row.config ?? "{}")),
      capabilities: JSON.parse(String(row.capabilities ?? "[]")),
    };
    return ok(agent);
  });

  // GET /data/agents/:id/instances — active instances
  addRoute("GET", "/data/agents/:id/instances", (_req, params) => {
    const rows = db.prepare(
      `SELECT ai.id, ai.status, ai.task_id, t.title AS task_title, ai.created_at
       FROM agent_instances ai
       LEFT JOIN tasks t ON t.id = ai.task_id
       WHERE ai.template_agent_id = ? AND ai.status IN ('running', 'waiting_delegation')
       ORDER BY ai.created_at DESC`,
    ).all(params.id) as { id: string; status: string; task_id: string; task_title: string; created_at: string }[];

    const steeringById = new Map(
      (daemon?.listRuntimeSteeringOptions(params.id) ?? []).map((option) => [option.id, option]),
    );

    const instances = rows.map((row) => {
      const steering = steeringById.get(row.id);
      return {
        ...row,
        can_steer: steering?.can_steer ?? false,
        disabled_reason: steering?.disabled_reason ?? null,
        session_id: steering?.session_id ?? null,
      };
    });

    return ok(instances);
  });

  // GET /data/agents/:id/output — terminal output
  addRoute("GET", "/data/agents/:id/output", (req, params) => {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("session");

    const runtimeRows = db.prepare(
      `SELECT id FROM agent_instances WHERE template_agent_id = ? ORDER BY created_at DESC`,
    ).all(params.id) as { id: string }[];
    const runtimeIds = [params.id, ...runtimeRows.map((r) => r.id)];
    const runtimePlaceholders = runtimeIds.map(() => "?").join(",");

    let rows: { stream: string; data: string; sequence: number }[];
    if (sessionId) {
      const sessionOwner = db.prepare(
        "SELECT agent_id FROM agent_sessions WHERE id = ?",
      ).get(sessionId) as { agent_id: string } | null;
      if (!sessionOwner || !runtimeIds.includes(sessionOwner.agent_id)) {
        return ok([]);
      }
      rows = db.prepare(
        "SELECT stream, data, sequence FROM terminal_outputs WHERE agent_id = ? AND session_id = ? ORDER BY sequence",
      ).all(sessionOwner.agent_id, sessionId) as { stream: string; data: string; sequence: number }[];
    } else {
      const latestSession = db.prepare(
        `SELECT id, agent_id FROM agent_sessions WHERE agent_id IN (${runtimePlaceholders}) ORDER BY created_at DESC LIMIT 1`,
      ).get(...runtimeIds) as { id: string; agent_id: string } | null;

      if (latestSession) {
        rows = db.prepare(
          "SELECT stream, data, sequence FROM terminal_outputs WHERE agent_id = ? AND session_id = ? ORDER BY sequence",
        ).all(latestSession.agent_id, latestSession.id) as { stream: string; data: string; sequence: number }[];
      } else {
        rows = (db.prepare(
          `SELECT stream, data, sequence FROM terminal_outputs WHERE agent_id IN (${runtimePlaceholders}) ORDER BY id DESC LIMIT 400`,
        ).all(...runtimeIds) as { stream: string; data: string; sequence: number }[]).reverse();
      }
    }

    return ok(rows);
  });

  // POST /data/agents/:id/steer — steering message
  addRoute("POST", "/data/agents/:id/steer", async (req, params) => {
    if (!daemon) return err("Runtime steering is unavailable", 503);
    const body = await parseRequestBody<Record<string, string>>(req);
    const runtimeId = body.runtime_id?.trim();
    const message = body.message?.trim();
    if (!runtimeId) return err("runtime_id is required");
    if (!message) return err("message is required");
    try {
      await daemon.steerRuntime(params.id, runtimeId, message);
      return ok(null);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

}
