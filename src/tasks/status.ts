import type { Database } from "bun:sqlite";

/**
 * Presentation status for the unified task model. Stored status is only
 * draft | active | settled; everything else is derived from runtime state.
 * The stored `settled` state presents as plain Completed (or Failed when the
 * result carries an error) — "settled" is an internal resting state, not a
 * user-facing concept. Input to a completed/failed task revives it.
 */
export type TaskDisplayStatus =
  | "draft"
  | "queued"    // active: wake pending or first run not started
  | "working"   // active: live agents or open delegations
  | "idle"      // active: at rest, wake with input
  | "paused"
  | "review"    // active: waiting on a phase review
  | "blocked"   // active: open escalation
  | "completed" // settled without an error result
  | "failed";   // settled with an error result

export interface TaskStatusRow {
  id: string;
  status: string;
  paused?: number | boolean | null;
  needs_review?: number | boolean | null;
  wake_requested_at?: string | null;
  started_at?: string | null;
  /** Raw result JSON (string) or parsed object; used to split completed vs failed. */
  result?: unknown;
}

/** True when a task result JSON (string or parsed) carries an .error. */
export function resultHasError(result: unknown): boolean {
  if (result == null) return false;
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result);
      return !!(parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).error != null);
    } catch {
      return false;
    }
  }
  if (typeof result === "object") {
    return (result as Record<string, unknown>).error != null;
  }
  return false;
}

/**
 * Derive the display status for a task row. Pass the row fields when you have
 * them (list queries); missing fields are fetched. Ordering matters:
 * paused > blocked > review > working > queued > idle.
 */
export function deriveDisplayStatus(db: Database, row: TaskStatusRow): TaskDisplayStatus {
  if (row.status === "draft") return "draft";
  if (row.status === "settled") return resultHasError(row.result) ? "failed" : "completed";
  if (row.paused) return "paused";

  const openEscalation = db
    .prepare("SELECT 1 FROM escalations WHERE task_id = ? AND status = 'open' LIMIT 1")
    .get(row.id);
  if (openEscalation) return "blocked";
  if (row.needs_review) return "review";

  const live = db
    .prepare(
      `SELECT 1 FROM agent_instances WHERE task_id = ? AND status IN ('running', 'waiting_delegation', 'pending') LIMIT 1`,
    )
    .get(row.id);
  if (live) return "working";
  const openDelegation = db
    .prepare("SELECT 1 FROM delegations WHERE task_id = ? AND status IN ('pending', 'running') LIMIT 1")
    .get(row.id);
  if (openDelegation) return "working";

  if (row.wake_requested_at || !row.started_at) return "queued";
  return "idle";
}

/** Human label for a display status (UI chips). */
export function displayStatusLabel(display: TaskDisplayStatus): string {
  switch (display) {
    case "draft": return "Draft";
    case "queued": return "Queued";
    case "working": return "Working";
    case "idle": return "Idle";
    case "paused": return "Paused";
    case "review": return "Review";
    case "blocked": return "Blocked";
    case "completed": return "Completed";
    case "failed": return "Failed";
  }
}
