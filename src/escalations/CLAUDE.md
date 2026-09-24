# src/escalations

| file | use |
|---|---|
| `manager.ts` | Escalation CRUD. `resolveEscalation()` injects response into agent on resume. `dismissEscalation()` no response. Reconcile for inactive/completed tasks |

Trigger: `[ESCALATE] <question>` signal from agent. Surface in UI via `/escalation-queue` page.

`auto-resolve.ts` — `autoResolveEscalations(db, scopeSql, params, response)`: the system-driven close (task settled / cancelled / no longer active; used by `TaskScheduler` and `reconcileOpenEscalationsForInactiveTasks`). Row by row, each close emits `escalation:resolved` with `auto: true` so every surface drops the blocked state; hooks and notification sounds ignore `auto` closes.
