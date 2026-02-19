# src/tasks

Task CRUD + state machine.

| file | use |
|---|---|
| `scheduler.ts` | Task CRUD. Lifecycle: draft/approved/running/completed/failed. Unapprove, iterate, cancel, retry, resume. Phase + regression counters |
| `scheduled-scheduler.ts` | Cron-driven scheduled task firing → creates task |

Lifecycle states + transitions documented in root [CLAUDE.md](../../CLAUDE.md).
