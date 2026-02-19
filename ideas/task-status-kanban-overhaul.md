# Task Status Lifecycle Overhaul

## Context

Current task statuses (`draft → approved → running → completed | failed`) map poorly to the desired workflow. Goal: a kanban-style pipeline where `ready` is the explicit trigger for daemon pickup rather than the current `approved`.

**New statuses:** `backlog | approved | ready | in-progress | finished | failed`

**Key behavioral change:** Daemon picks up `ready` tasks (not `approved`). Moving a task to `ready` is the explicit "go" signal. `in-progress` and `finished` are set automatically by the system.

## Status Flow

```
backlog → approved → ready → in-progress → finished
                                    ↓
                                  failed → backlog (retry)
                                         → ready (resume)
finished → ready (iterate)
```

- **backlog** (was `draft`): task created, editable
- **approved**: reviewed, waiting to be queued
- **ready**: queued for daemon pickup — this triggers execution
- **in-progress** (was `running`): daemon is running agents
- **finished** (was `completed`): task done
- **failed**: error state, can retry (→backlog) or resume (→ready)

## UI Layout

### Sidebar = Backlog
- **Backlog** tasks — editable drafts
- **Approved** tasks — each with a "Queue" button to move to `ready`
- **Recent** (finished + failed, last 5) — quick-access
- Scheduled / Chats (experimental, unchanged)

### Main Area = Kanban Board (when no task selected)
3 columns, no drag-and-drop, buttons on cards:
- **Ready** — "Unqueue" button (back to approved)
- **In Progress** — shows phase progress
- **Finished** — shows result summary

Failed tasks: red border indicator. All cards clickable → opens task detail.

## Scope Assessment

~80+ status string literal references across the codebase (excluding tests and agent_instance/delegation statuses which are separate enums and unchanged).

**Risk:** Medium. Status strings are pervasive but mechanical to rename. Dangerous part: distinguishing task-level `'running'`/`'completed'` from agent_instance-level `'running'`/`'completed'` — same strings, different columns/types.

---

## Implementation Sketch

### 1. DB Migration — `src/db/migrations/0004_task_status_lifecycle.sql`

SQLite can't ALTER CHECK constraints, so recreate the table:
- CREATE `tasks_new` with new CHECK constraint, default `'backlog'`
- INSERT with CASE mapping: draft→backlog, running→in-progress, completed→finished
- DROP old, RENAME new, recreate indexes
- Wrap with `PRAGMA foreign_keys = OFF` / `ON`

### 2. Core Types — `src/tasks/scheduler.ts`

- Type union → `"backlog" | "approved" | "ready" | "in-progress" | "finished" | "failed"`
- Mechanical rename in every method: draft→backlog, running→in-progress, completed→finished
- `getNextApprovedTask()`: `WHERE status = 'ready'`
- `resumeTask()` / `iterateTask()`: target `"ready"` so daemon auto-picks up
- New methods: `queueTask()` (approved→ready), `unqueueTask()` (ready→approved)

### 3. Daemon & Orchestrator

- Reactive trigger: `event.newStatus === "ready"` (was "approved")
- All task-level `'running'` → `'in-progress'` in task-runner, phase-manager, health-monitor, recovery-manager
- Agent instance statuses unchanged

### 4. API Routes

- New: `POST /api/tasks/:id/queue`, `POST /api/tasks/:id/unqueue`
- "Create & Approve" stops at `approved`
- All status literals updated in sort orders, guards, polling conditions

### 5. CSS & Badges

- New badge variants: `sk-badge--backlog`, `--ready`, `--in-progress`, `--finished`
- Kanban board layout styles
- Keep old badge names as fallback aliases

### 6. NOT Changed

- `agent_instances.status` (pending/running/completed/failed/stopped/waiting_delegation)
- `delegations.status`, `delegation_groups.status`
- `scheduled_tasks.status` (stays draft/approved)
- `escalations.status` (open/resolved)

## Key Files

- `src/db/schema.sql` — CHECK constraint
- `src/tasks/scheduler.ts` — state machine, all transitions
- `src/agents/manager-daemon.ts` — reactive event handling
- `src/orchestrator/task-runner.ts` — daemon pickup query
- `src/orchestrator/phase-manager.ts`, `health-monitor.ts`, `recovery-manager.ts`
- `src/routes/tasks.ts`, `src/routes/pages.ts`
- `src/html/pages/command-center.page.ts` — sidebar + main area
- `src/html/view-models/command-center.vm.ts`
- `src/html/fragments/badge.fragment.ts`
- `src/html/styles/mission-control.ts`, `components.ts`
- `src/data/queries.ts`
