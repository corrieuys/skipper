# src/notifications

Browser desktop sounds on bus events. Triggered via WS push.

| file | use |
|---|---|
| `manager.ts` | Subscribe to bus → call `uiPush.broadcastNotification(url)` if enabled |
| `store.ts` | Persist per-event enable/disable in DB |
| `types.ts` | `NotificationEventKey` + sound file mapping |

Events: `task.started/completed/failed`, `escalation.created/resolved`, `phase.review_pending`.

`escalation:resolved` with `auto: true` (system close on settle / cancel, see `src/escalations/auto-resolve.ts`) is ignored: the hook / sound means the operator answered.
