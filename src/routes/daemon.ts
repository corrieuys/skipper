import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { dashboardPage } from "../html/components";
import type { DashboardData } from "../html/components";
import type { ManagerDaemon } from "../agents/manager-daemon";

function buildDashboardResponse(daemon: ManagerDaemon): Response {
  const db = getDb();
  const tasks = db.prepare("SELECT id, title, status, priority FROM tasks ORDER BY priority, created_at DESC").all() as DashboardData["tasks"];
  const agents = db.prepare("SELECT id, name, status, type, current_task_id FROM agents ORDER BY created_at").all() as DashboardData["agents"];
  const runningInstances = db.prepare(
    `SELECT ai.id, ai.template_agent_id, COALESCE(a.name, ai.template_agent_id) AS template_agent_name, ai.task_id, t.title AS task_title,
            ai.status, ai.parent_instance_id, ai.root_instance_id, ai.created_at, ai.updated_at
     FROM agent_instances ai
     LEFT JOIN agents a ON a.id = ai.template_agent_id
     LEFT JOIN tasks t ON t.id = ai.task_id
     WHERE ai.status IN ('running', 'waiting_delegation')
     ORDER BY ai.updated_at DESC`,
  ).all() as DashboardData["runningInstances"];
  const activeDelegationGroups = db.prepare(
    `SELECT id, task_id, parent_instance_id, settled_count, expected_count, failed_count, status, created_at
     FROM delegation_groups
     WHERE status = 'running'
     ORDER BY created_at DESC
     LIMIT 10`,
  ).all() as DashboardData["activeDelegationGroups"];
  const recentLogs = db.prepare(
    `SELECT to2.agent_id,
            COALESCE(a.name, ta.name, ai.template_agent_id, to2.agent_id) as agent_name,
            to2.stream, to2.data, to2.created_at
     FROM terminal_outputs to2
     LEFT JOIN agents a ON to2.agent_id = a.id
     LEFT JOIN agent_instances ai ON to2.agent_id = ai.id
     LEFT JOIN agents ta ON ta.id = ai.template_agent_id
     ORDER BY to2.id DESC LIMIT 10`,
  ).all() as DashboardData["recentLogs"];
  const daemonStatus = daemon.getStatus();
  const html = dashboardPage({ tasks, agents, runningInstances, activeDelegationGroups, recentLogs, daemon: daemonStatus });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function registerDaemonRoutes(daemon: ManagerDaemon): void {
  addRoute("GET", "/api/daemon/status", () => {
    const status = daemon.getStatus();
    return Response.json(status);
  });

  addRoute("POST", "/api/daemon/pause", async (req) => {
    try {
      await daemon.pause();
      if (req.headers.get("HX-Request")) {
        return buildDashboardResponse(daemon);
      }
      return Response.json({ status: "paused" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/daemon/resume", (req) => {
    try {
      daemon.resume();
      if (req.headers.get("HX-Request")) {
        return buildDashboardResponse(daemon);
      }
      return Response.json({ status: "running" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });
}
