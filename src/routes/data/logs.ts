import { addDataRoute } from "./auth";
import { getDb } from "../../db/connection";
import { parseJsonOr } from "../../db/json";

function ok(data: unknown, status: number = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function parseLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  const n = raw ? parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export function registerDataLogRoutes(): void {
  addDataRoute("GET", "/data/logs", (req) => {
    const url = new URL(req.url);
    const conditions: string[] = ["1=1"];
    const params: (string | number)[] = [];

    const category = url.searchParams.get("category");
    if (category) {
      conditions.push("category = ?");
      params.push(category);
    }
    // error_log has no task_id column — logError stashes it in the context JSON.
    const taskId = url.searchParams.get("task_id");
    if (taskId) {
      conditions.push("json_extract(context, '$.taskId') = ?");
      params.push(taskId);
    }
    params.push(parseLimit(url));

    const rows = getDb()
      .prepare(
        `SELECT id, category, message, context, stack, created_at
         FROM error_log WHERE ${conditions.join(" AND ")}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...params) as Array<{ context: string } & Record<string, unknown>>;

    return ok(rows.map((r) => ({ ...r, context: parseJsonOr<Record<string, unknown>>(r.context, {}) })));
  });

  addDataRoute("GET", "/data/events", (req) => {
    const url = new URL(req.url);
    const conditions: string[] = ["1=1"];
    const params: (string | number)[] = [];

    const type = url.searchParams.get("type");
    if (type) {
      conditions.push("type = ?");
      params.push(type);
    }
    const taskId = url.searchParams.get("task_id");
    if (taskId) {
      conditions.push("task_id = ?");
      params.push(taskId);
    }
    params.push(parseLimit(url));

    const rows = getDb()
      .prepare(
        `SELECT id, type, payload, source_agent_id, task_id, created_at
         FROM events WHERE ${conditions.join(" AND ")}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...params) as Array<{ payload: string } & Record<string, unknown>>;

    return ok(rows.map((r) => ({ ...r, payload: parseJsonOr<Record<string, unknown>>(r.payload, {}) })));
  });
}
