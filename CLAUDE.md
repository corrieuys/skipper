# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Run the server:**
```sh
bun run index.ts
```

**Run all tests:**
```sh
bun test
```

**Run a single test file:**
```sh
bun test src/agents/manager-daemon.test.ts
```

**Run tests matching a pattern:**
```sh
bun test --test-name-pattern "delegation"
```

There is no build step — Bun runs TypeScript directly.

## Architecture Overview

Throng (internally branded as "Skipper") is an AI agent orchestrator. It spawns and manages external AI CLI processes (Claude Code, Codex, or custom), routes their stdout signals through a central event bus, and coordinates multi-agent task execution via a tick-based daemon loop.

### Entry Point & Server

`index.ts` initializes the SQLite DB, creates a `ManagerDaemon`, registers all HTTP routes, and starts the Bun HTTP server on port 3000 (overridable via `PORT`).

`src/server.ts` — custom minimalist router (no framework). Routes are registered imperatively with `addRoute()`. Static files are served from `src/html/public/`.

### Database

SQLite via `bun:sqlite`. Default DB files: `playhive.db` (config/shared) and `playhive-runtime.db` (runtime data) — a split-DB mode introduced to separate long-lived config from ephemeral runtime state.

- `src/db/schema.sql` — monolith schema (used when passing an explicit DB path)
- `src/db/schema.config.sql` — config tables (agent_types, agents, teams, team_agents)
- `src/db/schema.runtime.sql` — runtime tables (tasks, delegations, escalations, etc.)
- `src/db/connection.ts` — DB lifecycle: `initializeDatabase()`, `getDb()`, `closeDb()`, `resetDb()`. Handles both single and split modes, legacy migrations, and seeds built-in agent types.

In split mode, `getDb()` returns the runtime DB with SQL rewriting applied so that queries against shared tables (agents, teams, etc.) are transparently redirected to the config DB via SQLite ATTACH.

### Agent Types (seeded in DB)

Three built-in types, seeded by `seedAgentTypes()` in `src/db/connection.ts`:
- `claude-code` — runs `claude --print --output-format stream-json --verbose --dangerously-skip-permissions`, resume via `--resume <session_id>`
- `codex` — runs `codex exec --json --dangerously-bypass-approvals-and-sandbox -`, resume via `codex exec resume <session_id>`
- `custom` — empty command placeholder

Both `claude-code` and `codex` have `supports_stdin=0` and `supports_resume=1`. Stdin is closed after the initial prompt is written; follow-up messages use `--resume` (kills the process and re-spawns with the prior session ID).

### Signal Protocol

Agents communicate with the orchestrator by printing structured lines to stdout. `AgentManager.parseAgentOutput()` (`src/agents/manager.ts`) scans each stdout line and emits `agent:signal` events on the `eventBus`:

| Signal line format | Type |
|---|---|
| `[DELEGATE to:<agent-id>] <prompt>` | `delegate` |
| `[DELEGATE_BATCH] <json>` | `delegate_batch` |
| `[DELEGATE_COMPLETE] <result>` | `delegate_complete` |
| `[ESCALATE] <question>` | `escalate` |
| `[NOTE] <content>` | `note` |
| `[PHASE_COMPLETE]` | `phase_complete` |
| `[PHASE_REGRESSION N] <reason>` | `phase_regression` |
| `[TASK_COMPLETE task:<id>] <result>` | `task_complete` |
| `[MSG:<type> to:<agent>] <content>` | `message` |

For JSON-mode agents (Claude Code, Codex), signals embedded inside assistant text content are also detected via `detectSignalsInText()`.

### Event Bus

`src/events/bus.ts` — a typed `EventEmitter` singleton. Key events:
- `agent:output` — raw stdout/stderr chunk
- `agent:exit` — process exited (carries `isRespawn`, `hasDelegation` guards)
- `agent:streams_drained` — both stdout/stderr readers finished (used as gate before handling exit)
- `agent:signal` — parsed orchestrator signal
- `agent:state_changed`, `instance:state_changed`, `delegation_group:progress`
- `escalation:created`, `escalation:resolved`
- `task:note_added`, `task:state_changed`

### ManagerDaemon (Facade)

`src/agents/manager-daemon.ts` — wires together all orchestrator modules and is the single object passed to route handlers. It registers handlers on `agent:exit` and `agent:signal` from the event bus, then dispatches to the appropriate sub-module.

### Orchestrator Modules

| Module | File | Responsibility |
|---|---|---|
| `DaemonLoop` | `src/orchestrator/tick-loop.ts` | 30s interval tick; health check → stale recovery → task queue → stale delegations → checkpoints → log cleanup |
| `TaskRunner` | `src/orchestrator/task-runner.ts` | Picks the next `approved` task, spawns the entrypoint agent, sends the initial prompt |
| `PhaseManager` | `src/orchestrator/phase-manager.ts` | Handles `[PHASE_COMPLETE]` / `[PHASE_REGRESSION]` signals; advances `current_phase` or restarts the agent on the new phase |
| `DelegationManager` | `src/orchestrator/delegation-manager.ts` | Creates child agent instances for `[DELEGATE]`, resumes the parent with child's result on `[DELEGATE_COMPLETE]`. Enforces `MAX_DELEGATIONS_PER_PARENT=3` to prevent loops |
| `RecoveryManager` | `src/orchestrator/recovery-manager.ts` | Writes/reads `task_checkpoints`; recovers tasks that were `running` on startup |
| `HealthMonitor` | `src/orchestrator/health-monitor.ts` | Detects stuck agents, nudges or escalates them |

### Task Lifecycle

```
draft → approved → running → completed | failed
```

Tasks move to `approved` manually (via API or UI). The daemon picks up `approved` tasks each tick. Only one task runs at a time (single-agent queue). Phase index starts at 0 and increments on `[PHASE_COMPLETE]`.

### Routes

`src/routes/` — each file registers its own routes via `addRoute()`:
- `agents.ts` — CRUD for agent records
- `teams.ts` — CRUD for teams (with phases array and entrypoint agent)
- `tasks.ts` — task CRUD, status transitions, notes, escalations
- `daemon.ts` — daemon control (start/stop/pause/resume/tick/status)
- `pages.ts` — server-side rendered HTML pages using `src/html/components.ts`

### Testing Conventions

Tests use `bun:test`. Each test file creates its own `Database` (typically a named `.db` file or `:memory:`), calls `initializeDatabase(db)`, and cleans up in `afterEach`. The pattern for integration tests is to construct `ManagerDaemon` (or individual managers) with a test DB instance passed to the constructor. Test DB files are deleted in `afterEach` via `unlinkSync`.

Agent type definitions are cached; tests call `clearAgentTypeCache()` (exported from `src/agents/types.ts`) in `beforeEach` to avoid cross-test contamination.

## Key Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `PLAYHIVE_CONFIG_DB_PATH` | `playhive.db` | Config/shared SQLite path |
| `PLAYHIVE_RUNTIME_DB_PATH` | `playhive-runtime.db` | Runtime SQLite path |
| `PLAYHIVE_IDLE_TIMEOUT` | `60` | Bun server idle timeout (seconds) |
| `PLAYHIVE_CONTEXT_COMPACT_THRESHOLD` | `400000` | Input token count that triggers context compaction |
