import type { Database } from "bun:sqlite";
import { addDataRoute } from "./auth";
import {
  fetchDashboardPhaseIndicatorTask,
  getPollIntervalSeconds,
} from "../pages";

const DASHBOARD_TIMELINE_LIMIT = 250;

function fetchDashboardRunningInstances(db: Database) {
  return db.prepare(
    `SELECT ai.id, ai.template_agent_id, COALESCE(a.name, ai.template_agent_id) AS template_agent_name, ai.task_id, t.title AS task_title,
            ai.status, ai.parent_instance_id, ai.root_instance_id, ai.created_at, ai.updated_at
     FROM agent_instances ai
     LEFT JOIN agents a ON a.id = ai.template_agent_id
     LEFT JOIN tasks t ON t.id = ai.task_id
     WHERE ai.status IN ('running', 'waiting_delegation')
     ORDER BY ai.updated_at DESC`,
  ).all();
}

function ok(data: unknown): Response {
  return Response.json({ ok: true, data });
}

export function registerDataDashboardRoutes(db: Database, _daemon?: unknown): void {

  // GET /data/dashboard/active-tasks
  addDataRoute("GET", "/data/dashboard/active-tasks", () => {
    const tasks = db.prepare(
      `SELECT id, title, status, task_type, created_at
       FROM tasks
       WHERE status IN ('running', 'approved', 'completed')
       ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC`,
    ).all() as { id: string; title: string; status: string; task_type?: string; created_at?: string }[];
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
    const mttrRow = db.prepare(
      `SELECT AVG((julianday(completed_at) - julianday(started_at)) * 24 * 60) as mttr
       FROM tasks
       WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
         AND completed_at > datetime('now', '-7 days')`,
    ).get() as { mttr: number | null } | null;

    const stuckRow = db.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN unixepoch('now') - unixepoch(updated_at) > 600 THEN 1 ELSE 0 END) as stuck
       FROM tasks WHERE status = 'running'`,
    ).get() as { total: number; stuck: number };

    const delegationRow = db.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as succeeded
       FROM delegations
       WHERE created_at > datetime('now', '-7 days')`,
    ).get() as { total: number; succeeded: number };

    const remediationCount = (db.prepare(
      "SELECT COUNT(*) as count FROM events WHERE type LIKE 'remediation:%' AND created_at > datetime('now', '-24 hours')",
    ).get() as { count: number }).count;

    return ok({
      mttr_minutes: mttrRow?.mttr ?? null,
      stuck_task_count: stuckRow.stuck ?? 0,
      total_running_tasks: stuckRow.total ?? 0,
      delegation_success_rate: delegationRow.total > 0 ? delegationRow.succeeded / delegationRow.total : null,
      remediation_event_count: remediationCount,
    });
  });

  // GET /data/dashboard/realtime-timeline
  addDataRoute("GET", "/data/dashboard/realtime-timeline", () => {
    const activeRealtimeTask = db.prepare(
      `SELECT id, title
       FROM tasks
       WHERE task_type = 'real_time'
         AND status IN ('running', 'approved')
       ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1`,
    ).get() as { id: string; title: string } | null;

    if (!activeRealtimeTask) return ok(null);

    const entries = db.prepare(
      `SELECT id, entry_type, content, created_at
       FROM realtime_timeline
       WHERE task_id = ?
       ORDER BY created_at DESC
       LIMIT ${DASHBOARD_TIMELINE_LIMIT}`,
    ).all(activeRealtimeTask.id) as { id: string; entry_type: string; content: string; created_at: string }[];

    return ok({
      task_id: activeRealtimeTask.id,
      task_title: activeRealtimeTask.title,
      entries,
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
