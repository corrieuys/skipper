import type { Database } from "bun:sqlite";
import { countPendingImprovements } from "../improvements/manager";

/**
 * What waits on the operator, for the top-bar attention indicator
 * (html/fragments/attention.fragment.ts): pending improvements, active tasks at
 * a review gate, and open escalations on active tasks. Each carries the newest
 * task to jump to.
 */
export interface AttentionCounts {
  improvements: number;
  reviews: { count: number; taskId: string | null };
  escalations: { count: number; taskId: string | null };
}

export function fetchAttentionCounts(db: Database): AttentionCounts {
  const reviews = db
    .prepare(
      `SELECT COUNT(*) AS c,
              (SELECT id FROM tasks WHERE status = 'active' AND needs_review = 1 ORDER BY updated_at DESC LIMIT 1) AS task_id
         FROM tasks WHERE status = 'active' AND needs_review = 1`,
    )
    .get() as { c: number; task_id: string | null };
  const escalations = db
    .prepare(
      `SELECT COUNT(*) AS c,
              (SELECT e2.task_id FROM escalations e2 JOIN tasks t2 ON t2.id = e2.task_id
                WHERE e2.status = 'open' AND t2.status = 'active' ORDER BY e2.created_at DESC LIMIT 1) AS task_id
         FROM escalations e JOIN tasks t ON t.id = e.task_id
        WHERE e.status = 'open' AND t.status = 'active'`,
    )
    .get() as { c: number; task_id: string | null };
  return {
    improvements: countPendingImprovements(db),
    reviews: { count: reviews.c, taskId: reviews.task_id },
    escalations: { count: escalations.c, taskId: escalations.task_id },
  };
}
