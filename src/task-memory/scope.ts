import type { Database } from "bun:sqlite";
import { parseJsonOr } from "../db/json";

/**
 * Where a task's memory lives.
 *
 * A one-off task owns its own scope (`task:<id>`, on/off via
 * `task_config.memory_enabled`). A run of a recurring task follows the
 * series' setting (`scheduled_tasks.task_config.memory_mode`): `off`, `run`
 * (each run its own `task:<id>` scope) or `shared` (every run writes to and
 * reads from `series:<scheduled_task_id>`). The series is read live, never the
 * run's snapshot of the config, so flipping the series applies to runs already
 * in flight and a run can never diverge from its series.
 */
export type MemoryMode = "off" | "run" | "shared";

export const MEMORY_MODES: readonly MemoryMode[] = ["off", "run", "shared"] as const;

export function isMemoryMode(value: unknown): value is MemoryMode {
  return value === "off" || value === "run" || value === "shared";
}

export interface SeriesMemoryConfig {
  mode: MemoryMode;
  /** 0 = keep forever. */
  retentionDays: number;
}

export interface MemoryScope {
  taskId: string;
  mode: MemoryMode;
  /** `task:<taskId>` or `series:<scheduledTaskId>`; null when mode is off. */
  scopeId: string | null;
  /** The recurring series this task is a run of, if any. */
  seriesId: string | null;
  retentionDays: number;
}

export function seriesScopeId(seriesId: string): string {
  return `series:${seriesId}`;
}

export function taskScopeId(taskId: string): string {
  return `task:${taskId}`;
}

export function readSeriesMemoryConfig(config: Record<string, unknown> | null | undefined): SeriesMemoryConfig {
  const mode = isMemoryMode(config?.memory_mode) ? config!.memory_mode : "off";
  const days = Number(config?.memory_retention_days);
  return { mode, retentionDays: Number.isFinite(days) && days > 0 ? Math.floor(days) : 0 };
}

export function seriesMemoryConfig(db: Database, seriesId: string): SeriesMemoryConfig | null {
  const row = db.prepare("SELECT task_config FROM scheduled_tasks WHERE id = ?").get(seriesId) as { task_config: string | null } | null;
  if (!row) return null;
  return readSeriesMemoryConfig(parseJsonOr<Record<string, unknown>>(row.task_config, {}));
}

export function resolveMemoryScope(db: Database, taskId: string): MemoryScope {
  const row = db
    .prepare("SELECT task_config, source_scheduled_task_id FROM tasks WHERE id = ?")
    .get(taskId) as { task_config: string | null; source_scheduled_task_id: string | null } | null;
  if (!row) return { taskId, mode: "off", scopeId: null, seriesId: null, retentionDays: 0 };

  const seriesId = row.source_scheduled_task_id;
  if (seriesId) {
    const series = seriesMemoryConfig(db, seriesId);
    if (series) {
      return {
        taskId,
        mode: series.mode,
        scopeId: series.mode === "shared" ? seriesScopeId(seriesId) : series.mode === "run" ? taskScopeId(taskId) : null,
        seriesId,
        retentionDays: series.mode === "shared" ? series.retentionDays : 0,
      };
    }
    // Series deleted: fall through to the run's own snapshot below.
  }

  const config = parseJsonOr<Record<string, unknown>>(row.task_config, {});
  const snapshot = readSeriesMemoryConfig(config);
  const enabled = config.memory_enabled === true || snapshot.mode !== "off";
  return {
    taskId,
    mode: enabled ? "run" : "off",
    scopeId: enabled ? taskScopeId(taskId) : null,
    seriesId,
    retentionDays: 0,
  };
}

/** Short label stored on each memory row so attribution survives run deletion. */
export function runLabelFor(db: Database, taskId: string): string {
  const row = db
    .prepare("SELECT title, started_at, created_at FROM tasks WHERE id = ?")
    .get(taskId) as { title: string; started_at: string | null; created_at: string } | null;
  if (!row) return taskId;
  const when = (row.started_at ?? row.created_at ?? "").slice(0, 16);
  // Recurring runs are titled "<series> (<time>)" already; do not stamp twice.
  if (!when || row.title.includes(when)) return row.title;
  return `${row.title} (${when})`;
}
