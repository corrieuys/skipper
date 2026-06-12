<p align="center">
  <img src="src/html/public/icon2.png" alt="" height="40" valign="middle"><span style="font-size:2em; font-weight:600; vertical-align:middle;">&nbsp;&nbsp;Skipper</span>
</p>

Skipper is a multi-agent orchestration platform for coordinating teams of AI agents.

Why Skipper? Skipper is an experiment in optimizing token usage by selecting a preconfigured phased based approach to accomplishing a task, instead of allowing agents to self discover and converge on a goal. The required context for large tasks are commonly known beforehand, and Skipper allows you to optimize context management across multiple agents, depending on their role. It manages task lifecycles, team hierarchies, phase-based execution, delegation, artifacts, and human escalations.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.2+
- (Coming soon) For local real-time transcription: `cmake`, C++ compiler, `ffmpeg`
- Provider CLI(s) installed and logged in (`claude` for Claude Code and/or `codex` for OpenAI Codex)

### Run from source

```bash
bun install
bun run start
```

Open port 3000 in your browser. Port 3000 is used by default (override with `PORT`).

## Feature Overview

- **Structured task orchestration** with retry, resume, cancel, and iterate loops.
- **Team-based, phased execution model.** Role-aware delegation, phased-based team configuration.
- **Delegation engine** for single-subtask hand-off.
- **Human-in-the-loop escalations** for uncertain/blocked execution.
- **Versioned artifacts** (`transcript`, `summary`, `plan`, `other`) with immutable history.
- **Health monitoring** (stuck detection, nudges, process liveness, incident clustering).
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

## How Skipper Works

Skipper is a long-running daemon that drives external provider CLIs (Claude Code, Codex) as worker agents and coordinates them with a tick loop, an internal MCP control plane, and per-task configuration assembled from **teams** (high-level process shape) and **templates** (granular, per-phase instructions). The sections below walk through each layer.

### The daemon and tick loop

The process boots a single `ManagerDaemon` (`src/agents/manager-daemon.ts`) that wires together the orchestrator modules and subscribes to the event bus. 

A task moves through a fixed lifecycle:

```
draft → approved → running → completed | failed
```

Every ~30 seconds the **tick loop** (`src/orchestrator/tick-loop.ts`) reconciles state: it health-checks running agents, recovers stale tasks, pulls **one approved task per tick** off the queue, advances or regresses phases, cleans up finished delegations and escalations, and persists a checkpoint. Each task runs through its team's **phases** in order (phase index starts at 0). Skipper itself is always the entrypoint agent for a phase; it reads the phase prompt plus any artifacts and decides whether to do the work directly or delegate it.

### Internal MCP tools (the control plane)

Each spawned agent gets a private connection to Skipper's own MCP server — `skipper-daemon`, served at `/mcp` — injected at spawn time with a per-agent bearer token equal to its runtime id.

Tool visibility is **role-based** and locked when the agent's session is created (`src/mcp/tools.ts`):

- **Root Skipper** (the task entrypoint) — the full set: `create_note` / `list_notes`, `create_artifact` / `get_artifact` / `list_artifacts`, `create_escalation` (human-in-the-loop), the delegation tools (`delegate`, `delegate_resume`, `list_delegations`), and the phase-lifecycle tools (`complete_phase`, `regress_phase`, `complete_task`).
- **Delegated children** — the same set **minus** the phase-lifecycle tools. A child can take notes, write artifacts, escalate, and delegate further, but only root Skipper can advance or complete the task.


The key delegation primitives are `delegate({ to, prompt })` to start a fresh sub-agent for a role, and `delegate_resume({ child_instance_id, prompt })` to re-engage a prior sub-agent with its full conversation context intact — preferred when the follow-up work is a continuation (e.g. asking the same coder to fix a test failure). `complete_phase` advances to the next phase; `complete_task` ends the task and may only be called in the final phase.

### Provider MCP servers and skills must be in place

A Skipper agents are only as capable as the provider CLI behind it, so the provider environment has to be set up **before** a task runs:

1. **The CLI must be installed and authenticated** for the same OS user running Skipper. If `claude` or `codex` is missing or logged out, agent spawn/resume fails and the task fails at runtime.
2. **Provider MCP servers are read from the provider's own config, not duplicated in Skipper.** At spawn Skipper reads the live MCP server lists (`src/config-readers/mcp.ts`) — for Claude Code from `~/.claude.json` (user + per-project) and `./.mcp.json`; for Codex from `~/.codex/config.toml` and `./.codex/config.toml` — filters to the enabled ones, writes a temporary provider config, and appends the `skipper-daemon` entry to it. So any third-party MCP tool you want an agent to use (a database tool, a browser tool, a company API) must already be configured and authenticated in the provider's config for the current working directory.
3. **Skills are discovered the same way** (`src/config-readers/skills.ts`): Claude Code skills from `~/.claude/skills/<name>/SKILL.md` and `./.claude/skills/...`; Codex skills from `~/.agents/skills/...`. Each discovered skill's name and description are summarized into the agent's prompt so the agent knows it is available.

### Bespoke workloads: teams for process, templates for control

Skipper separates the **shape** of a workflow from the **detailed instructions** for a specific kind of task.

**Teams define the high-level process** (`src/teams/manager.ts`, `config/teams.json`). A team is an ordered list of phases; each phase carries a prompt, an optional review gate, and the role(s) involved. Skipper is enforced as the entrypoint of every phase. For example, the bundled **Software Team** has three phases — **Planning** (with a review gate), **Implementation**, and **Cleanup** — and its Implementation phase prompt tells Skipper how to orchestrate worker roles: read the plan artifact, delegate to a coder, then a tester, loop coder↔tester on failures via `delegate_resume`, and run a final validator gate before advancing. The team says *what stages exist and how delegation should flow*; it is reusable across many tasks.

**Templates add granular, per-task control on top of a team** (`src/templates/helpers.ts`, `task_templates` + `task_template_phases` tables). A template is bound to a team and lets you supply:

- a **template-level Skipper prompt** that applies across the whole task,
- a **per-phase prompt** that either **appends to** or **replaces** the team's phase prompt (the `override_prompt` flag), and
- per-phase **review** and **consensus** overrides, plus **hooks**.

At runtime `resolvePhaseConfig()` layers these: **team base prompt → template override → task-level override**. This is where an operator writes the detailed instructions a generic team prompt deliberately leaves out — *which specific MCP tools an agent should call, which skills to invoke, what conventions and acceptance criteria apply, what to escalate on.*

As a high-level illustration: a **"feature" template** built on a software agent team can tell each phase exactly which provider MCP tools the agents should reach for, like Jira, Github, Data Dog, etc, and which skills to invoke for that codebase. A **"bug" template** can narrow the same team to a bug-fixing workflow — describing, per phase, the specific tools to use for reproduction and verification and the skills that encode the project's debugging conventions. The team supplies the phase skeleton; the template supplies the tool- and skill-level direction for that particular class of work.

The precedence is worth stating plainly: **a team gives you a repeatable process; a template specializes that process for a kind of task by spelling out the tools, skills, and instructions; and an individual task can still override its template for one-off needs.**


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

## Meet Greg

Greg is the dashboard mascot. He brings zero productivity and is proud of it. Toggle him on or off with the 🐒 button in the navbar. He watches your tasks and agents work, then chimes in with short, playful one-liners: ribbing the robots for thinking too long, teasing the operator for backspacing twenty times, and taking credit for nothing. Greg jumps around the UI, and slides down the sidebar when he is happy.