# src/escalations

| file | use |
|---|---|
| `manager.ts` | Escalation CRUD. `resolveEscalation()` injects response into agent on resume. `dismissEscalation()` no response. Reconcile for inactive/completed tasks |

Trigger: `[ESCALATE] <question>` signal from agent. Surface in UI via `/escalation-queue` page.
