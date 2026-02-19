# src/hooks

User hooks — shell commands fired on task/escalation events. Like git hooks.

| file | use |
|---|---|
| `manager.ts` | `HookManager`. Subscribe to bus events. Resolve placeholders. Spawn shell. 30s timeout |
| `placeholder.ts` | `{{task.id}}` etc. substitution |
| `types.ts` | `HookDefinition`, `HookEventName`, payloads |

Events: `task.started`, `task.completed`, `task.failed`, `escalation.created`, `escalation.resolved`, `phase.review_pending`.
