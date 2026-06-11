<p align="center">
  <img src="src/html/public/icon2.png" alt="" height="40" valign="middle"><span style="font-size:2em; font-weight:600; vertical-align:middle;">&nbsp;&nbsp;Skipper</span>
</p>

Skipper is a multi-agent orchestration platform for coordinating teams of AI agents.

Why Skipper? Skipper is an experiment in optimizing token usage by selecting a preconfigured phased based approach to accomplishing a task, instead of allowing agents to self discover and converge on a goal. The required context for large tasks are commonly known beforehand, and Skipper allows you to optimize context management across multiple agents, depending on their role. It manages task lifecycles, team hierarchies, phase-based execution, delegation, artifacts, and human escalations.

## Feature Overview

- **Structured task orchestration** with retry, resume, cancel, and iterate loops.
- **Team-based, phased execution model.** Role-aware delegation, phased-based team configuration.
- **Delegation engine** for single-subtask hand-off.
- **Human-in-the-loop escalations** for uncertain/blocked execution.
- **Versioned artifacts** (`transcript`, `summary`, `plan`, `other`) with immutable history.
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

## Coming Soon

- **Real-Time Tasks** — live collaboration with Skipper in the loop (brainstorming, meetings, event storming) via continuous audio/text ingestion, transcription, summarization, and timeline-driven agent action.
- **Scheduled Tasks** — cron-style recurring task creation.

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