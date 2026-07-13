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
| `codex` | `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -` (`-m` model) | `codex exec resume <session>` | no |
| `opencode` | `opencode run message --format json` | `--session <id>` (`-m` model) | no |
| `grok` | `grok -p "..." --output-format streaming-json --always-approve` (`-m` model) | `--resume <sessionId>` | no |
| `custom` | empty placeholder | — | — |

Only `claude-code` is a first-class provider; `codex`, `opencode`, and `grok`
are experimental (selectable only under `--experimental`, see
`config/model-settings.ts`).

Machine-scoped skipper provider+model overrides resolve once per root spawn
(`AgentManager.getEffectiveRootTypeDef` / `getRootSpawnOverrides`) and persist
per instance (`agent_instances.state_metadata.provider_type/resolved_model`);
runtime-keyed respawns and resumes reuse them, so an overridden root never
flips back to the template row's type mid-task.

`grok` (xAI Grok Build, experimental provider) streams response text as
`{type:"text",data:"<chunk>"}` events; chunks accumulate in
`manager.ts:grokTextBuffers` and are signal-scanned when the terminal
`{type:"end",sessionId}` event arrives (markers can split across chunks).
MCP wiring: `mcp-spawn-helper.ts` patches `<workingDir>/.grok/config.toml`
with a marker-delimited skipper-daemon block (bearer via
`${SKIPPER_AGENT_TOKEN}` env expansion) and restores the file on agent exit,
so the user's `~/.grok` auth/sessions/servers stay untouched.

## Signal parse

`parseAgentOutput()` scans stdout lines. JSON agents also call `detectSignalsInText()` on assistant text. Emits `agent:signal` on `events/bus.ts`.

Narrow surface — `SIGNAL_PATTERNS` only covers `[MSG:…]`, `[DELEGATE_COMPLETE]`, and conversation-agent markers (`CREATE_TASK`, `TASK_STATUS`, `STEER`, `TASK_NOTE`, `QUERY_TASKS`, `QUERY_TASK`). All delegation/escalation/phase/artifact/note signals are MCP-tool calls on the daemon MCP server — see [../mcp/CLAUDE.md](../mcp/CLAUDE.md). Root [CLAUDE.md](../../CLAUDE.md) has the full protocol table.
