# src/tasks

Task CRUD + state machine.

| file | use |
|---|---|
| `scheduler.ts` | Task CRUD. Lifecycle: draft/approved/running/completed/failed. Unapprove, iterate, cancel, retry, resume. Phase + regression counters |
| `scheduled-scheduler.ts` | Scheduled task firing → creates task. Two mutually exclusive schedule modes: fixed interval (`schedule_unit`/`schedule_amount`) or weekly matrix (`schedule_matrix`, JSON 7x24 of 0/1, local time, fires at top of enabled hour via `calculateNextRunFromMatrix`). `global_store_instructions`: free-text global-store contract merged into every spawned run's `task_config` and injected into the root prompt by `prompt-builder.ts`. Webhook trigger lifecycle (`enableWebhook`/`regenerateWebhookKey`/`disableWebhook` on `webhook_key`; `setWebhookDebounce` leading-edge debounce in minutes, floor 1, enforced by `runWebhookTask` - ignored webhooks restamp the window) - public trigger URL relayed via connect, validated in `connect/resources.ts` |

Lifecycle states + transitions documented in root [CLAUDE.md](../../CLAUDE.md).
