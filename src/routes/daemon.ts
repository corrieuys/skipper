import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { dashboardPage } from "../html/components";
import type { DashboardData } from "../html/components";
import type { ManagerDaemon } from "../agents/manager-daemon";

function buildDashboardResponse(daemon: ManagerDaemon): Response {
  const db = getDb();
  const tasks = db.prepare("SELECT id, title, status, priority FROM tasks ORDER BY priority, created_at DESC").all() as DashboardData["tasks"];
  const agents = db.prepare("SELECT id, name, status, type, current_task_id FROM agents ORDER BY created_at").all() as DashboardData["agents"];
  const daemonStatus = daemon.getStatus();
  const html = dashboardPage({ tasks, agents, daemon: daemonStatus });
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
