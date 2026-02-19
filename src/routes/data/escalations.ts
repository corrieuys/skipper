import type { Database } from "bun:sqlite";
import { addRoute } from "../../server";
import type { ManagerDaemon } from "../../agents/manager-daemon";
import { parseRequestBody } from "../utils";

function ok(data: unknown, status: number = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

function err(message: string, status: number = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function fetchOpenEscalations(db: Database) {
  return db.prepare(
    `SELECT e.*, t.status as task_status, t.title as task_title,
            a.name as agent_name
     FROM escalations e
     LEFT JOIN tasks t ON t.id = e.task_id
     LEFT JOIN agents a ON a.id = e.agent_id
     WHERE e.status = 'open'
     ORDER BY e.created_at DESC`,
  ).all() as { id: string; agent_id: string; agent_name: string | null; runtime_agent_id: string | null; task_id: string; task_title: string | null; type: string; severity: string; question: string; status: string; created_at: string; task_status: string }[];
}

export function registerDataEscalationRoutes(db: Database, daemon: ManagerDaemon): void {

  // GET /data/escalations — list open escalations
  addRoute("GET", "/data/escalations", () => {
    daemon.getEscalationManager().reconcileOpenEscalationsForInactiveTasks();
    const escalations = fetchOpenEscalations(db);
    return ok(escalations);
  });

  // POST /data/escalations/:id/resolve — resolve escalation
  addRoute("POST", "/data/escalations/:id/resolve", async (req, params) => {
    const body = await parseRequestBody<Record<string, string>>(req);
    if (!body.response) return err("response is required");
    try {
      await daemon.resolveEscalation(params.id, body.response);
      daemon.getEscalationManager().reconcileOpenEscalationsForInactiveTasks();
      const escalations = fetchOpenEscalations(db);
      return ok(escalations);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });

  // POST /data/escalations/:id/dismiss — dismiss escalation
  addRoute("POST", "/data/escalations/:id/dismiss", (_req, params) => {
    try {
      daemon.getEscalationManager().dismissEscalation(params.id);
      daemon.getEscalationManager().reconcileOpenEscalationsForInactiveTasks();
      const escalations = fetchOpenEscalations(db);
      return ok(escalations);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "Internal error");
    }
  });
}
