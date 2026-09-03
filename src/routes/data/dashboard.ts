import type { Database } from "bun:sqlite";
import { addDataRoute } from "./auth";
import {
  fetchDashboardPhaseIndicatorTask,
  getPollIntervalSeconds,
  fetchDashboardMetrics,
  fetchDashboardRunningInstances,
  fetchDashboardRealtimeTimeline,
} from "../../data/queries";
import { ok } from "./envelope";

export function registerDataDashboardRoutes(db: Database, _daemon?: unknown): void {

  // GET /data/dashboard/active-tasks
  // Active tasks first (started before queued), then settled-without-error
  // (the old 'completed'); settled-with-error rows are excluded like the old
  // 'failed' status was.
  addDataRoute("GET", "/data/dashboard/active-tasks", () => {
    const tasks = db.prepare(
      `SELECT id, title, status, mode, created_at
       FROM tasks
       WHERE status = 'active'
          OR (status = 'settled' AND (result IS NULL OR json_extract(result, '$.error') IS NULL))
       ORDER BY CASE
         WHEN status = 'active' AND started_at IS NOT NULL THEN 0
         WHEN status = 'active' THEN 1
         ELSE 2
       END, created_at DESC`,
    ).all() as { id: string; title: string; status: string; mode?: string; created_at?: string }[];
    return ok(tasks);
  });

  // GET /data/dashboard/running-instances
  addDataRoute("GET", "/data/dashboard/running-instances", () => {
    const runningInstances = fetchDashboardRunningInstances(db);
    return ok({ running_instances: runningInstances });
  });

  // GET /data/dashboard/running-instances-count
  addDataRoute("GET", "/data/dashboard/running-instances-count", () => {
    const runningInstances = fetchDashboardRunningInstances(db);
    return ok({ total: runningInstances.length, active_count: runningInstances.length });
  });

  // GET /data/dashboard/metrics
  addDataRoute("GET", "/data/dashboard/metrics", () => {
    return ok(fetchDashboardMetrics(db));
  });

  // GET /data/dashboard/realtime-timeline
  addDataRoute("GET", "/data/dashboard/realtime-timeline", () => {
    const timeline = fetchDashboardRealtimeTimeline(db);
    if (!timeline) return ok(null);
    // Wire shape predates the shared fetcher — keep snake_case keys.
    return ok({
      task_id: timeline.taskId,
      task_title: timeline.taskTitle,
      entries: timeline.entries,
    });
  });

  // GET /data/dashboard/phase-indicator
  addDataRoute("GET", "/data/dashboard/phase-indicator", () => {
    const phaseIndicatorTask = fetchDashboardPhaseIndicatorTask(db);
    return ok(phaseIndicatorTask);
  });

  // GET /data/dashboard/notes
  addDataRoute("GET", "/data/dashboard/notes", () => {
    const notes = db.prepare(
      `SELECT n.*, a.name AS agent_name
       FROM task_notes n
       LEFT JOIN agents a ON a.id = n.agent_id
       ORDER BY n.created_at DESC
       LIMIT 30`,
    ).all() as { id: string; task_id: string; agent_id: string; agent_name: string; content: string; created_at: string }[];
    return ok(notes);
  });

  // GET /data/dashboard/active-agents-count
  addDataRoute("GET", "/data/dashboard/active-agents-count", () => {
    const pollInterval = getPollIntervalSeconds(db);
    const runningInstances = fetchDashboardRunningInstances(db);
    return ok({ running_instances: runningInstances, active_count: runningInstances.length, poll_interval_seconds: pollInterval });
  });
}
