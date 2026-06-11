# Skipper

Skipper is a multi-agent orchestration platform for coordinating teams of AI agents.

It manages task lifecycles, team hierarchies, phase-based execution, delegation (including parallel fan-out), artifacts, and human escalations. It also supports real-time workflows with continuous audio/text ingestion, transcription, summarization, and continuous agent invocation based on incoming context.

## Feature Overview

- **Structured task orchestration** with retry, resume, cancel, and iterate loops.
- **Team-based, phased execution model.** Role-aware delegation, phased-based team configuration.
- **Delegation engine** for single-subtask and parallel batch fan-out.
- **Human-in-the-loop escalations** for uncertain/blocked execution.
- **Versioned artifacts** (`transcript`, `summary`, `plan`, `other`) with immutable history.
- **Real-time pipeline** for audio/text ingestion, STT, summarization, and timeline updates.
- **Health monitoring** (stuck detection, nudges, process liveness, incident clustering).
- **MCP-based agent protocol** — agents call typed tools on Skipper's daemon MCP server (delegation, notes, artifacts, escalations) instead of brittle stdout parsing.
- **Task templates** with per-phase overrides, persisted in your runtime DB.

## Supported AI Model Providers

Skipper currently supports these provider CLIs for agent execution:

- **Claude Code** (`claude`)
- **OpenAI Codex** (`codex`)

These providers are external CLIs that Skipper spawns at runtime.

Any provider you intend to use must be:

1. Installed on the host machine.
2. Authenticated (logged in) for the same OS user running Skipper.

If a provider is missing or not logged in, agent spawn/resume calls will fail and tasks may fail at runtime.

## Task Modes

| Mode | Best For | Examples | Execution Style |
|---|---|---|---|
| **Regular Tasks** | Planned, goal-driven delivery | Feature implementation, PR reviews, documentation writing | Draft -> approved -> running -> completed, with retry/resume/iterate |
| **Real-Time Tasks** | Live collaboration with Skipper in the loop | Brainstorming sessions, meetings, event storming | Continuous input -> transcription -> summarization -> timeline -> agent action |

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.2+
- For local real-time transcription (optional): `cmake`, C++ compiler, `ffmpeg`
- Provider CLI(s) installed and logged in (`claude` for Claude Code and/or `codex` for OpenAI Codex)

### Run from source

```bash
bun install
bun run start
```

The server starts on port 3000 by default (override with `PORT`).

## Data layout

Skipper separates code/config (shipped, replaceable on upgrade) from runtime data (lives on your machine, must survive upgrades).

### What ships with the package

| Path | Purpose |
|---|---|
| `src/` | Source code |
| `prompts/` | Prompt templates loaded at runtime |
| `config/*.json` | Default agents, teams, agent types, skipper config |
| `src/db/schema.*.sql` | SQLite schemas |
| `src/db/migrations/*.sql` | Numbered, additive schema migrations |
| `bin/skipper.js` | CLI entry shim |

The default `config/*.json` is part of the product. Defaults may shift between releases. To customise without forking, use task templates (per-task instructions and per-phase overrides created via the UI) — they persist in your runtime DB and are unaffected by upgrades.

### What lives on your machine

By default, runtime data is stored in:

- `$SKIPPER_DATA_DIR` if set, else
- `$XDG_DATA_HOME/skipper` if set, else
- `~/.skipper`

Inside the data dir:

- `skipper-runtime.db` — SQLite database (tasks, notes, artifacts, conversations, templates, escalations, agent instances, terminal outputs, MCP overrides, error log, …)

Worktrees for parallel-consensus agents live alongside the target repo at `<task working dir>/.skipper-worktrees/`. MCP temp configs go to `/tmp/skipper-mcp-*`. Neither is in the install dir.

### Environment overrides

| Variable | Purpose |
|---|---|
| `SKIPPER_DATA_DIR` | Override data dir entirely |
| `XDG_DATA_HOME` | Standard XDG base dir (used if `SKIPPER_DATA_DIR` not set) |
| `SKIPPER_RUNTIME_DB_PATH` | Pin the DB file to an explicit path |
| `PORT` | HTTP server port (default 3000) |

## Schema migrations

Schema changes are tracked in `src/db/migrations/` as numbered SQL files (`NNNN_<name>.sql`). On each boot, Skipper applies any migrations whose version is not yet recorded in the `schema_version` table, inside a transaction. Older databases auto-upgrade on first launch with a new release.

When adding a schema change, drop a new file in `src/db/migrations/` rather than editing the base `schema.*.sql` files.

## Local Whisper Setup (Optional)

Real-time tasks can use local transcription via [whisper.cpp](https://github.com/ggerganov/whisper.cpp).

```bash
bash scripts/setup-whisper.sh
```

Whisper will be auto started and stopped when recording audio in a real time task.

## MCP And Skills Configuration

Skipper discovers MCP servers and skills from provider-specific config files for the current server working directory (`process.cwd()`).

### MCP server discovery

Claude Code:

- `~/.claude.json` -> `mcpServers` (global/user)
- `~/.claude.json` -> `projects["<absolute-cwd>"].mcpServers` (project-scoped)
- `./.mcp.json` -> `mcpServers` (project file in repo root)

Codex:

- `~/.codex/config.toml` -> `[mcp_servers.<name>]` (global/user)
- `./.codex/config.toml` -> `[mcp_servers.<name>]` (project file)

Important for Claude CLI:

- `claude mcp add` defaults to local scope.
- Use `--scope user` when you want it globally visible across projects.

### Skills discovery

Claude Code skills:

- `~/.claude/skills/<name>/SKILL.md` (global/user)
- `./.claude/skills/<name>/SKILL.md` (project)

Codex skills:

- `~/.agents/skills/<name>/SKILL.md` (global/user)
- `./.agents/skills/<name>/SKILL.md` (project)

After adding skills, open `/skills` and the relevant agent detail page to verify availability/toggles.

## Tests

```bash
bun test          # scoped to src/ via bunfig.toml
bun run test      # same, with cleanup of any test-leftover DBs
```
