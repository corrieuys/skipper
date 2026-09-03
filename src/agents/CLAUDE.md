# src/agents

Agent process runtime. Spawn external CLI, parse stdout, route signals.

| file | use |
|---|---|
| `manager.ts` | `AgentManager` — spawn/kill, stdout/stderr readers, JSON stream events, `parseAgentOutput()` extracts signals, session/resume tracking, persists runtime output/state. `ingestChunk()` is the one output path; `ingestSyntheticStdout`/`ingestSyntheticStderr` let an in-process agent reach it without a stream |
| `manager-daemon.ts` | `ManagerDaemon` facade. Wires every orchestrator module. Subscribes to `agent:exit` / `agent:signal`. Single object passed to routes. |
| `prompt-builder.ts` | Build initial/resume prompts. Inject phase + delegation context + command templates from `prompts/`. Also injects per-run `task_config` blocks: `run_input` (ADDITIONAL INSTRUCTIONS), `global_store_instructions`, and `slack_origin` (SLACK ORIGIN → reply via `slack_send_message`, only when the team's Slack tools are available) |
| `state-tracker.ts` | Heartbeat + fingerprint for stuck detect / nudge / escalation |
| `types.ts` | Agent-type lookup + cache. `clearAgentTypeCache()` for tests |
| `oneshot.ts` | `runOneShotText()` — provider-generic one-shot text call built from `agent_types` arg templates. Used by Greg's brain + the dictation rewriter; no instance rows/MCP/signals |
| `skipper.ts` | `SKIPPER_AGENT_ID` constant + skipper config read/update. Also the Skipper's own orb identity: `getSkipperIdentity`/`saveSkipperIdentity` (machine-scoped `app_settings`, default character `captain`) + `applySkipperIdentity` which patches the config `agents` row for `skipper` (called at boot in `db/connection.ts` and on save from the config page's experimental Skipper Character panel) |
| `mcp-spawn-helper.ts` | Build MCP server config injection at spawn time. Skipped for in-process agents |
| `instance-status.ts` | Shared `agent_instances.status` writers: `updateInstanceStatus()`, `finalizeActiveInstancesForTask()` |
| `signal-utils.ts` | `signalTextSnippet()` — dedup-fingerprint normalization shared with `mcp/signal-bridge.ts` |

## Agent types (seeded `db/connection.ts:seedAgentTypes()`)

| id | cmd | resume | stdin |
|---|---|---|---|
| `claude-code` | `claude --print --output-format stream-json --verbose --dangerously-skip-permissions` | `--resume <session>` | no |
| `codex` | `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -` (`-m` model) | `codex exec resume <session>` | no |
| `opencode` | `opencode run message --format json` | `--session <id>` (`-m` model) | no |
| `grok` | `grok -p "..." --output-format streaming-messages-json --always-approve` (`-m` model) | `--resume <sessionId>` | no |
| `custom` | empty placeholder | — | — |
| `custom:<id>` | none — runs in-process | own message history | no |

Only `claude-code` is a first-class provider; `codex`, `opencode`, and `grok`
are experimental (selectable only under `--experimental`, see
`config/model-settings.ts`).

`custom:<id>` rows are **not seeded** — one is registered per custom agent
definition at boot and after every edit, into the in-memory config DB only
(see [../custom-agents/CLAUDE.md](../custom-agents/CLAUDE.md)). `spawnRuntimeAgent`
branches on `isCustomAgentType` before it would build an argv: no `Bun.spawn`, no
MCP config files, and `RunningAgent.process` is an `InProcessHandle` with a null
pid instead of a `Subprocess`. `RunningAgent.process`/`.stdin` are the narrow
`AgentProcessHandle`/`AgentStdin` interfaces for exactly this reason; the pid-null
case is guarded in `orchestrator/recovery-manager.ts` and `manager-daemon.ts`.

Machine-scoped skipper provider+model overrides resolve once per root spawn
(`AgentManager.getEffectiveRootTypeDef` / `getRootSpawnOverrides`) and persist
per instance (`agent_instances.state_metadata.provider_type/resolved_model`);
runtime-keyed respawns and resumes reuse them, so an overridden root never
flips back to the template row's type mid-task.

`grok` (xAI Grok Build, experimental provider) runs with
`--output-format streaming-messages-json`: NDJSON, **one whole message per line**,
in the Anthropic Messages wire format — the same `{type:"system",subtype:"init"}` /
`{type:"assistant",message:{content:[…]}}` / `{type:"user"}` (tool_result) /
`{type:"result",result}` frames claude-code emits. So session capture, text
extraction, signal scanning and the activity feed all reuse the claude path with
no grok-specific handling.

Its other format, `--output-format streaming-json` (ACP session updates), emits
response text a few tokens at a time as `{type:"text",data:"<chunk>"}`. Skipper
used to request it, which is why `manager.ts:grokTextBuffers` accumulates those
chunks and signal-scans them at the terminal `{type:"end",sessionId}` event —
markers can split across chunks. That path is retained for installs whose
`agent_types.json` predates the switch (`ensureConfigSeeded` only writes files
that are ABSENT, so an existing data-dir config keeps the old args until it is
edited or removed). Do not switch back: one chunk is one `terminal_outputs` row,
so a sentence renders as a column of one-word rows in the activity feed.
**Tool naming.** grok does not put MCP tools in the model's registry at all: it
exposes `search_tool` / `use_tool`, and the daemon's tools appear under
`skipper-daemon__<tool>` (no `mcp__` prefix). A grok agent looking for
`mcp__skipper-daemon__*` finds nothing and concludes the server is absent, so
`prompt-builder.ts:MCP_TOOLS_PREFERENCE` and the `mcp-tools-*.md` prompts spell
out the search/invoke pair and forbid the raw-HTTP fallback one grok invented for
itself (it bypasses `signal-bridge` dedup).

MCP wiring: `mcp-spawn-helper.ts` patches `<workingDir>/.grok/config.toml`
with a marker-delimited skipper-daemon block (bearer via
`${SKIPPER_AGENT_TOKEN}` env expansion) and restores the file on agent exit,
so the user's `~/.grok` auth/sessions/servers stay untouched. The injected URL
is `http://host:port/mcp?client=skipper-daemon`: the `?client` marker is dead
weight to the daemon (`server.ts` routes on pathname) but makes the URL a
distinct STRING. **Grok collapses two MCP servers that share an identical URL
into one connection.** Operators very commonly already have a `skipper` server
pointing at the same `http://host:port/mcp` (grok scans `~/.claude.json` /
Cursor as compat sources). Without the marker, grok merges skipper-daemon into
that operator server: the daemon shows `connected` in the init frame but exposes
ZERO tools to the model, and the only skipper tools it can find are the operator
`skipper__*` ones that need a `task_id`. Verified against grok 1.0.0. Only grok
dedupes by URL — claude-code/codex key off the server name and use the plain
URL. It also appends
**`--trust`** to the spawn args: repo-local (project-scoped) MCP servers are
gated on folder trust, and in an untrusted directory grok skips the server
entirely rather than failing loudly — the agent simply runs with no skipper
tools and no way to tell. `--trust` records the working directory in
`~/.grok/trusted_folders.toml`, which is the same gate governing that repo's
project hooks and repo-local LSP servers in later grok sessions, so Skipper
running a task in a repo trusts that repo from then on.

**opencode** gets the daemon MCP server via `OPENCODE_CONFIG`: `mcp-spawn-helper.ts`
writes a temp JSON config carrying only `mcp.skipper-daemon`
(`{type:"remote",url,headers:{Authorization:"Bearer {env:SKIPPER_AGENT_TOKEN}"}}`)
and points `OPENCODE_CONFIG` at it. opencode MERGES configs (global <
`OPENCODE_CONFIG` < project), so the operator's own providers/models survive and
we only add the server; the bearer is `{env:}`-substituted at load, so no token
lands on disk. Unlike grok's shared `<cwd>/.grok/config.toml` this is isolated
per-agent (own temp file + own env) — no concurrent-agent race, cleanup is just
deleting the temp file (`cleanupPaths`). The write is best-effort: a host with no
writable temp still spawns the agent, just without daemon MCP tools. **This is
what lets opencode be a root/Skipper at all** — phase/task lifecycle is MCP-only,
so without the server a root opencode task can never call `complete_phase` /
`complete_task` and never completes.

## Signal parse

`parseAgentOutput()` scans stdout lines. JSON agents also call `detectSignalsInText()` on assistant text. Emits `agent:signal` on `events/bus.ts`.

Narrow surface — `SIGNAL_PATTERNS` only covers `[MSG:…]` and `[DELEGATE_COMPLETE]`. All delegation/escalation/phase/artifact/note signals are MCP-tool calls on the daemon MCP server — see [../mcp/CLAUDE.md](../mcp/CLAUDE.md). Root [CLAUDE.md](../../CLAUDE.md) has the full protocol table.

## Terminal output storage (`terminal_outputs`)

`manager.ts:ingestChunk` records **stdout one complete line per row** (stderr
stays per chunk). Every provider prints NDJSON, so a row is always one whole
frame: never a 64KB pipe read that starts mid-string, never three frames glued
together. The realtime `agent:output` event uses the same unit, so the WS UI and
the connect output tail receive parseable frames. An unterminated tail is
flushed when the stream drains; a synthetic write (`ingestSyntheticStdout`) is
newline-terminated so it lands immediately. The line buffer allows 16MB (a
claude-code image `tool_result` is one multi-MB line); anything larger is
dropped with a marker row.

Only the **stored** copy is capped (`MAX_TERMINAL_OUTPUT_BYTES`, 32KB):
`compactFrameForStorage` first compacts an oversized JSON frame structurally
(inline `{type:"base64",data}` payloads become a size note, strings over 8KB
are cut) so it stays valid JSON for the feed, the modal and the token/turn
queries; only a frame that is still too big, or was never JSON, gets the hard
byte cut plus the "frame truncated" marker. The event still carries the full
text. Before this, one long task stored 340MB of unrenderable base64 chunk
fragments; the retention sweep (`log_retention_hours`) removes old rows either way.
