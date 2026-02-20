import type { Database } from "bun:sqlite";
import { addRoute } from "../server";
import { getDb } from "../db/connection";

interface EventRow {
  id: number;
  type: string;
  payload: string;
  source_agent_id: string | null;
  task_id: string | null;
  created_at: string;
}

export function registerEventRoutes(db?: Database): void {
  const resolvedDb = db ?? getDb();

  addRoute("GET", "/api/events", (req) => {
    const url = new URL(req.url);
    const limitParam = url.searchParams.get("limit");
    const limit = Math.min(Math.max(parseInt(limitParam ?? "50", 10) || 50, 1), 500);

    const rows = resolvedDb
      .prepare(
        "SELECT id, type, payload, source_agent_id, task_id, created_at FROM events ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as EventRow[];

    const events = rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: (() => {
        try {
          return JSON.parse(row.payload);
        } catch {
          return row.payload;
        }
      })(),
      source_agent_id: row.source_agent_id,
      task_id: row.task_id,
      created_at: row.created_at,
    }));

    return Response.json(events);
  });
}
