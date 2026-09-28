# src/escalations

| file | use |
|---|---|
| `manager.ts` | Escalation CRUD. `createEscalation()` inserts and emits `escalation:created` (the writer announces for every caller, e.g. the idle poke's `idle_poke_exhausted`). `handleEscalation()` sets the template agent state to `escalated` between the insert and the event. `resolveEscalation()` injects response into agent on resume. `dismissEscalation()` no response; emits `escalation:resolved` with `dismissed: true`, and the daemon fails the delegation of a delegated child that exited while waiting for it (nothing resumes it after a dismiss). Reconcile for inactive/completed tasks |

Trigger: `[ESCALATE] <question>` signal from agent. Surface in UI via `/escalation-queue` page.

`auto-resolve.ts` — `autoResolveEscalations(db, scopeSql, params, response)`: the system-driven close (task settled / cancelled / no longer active; used by `TaskScheduler` and `reconcileOpenEscalationsForInactiveTasks`). Row by row, each close emits `escalation:resolved` with `auto: true` so every surface drops the blocked state; hooks and notification sounds ignore `auto` closes.
