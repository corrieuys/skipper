import type { Database } from "bun:sqlite";
import { eventBus } from "../events/bus";

/**
 * System-driven escalation close (task settled / cancelled / no longer active).
 * Same write as the bulk UPDATE it replaces, but row by row so each closed
 * escalation is announced with `escalation:resolved`. Without the event every
 * surface (web Needs-you group, TUI, apps) kept showing the task as blocked.
 * An existing response is kept; `response` is only the fallback text. The
 * event carries `auto: true`, so user hooks and notification sounds (which mean
 * "the operator answered") stay quiet.
 *
 * `scopeSql` narrows which open escalations close, e.g. `task_id = ?` or
 * `task_id IN (SELECT id FROM tasks WHERE status = 'settled')`.
 */
export function autoResolveEscalations(db: Database, scopeSql: string, params: Array<string | number>, response: string): number {
  const rows = db
    .prepare(`SELECT id, agent_id, task_id FROM escalations WHERE status = 'open' AND ${scopeSql}`)
    .all(...params) as Array<{ id: string; agent_id: string; task_id: string }>;
  if (rows.length === 0) return 0;
  const update = db.prepare(
    "UPDATE escalations SET status = 'resolved', response = COALESCE(response, ?), resolved_at = datetime('now') WHERE id = ? AND status = 'open'",
  );
  let closed = 0;
  for (const row of rows) {
    const res = update.run(response, row.id);
    if (Number(res.changes ?? 0) === 0) continue;
    closed++;
    const stored = db.prepare("SELECT response FROM escalations WHERE id = ?").get(row.id) as { response: string | null } | null;
    eventBus.emit("escalation:resolved", {
      escalationId: row.id,
      agentId: row.agent_id,
      taskId: row.task_id,
      response: stored?.response ?? response,
      auto: true,
    });
  }
  return closed;
}
