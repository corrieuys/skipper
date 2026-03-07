# Architecture Overview

## What is Skipper?

Skipper is an AI agent orchestrator. It spawns and manages external AI CLI processes (Claude Code, Codex, or custom), routes their stdout signals through a central event bus, and coordinates multi-agent task execution via a tick-based daemon loop.

It is not a framework or SDK. It is a runtime that manages opaque CLI processes and interprets their structured stdout output as orchestration commands.

## Core Design Principles

1. **Agents are external processes.** Skipper does not embed AI models. It spawns CLI tools (`claude`, `codex`, or custom commands) as child processes and communicates via stdin/stdout.
2. **Tick-based coordination.** A 30-second daemon loop drives all background work: health checks, task scheduling, stale recovery, and cleanup.
3. **Signal protocol over stdout.** Agents emit structured lines (e.g., `[PHASE_COMPLETE]`, `[DELEGATE to:agent-id] prompt`) that Skipper parses and acts on.
4. **SQLite persistence.** All state lives in SQLite. Split-mode separates long-lived config data from ephemeral runtime data.

## System Components

```
                    +-----------+
                    |  HTTP UI  |
                    |  (Bun)    |
                    +-----+-----+
                          |
                    +-----v-----+
                    | Manager   |
                    | Daemon    |  <-- facade for all orchestrator modules
                    +-----+-----+
                          |
          +-------+-------+-------+-------+
          |       |       |       |       |
     TaskRunner  Phase  Deleg.  Recovery  Health
               Manager  Manager  Manager  Monitor
          |       |       |       |       |
          +-------+-------+-------+-------+
                          |
                    +-----v-----+
                    | Event Bus |  <-- typed EventEmitter
                    +-----------+
                          |
              +-----------+-----------+
              |           |           |
         Agent Mgr   Agent Mgr   Agent Mgr
         (claude)    (codex)     (custom)
              |           |           |
         child proc  child proc  child proc
```

## Database: Split-Mode SQLite

Skipper uses two SQLite databases in split mode:

| Database | Default Path | Contents |
|---|---|---|
| Config DB | `playhive.db` | Agent types, agents, teams, team_agents |
| Runtime DB | `playhive-runtime.db` | Tasks, delegations, escalations, checkpoints, logs |

The runtime DB ATTACHes the config DB so that queries against shared tables are transparently redirected. This separation means runtime data can be wiped without losing agent/team configuration.

When an explicit single DB path is provided, both schemas are loaded into one file (monolith mode).

## Signal Protocol

Agents communicate with the orchestrator by printing structured lines to stdout. `AgentManager.parseAgentOutput()` scans each line and emits `agent:signal` events.

| Signal | Format | Effect |
|---|---|---|
| Phase complete | `[PHASE_COMPLETE]` | Advances `current_phase` index, restarts agent on next phase |
| Phase regression | `[PHASE_REGRESSION N] reason` | Moves phase back to N, restarts agent |
| Delegate | `[DELEGATE to:<agent-id>] prompt` | Spawns a child agent with the given prompt |
| Delegate batch | `[DELEGATE_BATCH] json` | Spawns multiple child agents |
| Delegate complete | `[DELEGATE_COMPLETE] result` | Returns result to parent agent |
| Escalate | `[ESCALATE] question` | Creates an escalation for human review |
| Note | `[NOTE] content` | Appends a note to the task |
| Task complete | `[TASK_COMPLETE task:<id>] result` | Marks the task as completed |
| Message | `[MSG:<type> to:<agent>] content` | Inter-agent messaging |

For JSON-mode agents (Claude Code, Codex), signals embedded inside assistant text content are also detected via `detectSignalsInText()`.

## Event Bus

A typed `EventEmitter` singleton (`src/events/bus.ts`) decouples producers from consumers.

Key events:
- `agent:output` -- raw stdout/stderr chunk from a process
- `agent:exit` -- process exited (carries `isRespawn`, `hasDelegation` guards)
- `agent:streams_drained` -- both stdout/stderr readers finished (gate before handling exit)
- `agent:signal` -- parsed orchestrator signal (delegate, phase_complete, etc.)
- `agent:state_changed` / `instance:state_changed` -- state machine transitions
- `escalation:created` / `escalation:resolved`
- `task:note_added` / `task:state_changed`

## Task Lifecycle

```
draft --> approved --> running --> completed
                         |
                         +--> failed
```

- Tasks start as `draft` and move to `approved` via API or UI action.
- The daemon tick picks up `approved` tasks and assigns them to the entrypoint agent.
- Only one task runs at a time (single-task queue).
- Phase index starts at 0 and increments on each `[PHASE_COMPLETE]` signal.
- Tasks that fail or get stuck can be retried (reset to `approved`) or failed safely.

## Phase Advancement

Each team defines an ordered array of phases. When the active agent emits `[PHASE_COMPLETE]`:

1. `PhaseManager` increments `current_phase` on the task.
2. If more phases remain, the agent is restarted with the new phase context.
3. If the final phase completes, the task moves to `completed`.

Phase regression (`[PHASE_REGRESSION N]`) moves the index backward and restarts.

## Delegation

When an agent emits `[DELEGATE to:<agent-id>] prompt`:

1. `DelegationManager` creates a delegation record and spawns the child agent.
2. The parent agent enters `WAITING_DELEGATION` state.
3. When the child emits `[DELEGATE_COMPLETE] result`, the parent is resumed via `--resume` with the child's result.
4. `MAX_DELEGATIONS_PER_PARENT=3` prevents infinite delegation loops.

## Module Map

| Module | File | Role |
|---|---|---|
| Entry point | `index.ts` | Server startup, DB init, route registration |
| Server | `src/server.ts` | HTTP routing, static file serving |
| DB | `src/db/connection.ts` | Database lifecycle and split-mode management |
| Agent Manager | `src/agents/manager.ts` | Process spawning, stdout parsing, signal detection |
| Manager Daemon | `src/agents/manager-daemon.ts` | Facade wiring all orchestrator modules together |
| Prompt Builder | `src/agents/prompt-builder.ts` | Constructs agent prompts with phase and delegation context |
| State Tracker | `src/agents/state-tracker.ts` | Tracks agent instance state machines |
| Tick Loop | `src/orchestrator/tick-loop.ts` | 30s daemon interval driving background work |
| Task Runner | `src/orchestrator/task-runner.ts` | Picks approved tasks, spawns entrypoint agents |
| Phase Manager | `src/orchestrator/phase-manager.ts` | Phase advancement and regression |
| Delegation Manager | `src/orchestrator/delegation-manager.ts` | Child agent spawning and parent resumption |
| Recovery Manager | `src/orchestrator/recovery-manager.ts` | Checkpoint writing and startup recovery |
| Health Monitor | `src/orchestrator/health-monitor.ts` | Stuck agent detection, nudging, escalation |
| Event Bus | `src/events/bus.ts` | Typed event pub/sub |
| Task Scheduler | `src/tasks/scheduler.ts` | Task scheduling logic |
| Team Manager | `src/teams/manager.ts` | Team CRUD and membership |
| Routes | `src/routes/` | HTTP endpoints for agents, tasks, teams, daemon, pages |
