# src/agents

Agent process runtime. Spawn external CLI, parse stdout, route signals.

| file | use |
|---|---|
| `manager.ts` | `AgentManager` — spawn/kill, stdout/stderr readers, JSON stream events, `parseAgentOutput()` extracts signals, session/resume tracking, persists runtime output/state |
| `manager-daemon.ts` | `ManagerDaemon` facade. Wires every orchestrator module. Subscribes to `agent:exit` / `agent:signal`. Single object passed to routes. |
| `prompt-builder.ts` | Build initial/resume prompts. Inject phase + delegation context + command templates from `prompts/` |
| `state-tracker.ts` | Heartbeat + fingerprint for stuck detect / nudge / escalation |
| `types.ts` | Agent-type lookup + cache. `clearAgentTypeCache()` for tests |
| `oneshot.ts` | `runOneShotText()` — provider-generic one-shot text call built from `agent_types` arg templates. Used by Greg's brain + the dictation rewriter; no instance rows/MCP/signals |
| `skipper.ts` | `SKIPPER_AGENT_ID` constant + skipper config read/update |
| `mcp-spawn-helper.ts` | Build MCP server config injection at spawn time |
| `instance-status.ts` | Shared `agent_instances.status` writers: `updateInstanceStatus()`, `finalizeActiveInstancesForTask()` |
| `signal-utils.ts` | `signalTextSnippet()` — dedup-fingerprint normalization shared with `mcp/signal-bridge.ts` |

## Agent types (seeded `db/connection.ts:seedAgentTypes()`)

| id | cmd | resume | stdin |
|---|---|---|---|
| `claude-code` | `claude --print --output-format stream-json --verbose --dangerously-skip-permissions` | `--resume <session>` | no |
| `codex` | `codex exec --json --dangerously-bypass-approvals-and-sandbox -` | `codex exec resume <session>` | no |
| `opencode` | `opencode run message --format json` | `--session <id>` (`-m` model) | no |
| `oz` | `oz agent run --output-format json --prompt "..." --model <id>` | none — prompt at spawn | no |
| `custom` | empty placeholder | — | — |

## Signal parse

`parseAgentOutput()` scans stdout lines. JSON agents also call `detectSignalsInText()` on assistant text. Emits `agent:signal` on `events/bus.ts`.

Narrow surface — `SIGNAL_PATTERNS` only covers `[MSG:…]`, `[DELEGATE_COMPLETE]`, and conversation-agent markers (`CREATE_TASK`, `TASK_STATUS`, `STEER`, `TASK_NOTE`, `QUERY_TASKS`, `QUERY_TASK`). All delegation/escalation/phase/artifact/note signals are MCP-tool calls on the daemon MCP server — see [../mcp/CLAUDE.md](../mcp/CLAUDE.md). Root [CLAUDE.md](../../CLAUDE.md) has the full protocol table.
