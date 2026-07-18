# src/tasks

Task CRUD + state machine.

| file | use |
|---|---|
| `scheduler.ts` | Task CRUD. Lifecycle: draft/approved/running/completed/failed. Unapprove, iterate, cancel, retry, resume. Phase + regression counters. `iterateTask` detaches only the **root** Skipper session (`parent_instance_id IS NULL`) so the re-run re-plans cold; delegated children keep their `session_id` and stay resumable via `delegate_resume` |
| `scheduled-scheduler.ts` | Scheduled task firing → creates task. Two mutually exclusive schedule modes: fixed interval (`schedule_unit`/`schedule_amount`) or weekly matrix (`schedule_matrix`, JSON 7x24 of 0/1, local time, fires at top of enabled hour via `calculateNextRunFromMatrix`). Cron firing (`manager-daemon.ts:fireStandardScheduledTask`) is **singleton per scheduled task**: it skips a new run while a prior run is still active (`approved`/`running`/`paused`) and still advances `next_run_at` past the skipped slot, so a sleep/wake catch-up burst of overdue slots can't spin up overlapping runs of the same recurring task. Manual "Run Now" (`runTaskNow`) is intentionally not guarded. `global_store_instructions`: free-text global-store contract merged into every spawned run's `task_config` and injected into the root prompt by `prompt-builder.ts`. Webhook trigger lifecycle (`enableWebhook`/`regenerateWebhookKey`/`disableWebhook` on `webhook_key`; `setWebhookDebounce` leading-edge debounce in minutes, floor 1, enforced by `runWebhookTask` - ignored webhooks restamp the window) - public trigger URL relayed via connect, validated in `connect/resources.ts` |

Lifecycle states + transitions documented in root [CLAUDE.md](../../CLAUDE.md).
