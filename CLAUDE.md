# Skipper

AI agent orchestrator. Spawn external CLI agents (claude-code, codex, opencode, oz). Route stdout signals via event bus. Tick-loop daemon coords multi-agent tasks. Real-time tasks support audio/text + transcription.

## Run

```sh
bun run index.ts                  # server, default port 3000
bun run test                      # tests
bun test <file>                   # single
bun run typecheck:cleanup         # dead code sweep
```

No build. Bun runs TS direct.

## Entry

- `index.ts` — boot DB, build `ManagerDaemon`, register routes, start Bun server, SIGINT/SIGTERM shutdown
- `src/server.ts` — tiny router. `addRoute()`. static from `src/html/public/`

## Env

| var | default | use |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `SKIPPER_RUNTIME_DB_PATH` | `skipper-runtime.db` | runtime DB file |
| `SKIPPER_CONTEXT_COMPACT_THRESHOLD` | 400000 | input tokens before compact |

## Map — where to look

| concern | dir |
|---|---|
| agent process spawn/parse/resume | [src/agents/CLAUDE.md](src/agents/CLAUDE.md) |
| tick loop, phase, delegation, recovery, health, artifacts, realtime session | [src/orchestrator/CLAUDE.md](src/orchestrator/CLAUDE.md) |
| DB lifecycle, schemas, migrations | [src/db/CLAUDE.md](src/db/CLAUDE.md) |
| JSON config store, feature flags, app settings | [src/config/CLAUDE.md](src/config/CLAUDE.md) |
| HTTP route handlers | [src/routes/CLAUDE.md](src/routes/CLAUDE.md) |
| server-rendered HTML (pages, panels, fragments) | [src/html/CLAUDE.md](src/html/CLAUDE.md) |
| event bus | [src/events/CLAUDE.md](src/events/CLAUDE.md) |
| WS push to UI | [src/ws/CLAUDE.md](src/ws/CLAUDE.md) |
| task CRUD + lifecycle | [src/tasks/CLAUDE.md](src/tasks/CLAUDE.md) |
| teams + phases + membership | [src/teams/CLAUDE.md](src/teams/CLAUDE.md) |
| escalations | [src/escalations/CLAUDE.md](src/escalations/CLAUDE.md) |
| realtime audio/transcribe | [src/realtime/CLAUDE.md](src/realtime/CLAUDE.md) |
| whisper.cpp local server | [src/whisper/CLAUDE.md](src/whisper/CLAUDE.md) |
| MCP server (typed tools alt to stdout signals) | [src/mcp/CLAUDE.md](src/mcp/CLAUDE.md) |
| user hooks (task/escalation events → shell) | [src/hooks/CLAUDE.md](src/hooks/CLAUDE.md) |
| desktop notification sounds | [src/notifications/CLAUDE.md](src/notifications/CLAUDE.md) |
| chat conversations w/ skipper | [src/conversations/CLAUDE.md](src/conversations/CLAUDE.md) |
| greg/grug heckler bot | [src/monkey/CLAUDE.md](src/monkey/CLAUDE.md) |
| query helpers for HTML view-models | [src/data/CLAUDE.md](src/data/CLAUDE.md) |
| task template helpers | [src/templates/CLAUDE.md](src/templates/CLAUDE.md) |
| external config file readers (MCP, skills) | [src/config-readers/CLAUDE.md](src/config-readers/CLAUDE.md) |
| prompt templates loaded at runtime | [prompts/CLAUDE.md](prompts/CLAUDE.md) |
| JSON config snapshots | [config/CLAUDE.md](config/CLAUDE.md) |
| Playwright e2e | [tests/CLAUDE.md](tests/CLAUDE.md) |
| dev scripts | [scripts/CLAUDE.md](scripts/CLAUDE.md) |

## Agent → orchestrator protocol

Two paths feed `agent:signal` on the bus:

**1. MCP tools** (primary). Agents call typed tools on the daemon MCP server at `/mcp` (Bearer = `runtimeId`). Definitions in `src/mcp/tools.ts`. Includes:
`delegate`, `delegate_batch`, `complete_phase`, `regress_phase`, `complete_task`, `escalate`, `create_note`, `create_artifact`, `get_artifact`, `list_artifacts`, plus `send_message`. Phase-lifecycle tools (`complete_phase`, `regress_phase`, `complete_task`) are root-Skipper only — delegated children get a refusal message.

**2. Stdout marker parse** (legacy, narrow). `src/agents/manager.ts:SIGNAL_PATTERNS` scans each line. Surviving markers:

```
[MSG:<type> to:<agent>] <content>     ← agent ↔ agent message
[DELEGATE_COMPLETE] <result>           ← terminal sentinel printed by delegated child
[CREATE_TASK title:<t> team:<id> ...]  ┐
[TASK_STATUS task:<id> status:<s>]     │
[STEER agent:<id> message:<m>]         ├ conversation-agent only
[TASK_NOTE task:<id> content:<c>]      │
[QUERY_TASKS]                          │
[QUERY_TASK id:<id>]                   ┘
```

JSON-mode agents (claude-code, codex) also scan assistant text via `detectSignalsInText()` for the same surviving set.

Deprecated stdout markers (now MCP-only): `[DELEGATE]`, `[DELEGATE_BATCH]`, `[ESCALATE]`, `[NOTE]`, `[PHASE_COMPLETE]`, `[PHASE_REGRESSION N]`, `[TASK_COMPLETE]`, `[ARTIFACT]…[END_ARTIFACT]`, `[ARTIFACT_LIST]`, `[ARTIFACT_GET]`. If you see one in stdout it is silently ignored.

## Task lifecycle

```
draft → approved → running → completed | failed
```

Plus: `approved→draft` (unapprove), `completed→approved` (iterate), `failed→draft|approved` (retry/resume), cancel any active → failed. Daemon picks one approved task per tick. Realtime tasks bypass queue. Phase idx starts 0, increments on `[PHASE_COMPLETE]`.

## Test convention

`bun:test`. Each file owns its `Database` (`:memory:` or named file). Call `initializeDatabase(db)`, clean `afterEach`. Construct `ManagerDaemon` with test DB. Call `clearAgentTypeCache()` in `beforeEach` to dodge cache pollution.

**Keep docs current.** Add/rename module → update nearest CLAUDE.md.
