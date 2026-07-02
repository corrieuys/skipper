// Shared writers for agent_instances.status — one place for the
// status + updated_at (+ optional pid-clear) update every manager repeats.
import type { Database } from "bun:sqlite";

export type AgentInstanceStatus =
  | "pending"
  | "running"
  | "waiting_delegation"
  | "completed"
  | "failed"
  | "stopped";

/** Set one instance's status, bumping updated_at. Optionally clears process_pid. */
export function updateInstanceStatus(
  db: Database,
  instanceId: string,
  status: AgentInstanceStatus,
  opts?: { clearPid?: boolean },
): void {
  const pidClause = opts?.clearPid ? ", process_pid = NULL" : "";
  db.prepare(
    `UPDATE agent_instances SET status = ?${pidClause}, updated_at = datetime('now') WHERE id = ?`,
  ).run(status, instanceId);
}

/** Mark every still-active instance of a task stopped/failed and clear pids. */
export function finalizeActiveInstancesForTask(
  db: Database,
  taskId: string,
  status: "stopped" | "failed",
): void {
  db.prepare(
    `UPDATE agent_instances SET status = ?, process_pid = NULL, updated_at = datetime('now')
     WHERE task_id = ? AND status IN ('running', 'waiting_delegation', 'pending')`,
  ).run(status, taskId);
}
