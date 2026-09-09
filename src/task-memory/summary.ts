import type { Database } from "bun:sqlite";
import { resolveMemoryScope, type MemoryMode } from "./scope";

/**
 * Memory summary for the task details pane, the recurring series panel and
 * `tasks/read`.
 *
 * Pure SQL aggregates, no per-row bookkeeping: SQLite keeps each value's
 * stored size in the record header, so `length(<blob>)` is read without
 * loading the payload, and a scope holds hundreds to a few thousand rows.
 * Text size is measured as UTF-8 bytes (`CAST(content AS BLOB)`), vector size
 * as the stored float32 blob. Soft-deleted rows are counted separately and
 * excluded from every other figure.
 */
export interface TaskMemorySummary {
  enabled: boolean;
  /** off | run | shared (see scope.ts). */
  mode: MemoryMode;
  /** `task:<id>` or `series:<id>`; null when off. */
  scope_id: string | null;
  /** Distinct runs that contributed live entries (1 for a one-off task). */
  runs: number;
  /** Live rows in the scope. */
  entries: number;
  /** Live rows carrying a vector. */
  vectors: number;
  /** Live rows still waiting for an embedding (or embedded under another model). */
  pending: number;
  /** Rows soft-deleted by agents (kept for audit). */
  deleted: number;
  /** Embedding models the stored vectors were produced with (normally one). */
  models: string[];
  /** Vector width, from the stored blob; null when no vector exists yet. */
  dims: number | null;
  content_bytes: number;
  vector_bytes: number;
  total_bytes: number;
  by_kind: Record<string, number>;
  by_author: Record<string, number>;
  oldest_at: string | null;
  newest_at: string | null;
  /** Series retention window in days (0 = keep). */
  retention_days: number;
}

export function taskMemorySummary(db: Database, taskId: string): TaskMemorySummary {
  const scope = resolveMemoryScope(db, taskId);
  // A task whose memory was turned off keeps its rows until cleared; report them.
  const scopeId = scope.scopeId ?? `task:${taskId}`;
  return scopeSummary(db, scopeId, { enabled: scope.scopeId !== null, mode: scope.mode, retentionDays: scope.retentionDays });
}

export function scopeSummary(
  db: Database,
  scopeId: string,
  meta: { enabled: boolean; mode: MemoryMode; retentionDays: number },
): TaskMemorySummary {
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS entries,
              COUNT(DISTINCT task_id) AS runs,
              SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS vectors,
              COALESCE(SUM(length(CAST(content AS BLOB))), 0) AS content_bytes,
              COALESCE(SUM(length(embedding)), 0) AS vector_bytes,
              MAX(length(embedding)) AS max_vector_bytes,
              MIN(created_at) AS oldest_at,
              MAX(created_at) AS newest_at
       FROM task_memory WHERE scope_id = ? AND deleted_at IS NULL`,
    )
    .get(scopeId) as { entries: number; runs: number; vectors: number | null; content_bytes: number; vector_bytes: number; max_vector_bytes: number | null; oldest_at: string | null; newest_at: string | null };
  const deleted = (db.prepare("SELECT COUNT(*) AS n FROM task_memory WHERE scope_id = ? AND deleted_at IS NOT NULL").get(scopeId) as { n: number }).n;

  const models = (db
    .prepare("SELECT DISTINCT embedding_model AS m FROM task_memory WHERE scope_id = ? AND deleted_at IS NULL AND embedding IS NOT NULL AND embedding_model IS NOT NULL ORDER BY m")
    .all(scopeId) as { m: string }[]).map((r) => r.m);

  const byKind: Record<string, number> = {};
  for (const r of db.prepare("SELECT kind, COUNT(*) AS n FROM task_memory WHERE scope_id = ? AND deleted_at IS NULL GROUP BY kind").all(scopeId) as { kind: string; n: number }[]) {
    byKind[r.kind] = r.n;
  }
  const byAuthor: Record<string, number> = {};
  for (const r of db.prepare("SELECT author, COUNT(*) AS n FROM task_memory WHERE scope_id = ? AND deleted_at IS NULL GROUP BY author").all(scopeId) as { author: string; n: number }[]) {
    byAuthor[r.author] = r.n;
  }

  const vectors = agg.vectors ?? 0;
  return {
    enabled: meta.enabled,
    mode: meta.mode,
    scope_id: meta.enabled ? scopeId : null,
    runs: agg.runs,
    entries: agg.entries,
    vectors,
    pending: agg.entries - vectors,
    deleted,
    models,
    dims: agg.max_vector_bytes ? Math.floor(agg.max_vector_bytes / 4) : null,
    content_bytes: agg.content_bytes,
    vector_bytes: agg.vector_bytes,
    total_bytes: agg.content_bytes + agg.vector_bytes,
    by_kind: byKind,
    by_author: byAuthor,
    oldest_at: agg.oldest_at,
    newest_at: agg.newest_at,
    retention_days: meta.retentionDays,
  };
}
