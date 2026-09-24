# src/events

Typed event bus singleton. Single channel between `AgentManager` (process) and orchestrator modules.

| file | use |
|---|---|
| `bus.ts` | Typed `EventEmitter` singleton |

## Key events

- `agent:output` — raw stdout/stderr chunk
- `agent:exit` — process exited (carries `isRespawn`, `hasDelegation` guards)
- `agent:streams_drained` — stdout+stderr readers finished. Gate before exit handling
- `agent:signal` — parsed orchestrator signal
- `agent:state_changed`, `instance:state_changed`, `delegation_group:progress`
- `escalation:created`, `escalation:resolved`
- `task:note_added`, `task:state_changed` (draft/active/archived + "deleted"), `task:needs_review_changed`
- `task:run_completed` / `task:run_failed` — a run settled; task stays active (Slack/hooks/notifications key on these)
- `task:wake_requested` — input arrived for a resting task; daemon dispatches the queue
- `recurring:changed` `{ scheduledTaskId, change: created|updated|deleted }` — every `ScheduledTaskScheduler` mutation (create, edit, approve/unapprove, star, icon, memory, webhook, slash command, last run, delete). `team:changed` `{ teamId, change }` — `createLocalTeam` / `updateLocalTeam` / `deleteLocalTeam`. ui-push re-renders the sidebar; Connect forwards both fat (`recurring` / `team` row, absent on delete); the TUI patches its cached lists.
- `escalation:resolved` may carry `auto: true`: the SYSTEM closed it (`escalations/auto-resolve.ts`: task settled / cancelled / inactive). UIs reconcile; hooks and notification sounds skip it.

## Rule: a state write without an event is a bug

Every surface reconciles from these events (root CLAUDE.md, UI update contract). Writers that announce themselves: `updateInstanceStatus` / `finalizeActiveInstancesForTask` (`instance:state_changed`), `TaskScheduler.updateTask` / `setIdentity` / `setStarred` / `setIcon` / `setAutopilot` (same-status `task:state_changed` = in-place patch), `autoResolveEscalations`, the recurring scheduler, local-teams CRUD. New mutation → emit from the writer, not from each caller.
