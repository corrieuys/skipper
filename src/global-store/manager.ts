import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";

export interface GlobalStoreRow {
  name: string;
  type: string | null;
  data: string | null;
  status: string | null;
  updated_by_agent_id: string | null;
  task_id: string | null;
  updated_at: string;
}

export interface SetGlobalValueInput {
  name: string;
  type?: string | null;
  data?: string | null;
  status?: string | null;
  updatedByAgentId?: string | null;
  taskId?: string | null;
}

export interface GlobalStoreQuery {
  name?: string;
  type?: string;
  status?: string;
  data_contains?: string;
  limit?: number;
}

export class GlobalStoreManager {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDb();
  }

  /**
   * Upsert by name. On update, only columns explicitly provided overwrite the
   * existing row — undefined fields are preserved (COALESCE against existing).
   * `updated_at` always bumps.
   */
  set(input: SetGlobalValueInput): GlobalStoreRow {
    const toParam = (v: string | null | undefined): string | null => (v === undefined ? null : v);
    this.db
      .prepare(
        `INSERT INTO global_store (name, type, data, status, updated_by_agent_id, task_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(name) DO UPDATE SET
           type                = COALESCE(excluded.type, global_store.type),
           data                = COALESCE(excluded.data, global_store.data),
           status              = COALESCE(excluded.status, global_store.status),
           updated_by_agent_id = COALESCE(excluded.updated_by_agent_id, global_store.updated_by_agent_id),
           task_id             = COALESCE(excluded.task_id, global_store.task_id),
           updated_at          = datetime('now')`,
      )
      .run(
        input.name,
        toParam(input.type),
        toParam(input.data),
        toParam(input.status),
        toParam(input.updatedByAgentId),
        toParam(input.taskId),
      );
    return this.get(input.name)!;
  }

  get(name: string): GlobalStoreRow | null {
    const row = this.db
      .prepare("SELECT * FROM global_store WHERE name = ?")
      .get(name) as GlobalStoreRow | null;
    return row ?? null;
  }

  query(q: GlobalStoreQuery = {}): GlobalStoreRow[] {
    const conditions: string[] = ["1=1"];
    const params: (string | number)[] = [];
    if (q.name !== undefined) {
      conditions.push("name = ?");
      params.push(q.name);
    }
    if (q.type !== undefined) {
      conditions.push("type = ?");
      params.push(q.type);
    }
    if (q.status !== undefined) {
      conditions.push("status = ?");
      params.push(q.status);
    }
    if (q.data_contains !== undefined) {
      conditions.push("data LIKE ?");
      params.push(`%${q.data_contains}%`);
    }
    const limit = q.limit ?? 100;
    params.push(limit);
    return this.db
      .prepare(
        `SELECT * FROM global_store WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params) as GlobalStoreRow[];
  }

  delete(name: string): boolean {
    const result = this.db.prepare("DELETE FROM global_store WHERE name = ?").run(name);
    return result.changes > 0;
  }
}
