# AGENTS.md — Module Map

Quick-reference index of all major modules in the Skipper orchestrator.

## Entry Point

| File | Description |
|---|---|
| [`index.ts`](index.ts) | Initializes DB, creates ManagerDaemon, registers routes, starts Bun HTTP server (port 3000) |

## Server

| File | Description |
|---|---|
| [`src/server.ts`](src/server.ts) | Custom minimalist router (no framework). Routes registered via `addRoute()`. Static files served from `src/html/public/` |

## Database (`src/db/`)

| File | Description |
|---|---|
| [`src/db/connection.ts`](src/db/connection.ts) | DB lifecycle: `initializeDatabase()`, `getDb()`, `closeDb()`, `resetDb()`. Handles single and split modes, legacy migrations, seeds built-in agent types |
| [`src/db/schema.sql`](src/db/schema.sql) | Monolith schema (used with explicit DB path) |
| [`src/db/schema.config.sql`](src/db/schema.config.sql) | Config tables: agent_types, agents, teams, team_agents |
| [`src/db/schema.runtime.sql`](src/db/schema.runtime.sql) | Runtime tables: tasks, delegations, escalations, checkpoints |

## Agents (`src/agents/`)

| File | Description |
|---|---|
| [`src/agents/manager.ts`](src/agents/manager.ts) | Core agent management: spawn processes, parse stdout, detect signals, manage lifecycle |
| [`src/agents/manager-daemon.ts`](src/agents/manager-daemon.ts) | Facade that wires together all orchestrator modules. Single object passed to route handlers |
| [`src/agents/prompt-builder.ts`](src/agents/prompt-builder.ts) | Constructs prompts sent to agents, including phase context and delegation instructions |
| [`src/agents/state-tracker.ts`](src/agents/state-tracker.ts) | Tracks agent instance states (idle, running, waiting, etc.) |
| [`src/agents/types.ts`](src/agents/types.ts) | Agent type definitions and cache management (`clearAgentTypeCache()`) |
| [`src/agents/skipper.ts`](src/agents/skipper.ts) | Skipper-specific agent logic |

## Orchestrator (`src/orchestrator/`)

| File | Description |
|---|---|
| [`src/orchestrator/tick-loop.ts`](src/orchestrator/tick-loop.ts) | 30s daemon tick: health check, stale recovery, task queue, stale delegations, checkpoints, log cleanup |
| [`src/orchestrator/task-runner.ts`](src/orchestrator/task-runner.ts) | Picks next `approved` task, spawns entrypoint agent, sends initial prompt |
| [`src/orchestrator/phase-manager.ts`](src/orchestrator/phase-manager.ts) | Handles `[PHASE_COMPLETE]` / `[PHASE_REGRESSION]` signals; advances or regresses phase index |
| [`src/orchestrator/delegation-manager.ts`](src/orchestrator/delegation-manager.ts) | Creates child agents for `[DELEGATE]`, resumes parent on `[DELEGATE_COMPLETE]`. Enforces `MAX_DELEGATIONS_PER_PARENT=3` |
| [`src/orchestrator/recovery-manager.ts`](src/orchestrator/recovery-manager.ts) | Writes/reads task checkpoints; recovers tasks that were `running` on startup |
| [`src/orchestrator/health-monitor.ts`](src/orchestrator/health-monitor.ts) | Detects stuck agents, nudges or escalates them |

## Tasks

| File | Description |
|---|---|
| [`src/tasks/scheduler.ts`](src/tasks/scheduler.ts) | Task scheduling logic |

## Teams

| File | Description |
|---|---|
| [`src/teams/manager.ts`](src/teams/manager.ts) | Team CRUD and team-agent membership management |

## Escalations

| File | Description |
|---|---|
| [`src/escalations/manager.ts`](src/escalations/manager.ts) | Escalation creation and resolution |

## Events

| File | Description |
|---|---|
| [`src/events/bus.ts`](src/events/bus.ts) | Typed EventEmitter singleton. Key events: `agent:output`, `agent:exit`, `agent:signal`, `agent:state_changed`, `escalation:created`, `task:state_changed` |

## Routes (`src/routes/`)

| File | Description |
|---|---|
| [`src/routes/agents.ts`](src/routes/agents.ts) | CRUD for agent records |
| [`src/routes/tasks.ts`](src/routes/tasks.ts) | Task CRUD, status transitions, notes, escalations |
| [`src/routes/teams.ts`](src/routes/teams.ts) | CRUD for teams (phases array, entrypoint agent) |
| [`src/routes/daemon.ts`](src/routes/daemon.ts) | Daemon control: start/stop/pause/resume/tick/status |
| [`src/routes/pages.ts`](src/routes/pages.ts) | Server-side rendered HTML pages |
| [`src/routes/skipper.ts`](src/routes/skipper.ts) | Skipper-specific routes |

## HTML

| File | Description |
|---|---|
| [`src/html/components.ts`](src/html/components.ts) | Server-side HTML component rendering for the dashboard UI |

## Prompts (`prompts/`)

| File | Description |
|---|---|
| [`prompts/commands-always.md`](prompts/commands-always.md) | Signal commands always included in agent prompts |
| [`prompts/commands-delegation.md`](prompts/commands-delegation.md) | Delegation-specific command instructions |
| [`prompts/execution-context.md`](prompts/execution-context.md) | Execution context template for agents |
| [`prompts/phase-complete-phase.md`](prompts/phase-complete-phase.md) | Phase completion instructions |
| [`prompts/phase-complete-task.md`](prompts/phase-complete-task.md) | Task completion instructions |
| [`prompts/phase-regression.md`](prompts/phase-regression.md) | Phase regression instructions |
| [`prompts/skipper.md`](prompts/skipper.md) | Skipper agent system prompt |

---

**Keeping docs current:** When adding or renaming modules, update this file to keep the index accurate. This is the first place new contributors should look to orient themselves.
