// Shared writers for agent_instances.status — one place for the
// status + updated_at (+ optional pid-clear) update every manager repeats.
import type { Database } from "bun:sqlite";
import { eventBus } from "../events/bus";

export type AgentInstanceStatus =
  | "pending"
  | "running"
  | "waiting_delegation"
  | "completed"
  | "failed"
  | "stopped";

/**
 * Announce an instance's CURRENT stored status on the bus. Every surface (web
 * roster + header metrics, Canvas, Connect fat events, the TUI) reconciles agent
 * liveness from `instance:state_changed`; a status write that skips it leaves a
 * ghost "working" agent until some unrelated event forces a re-push. Call it
 * after any raw `UPDATE agent_instances SET status ...` that does not go through
 * `updateInstanceStatus`. Listeners only push / forward; none mutates state.
 * Returns false (and emits nothing) when there is no such row.
 */
export function emitInstanceState(db: Database, instanceId: string): boolean {
  const row = db
    .prepare("SELECT template_agent_id, task_id, parent_instance_id, root_instance_id, status FROM agent_instances WHERE id = ?")
    .get(instanceId) as
    | { template_agent_id: string; task_id: string; parent_instance_id: string | null; root_instance_id: string | null; status: string }
    | null;
  if (!row) return false;
  eventBus.emit("instance:state_changed", {
    instanceId,
    templateAgentId: row.template_agent_id,
    taskId: row.task_id,
    parentInstanceId: row.parent_instance_id ?? null,
    rootInstanceId: row.root_instance_id ?? null,
    status: row.status,
  });
  return true;
}

/**
 * Set one instance's status, bumping updated_at. Optionally clears process_pid.
 * Emits `instance:state_changed` (see `emitInstanceState`): the write and the
 * announcement are one operation, so no caller can forget the event. Returns
 * whether it was announced (false = no such instance row, e.g. a legacy
 * template-runtime id), so a caller that must announce anyway can fall back.
 */
export function updateInstanceStatus(
  db: Database,
  instanceId: string,
  status: AgentInstanceStatus,
  opts?: { clearPid?: boolean },
): boolean {
  const pidClause = opts?.clearPid ? ", process_pid = NULL" : "";
  db.prepare(
    `UPDATE agent_instances SET status = ?${pidClause}, updated_at = datetime('now') WHERE id = ?`,
  ).run(status, instanceId);
  return emitInstanceState(db, instanceId);
}

/** Mark every still-active instance of a task stopped/failed and clear pids. */
export function finalizeActiveInstancesForTask(
  db: Database,
  taskId: string,
  status: "stopped" | "failed",
): void {
  const ids = (db
    .prepare("SELECT id FROM agent_instances WHERE task_id = ? AND status IN ('running', 'waiting_delegation', 'pending')")
    .all(taskId) as Array<{ id: string }>).map((r) => r.id);
  db.prepare(
    `UPDATE agent_instances SET status = ?, process_pid = NULL, updated_at = datetime('now')
     WHERE task_id = ? AND status IN ('running', 'waiting_delegation', 'pending')`,
  ).run(status, taskId);
  for (const id of ids) emitInstanceState(db, id);
}
