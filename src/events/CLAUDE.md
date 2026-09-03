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
