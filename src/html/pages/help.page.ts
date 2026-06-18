import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { isExperimental } from "../../config/feature-flags";

export interface HelpPageViewModel {
  escalationCount: number;
  daemonState: string;
  daemonUptime: number;
}

function section(id: string, title: string, body: string): string {
  return `
    <div id="${id}" class="sk-panel" style="margin-bottom: var(--sk-space-6);">
      <div class="sk-panel__header">
        <span class="sk-panel__title">${title}</span>
      </div>
      <div class="sk-panel__body">
        ${body}
      </div>
    </div>`;
}

export function helpPage(vm: HelpPageViewModel): string {
  const experimental = isExperimental();
  const toc = `
    <div class="sk-panel" style="margin-bottom: var(--sk-space-6);">
      <div class="sk-panel__header">
        <span class="sk-panel__title">Contents</span>
      </div>
      <div class="sk-panel__body">
        <ol style="margin: 0; padding-left: var(--sk-space-6); line-height: 2;">
          <li><a href="#overview">Overview</a></li>
          <li><a href="#teams">Teams</a></li>
          <li><a href="#templates">Templates</a></li>
          <li><a href="#tasks">Tasks</a></li>
          <li><a href="#delegation">Delegation${experimental ? " &amp; Consensus" : ""}</a></li>
          <li><a href="#escalations">Escalations</a></li>
          <li><a href="#artifacts">Artifacts &amp; Notes</a></li>
          <li><a href="#agents">Agent Types &amp; Configuration</a></li>
          ${experimental ? `<li><a href="#realtime">Realtime Sessions</a></li>` : ""}
          ${experimental ? `<li><a href="#hooks">User Hooks</a></li>` : ""}
          <li><a href="#mcp">MCP (Model Context Protocol)</a></li>
          ${experimental ? `<li><a href="#conversations">Conversations</a></li>` : ""}
          <li><a href="#notifications">Notifications &amp; WebSocket</a></li>
          <li><a href="#config">Configuration</a></li>
          <li><a href="#analytics">Analytics &amp; Logs</a></li>
        </ol>
      </div>
    </div>`;

  const overview = section("overview", "Overview", `
    <p>Skipper is a <strong>multi-agent orchestrator</strong> that spawns and coordinates external CLI agents — claude-code, codex, opencode, oz — to execute long-running tasks through structured phases of work.</p>
    <h3 style="margin-top: var(--sk-space-4);">Architecture</h3>
    <ul>
      <li>A <strong>daemon tick loop</strong> runs every 30 seconds, picking the next approved task from the queue and spawning the entrypoint agent.</li>
      <li>Agents communicate with the orchestrator via <strong>MCP tools</strong> (primary) or <strong>stdout markers</strong> (legacy). Signals route through an event bus to the relevant handler modules.</li>
      <li>The daemon manages phase progression, delegation, escalations,${experimental ? " consensus," : ""} recovery, and health monitoring.</li>
    </ul>
    <h3 style="margin-top: var(--sk-space-4);">UI Overview</h3>
    <ul>
      <li>Server-rendered HTML dashboard, updated in real time via <strong>WebSocket push</strong> and HTMX polling.</li>
      <li>Pages: Dashboard (Command Center), Tasks, Escalations, Config, Templates, Analytics, Logs, Help.</li>
      <li>The sidebar on the Dashboard lists tasks; clicking one loads the task workspace into the main area without a full page reload.</li>
    </ul>
  `);

  const teams = section("teams", "Teams (Core Concept)", `
    <p>A <strong>team</strong> is the foundational organizational unit in Skipper. It defines <em>how</em> agents collaborate on a task: the roles they play, their hierarchy, and the phases of work they follow.</p>

    <h3 style="margin-top: var(--sk-space-4);">Team Structure</h3>
    <ul>
      <li><strong>name</strong> — human-readable label (e.g. "Software Team").</li>
      <li><strong>goal</strong> — the team's purpose statement, injected into agent prompts.</li>
      <li><strong>entrypoint_agent_id</strong> — the lead agent (typically Skipper) that is spawned when a task starts. This agent drives the work and coordinates other team members.</li>
      <li><strong>phases</strong> — an ordered list of execution stages (see Phases below).</li>
    </ul>

    <h3 style="margin-top: var(--sk-space-4);">Team Membership</h3>
    <p>Each team has a roster of agent members. Every member has:</p>
    <ul>
      <li><strong>role</strong> — what the agent does (e.g. developer, qa, analyst, tester, lead).</li>
      <li><strong>level</strong> — hierarchy position. <code>0</code> = lead/orchestrator; <code>1+</code> = workers that can be delegated to.</li>
      <li><strong>parent_agent_id</strong> — optional structural parent in the hierarchy.</li>
    </ul>
    <p>The lead agent (level 0) orchestrates the team by delegating sub-tasks to workers (level 1+) and advancing the task through phases.</p>

    <h3 style="margin-top: var(--sk-space-4);">Phases</h3>
    <p>Phases are the sequential execution stages of a task. A typical software team might have: <em>Planning → Implementation → Testing → Cleanup</em>. Each phase defines:</p>
    <ul>
      <li><strong>name</strong> — identifier used in templates and phase overrides.</li>
      <li><strong>prompt</strong> — instructions injected into the entrypoint agent when this phase starts. The agent is respawned or resumed with the new prompt at each phase transition.</li>
      <li><strong>review</strong> (optional boolean) — when <code>true</code>, the task pauses after this phase completes and waits for human approval via the Escalations UI before advancing to the next phase.</li>
      ${experimental ? `<li><strong>consensus</strong> (optional object) — enables parallel multi-agent execution for the phase. Multiple agents tackle the same problem independently; a consensus reviewer merges or selects the best result. Config: <code>agent_count</code>, <code>strategy</code> (best_of or merge), <code>worktree</code>, <code>reviewer_agent_id</code>.</li>` : ""}
    </ul>

    <h3 style="margin-top: var(--sk-space-4);">Review Gates</h3>
    <p>When a phase has <code>review: true</code>, the task enters a <strong>needs_review</strong> state after the phase completes. The Dashboard shows a review banner. The operator approves or rejects from the UI, injecting their decision back into the lead agent on resume.</p>

    <h3 style="margin-top: var(--sk-space-4);">How Teams Orchestrate Agents</h3>
    <p>The entrypoint agent (Skipper) coordinates by:</p>
    <ul>
      <li>Calling <code>delegate</code> or <code>delegate_batch</code> MCP tools to spawn child agents for sub-tasks.</li>
      <li>Calling <code>complete_phase</code> to advance to the next phase (after passing any review gate).</li>
      <li>Calling <code>escalate</code> to surface questions to the human operator.</li>
      <li>Calling <code>complete_task</code> when the final phase finishes.</li>
    </ul>
    <p>Example teams: <strong>Software Team</strong> (4 phases, 6 members including Analyst, Coder, Tester, Validator) and <strong>Lean Software Team</strong> (2 phases, 3 members).</p>
  `);

  const templates = section("templates", "Templates (Core Concept)", `
    <p>A <strong>template</strong> is a reusable configuration package bound to a team. It customises phase behaviour for a specific domain or workflow without changing the team's base definition. The same team can be reused across many task types — templates provide the domain-specific layer on top.</p>

    <h3 style="margin-top: var(--sk-space-4);">Template Structure</h3>
    <ul>
      <li><strong>template_name</strong> — descriptive name shown in task creation dropdowns.</li>
      <li><strong>team_id</strong> — the team this template applies to.</li>
      <li><strong>skipper_prompt</strong> — optional additional instructions for the lead agent, appended to (or replacing) the base team prompt.</li>
      ${experimental ? `<li><strong>hooks</strong> — task lifecycle shell commands: <code>pre-run</code>, <code>post-run</code>, and event-triggered hooks. Executed by the orchestrator, not agents.</li>` : ""}
      <li><strong>per-phase overrides</strong> — per-phase configuration changes (see below).</li>
    </ul>

    <h3 style="margin-top: var(--sk-space-4);">Per-Phase Overrides</h3>
    <p>Templates can override any phase's settings independently:</p>
    <ul>
      <li><strong>prompt</strong> — additional (or replacement) instructions for the phase.</li>
      <li><strong>override_prompt</strong> — if <code>true</code>, the template prompt <em>replaces</em> the team's base phase prompt entirely. If <code>false</code> (default), the template prompt is <em>appended</em> to the base prompt.</li>
      <li><strong>review_override</strong> — set to <code>true</code> or <code>false</code> to enable or disable the review gate for a specific phase, overriding the team's setting. Set to <code>null</code> to inherit from the team.</li>
      ${experimental ? `<li><strong>consensus_override</strong> — override or disable consensus for a phase. Set to a consensus config object to enable, <code>null</code> to disable, or omit to inherit from the team.</li>` : ""}
    </ul>

    <h3 style="margin-top: var(--sk-space-4);">Resolution Hierarchy</h3>
    <p>When a phase starts, its effective configuration is resolved in order of precedence (highest wins):</p>
    <ol>
      <li><strong>Task-level override</strong> — per-phase settings set at task creation time (review gate${experimental ? ", consensus" : ""}).</li>
      <li><strong>Template override</strong> — the template's <code>review_override</code>${experimental ? " / <code>consensus_override</code>" : ""} / prompt settings.</li>
      <li><strong>Team base</strong> — the team's phase definition (prompt, review${experimental ? ", consensus" : ""}).</li>
    </ol>
    <p>Prompts combine team + template levels (append or replace per <code>override_prompt</code>). Review${experimental ? " and consensus" : ""} use${experimental ? " all three" : " both"} levels. This is implemented in <code>resolvePhaseConfig()</code> in the orchestrator.</p>

    <h3 style="margin-top: var(--sk-space-4);">Templates and Tasks</h3>
    <p>When creating a task, you select an optional template from the team's available templates. At runtime, each time a phase starts, the orchestrator calls <code>resolvePhaseConfig()</code> with the team definition, template overrides, and any per-task overrides — producing the final effective prompt and phase settings for that run.</p>
    <p>Templates are managed at <a href="/templates">Templates</a>.${experimental ? " Each template's hook execution history is visible in the template edit form." : ""}</p>
  `);

  const tasks = section("tasks", "Tasks", `
    <p>A <strong>task</strong> is the unit of work in Skipper. It ties together a team, an optional template, a description, and lifecycle state.</p>

    <h3 style="margin-top: var(--sk-space-4);">Lifecycle</h3>
    <pre style="background: var(--sk-surface-1); padding: var(--sk-space-3); border-radius: var(--sk-radius-sm); font-family: var(--sk-font-mono); font-size: 13px;">draft → approved → running → completed | failed</pre>
    <ul>
      <li><strong>draft</strong> — created but not yet approved for execution.</li>
      <li><strong>approved</strong> — queued for the daemon to pick up on the next tick.</li>
      <li><strong>running</strong> — an agent is actively working on it.</li>
      <li><strong>completed</strong> — all phases finished successfully.</li>
      <li><strong>failed</strong> — the task ended with an error or was cancelled.</li>
    </ul>
    <p>Additional transitions: <em>unapprove</em> (approved→draft), <em>iterate</em> (completed→approved to re-run), <em>retry/resume</em> (failed→draft or approved), <em>cancel</em> (any active state→failed).</p>

    <h3 style="margin-top: var(--sk-space-4);">Configuration</h3>
    <ul>
      <li>Team assignment and optional template selection.</li>
      <li>Per-phase overrides for review gates${experimental ? " and consensus settings" : ""}.</li>
      <li>Working directory — the filesystem path the entrypoint agent operates in.</li>
      ${experimental ? `<li>Task-level hooks for pre/post run shell commands.</li>` : ""}
    </ul>

    ${experimental ? `<h3 style="margin-top: var(--sk-space-4);">Recurring Tasks</h3>
    <p>Recurring tasks can use an interval (amount + unit: minutes, hours, days) to automatically create and approve new task instances at the specified interval. The interval is optional — leave it unset and the task only runs when you trigger it with Run Now. Manage them at <a href="/tasks">Tasks</a> under the Recurring tab.</p>` : ""}

    <h3 style="margin-top: var(--sk-space-4);">Queue Behaviour</h3>
    <p>The daemon picks one approved standard task per 30-second tick.${experimental ? " Realtime tasks bypass the queue and start immediately." : ""} Only one task runs at a time in the standard queue.</p>
  `);

  const delegation = section("delegation", `Delegation${experimental ? " &amp; Consensus" : ""}`, `
    <p><strong>Delegation</strong> is how the lead agent (Skipper) distributes sub-tasks to specialist team members during a phase.</p>

    <h3 style="margin-top: var(--sk-space-4);">How it works</h3>
    <ul>
      <li>The lead calls the <code>delegate</code> MCP tool with a prompt and a target agent ID. The orchestrator spawns the child agent as a subprocess.</li>
      <li>For parallel work, <code>delegate_batch</code> spawns multiple child agents simultaneously. Results are collected and returned to the parent together.</li>
      <li>Child agents run with a reduced MCP tool set — they cannot advance phases or complete the task, only communicate results back to the parent via <code>[DELEGATE_COMPLETE]</code> or by exiting.</li>
      <li>The parent is resumed with the child's result injected into its context.</li>
      <li>A <strong>max delegations per parent per task</strong> limit prevents runaway delegation loops.</li>
    </ul>

    ${experimental ? `<h3 style="margin-top: var(--sk-space-4);">Consensus Mode</h3>
    <p>When a phase has consensus configured, the orchestrator spawns <em>N</em> parallel agents to tackle the same problem independently (optionally in isolated git worktrees). A designated <strong>consensus reviewer</strong> agent then compares all outputs and either selects the best result or merges them. This improves reliability for high-stakes phases like code review or complex analysis.</p>
    <ul>
      <li><strong>best_of</strong> strategy — the reviewer picks the single best output.</li>
      <li><strong>merge</strong> strategy — the reviewer synthesises outputs into a combined result.</li>
      <li>Worktree mode — each agent works in an isolated git worktree; the reviewer merges the winning branch.</li>
    </ul>` : ""}
  `);

  const escalations = section("escalations", "Escalations", `
    <p><strong>Escalations</strong> are how agents surface questions or decisions to the human operator when they cannot proceed autonomously.</p>
    <ul>
      <li>Any agent calls the <code>escalate</code> MCP tool with an HTML-formatted question. The task pauses.</li>
      <li>The <a href="/escalations">Escalations</a> queue in the UI shows all open questions, grouped by task.</li>
      <li>The operator types a response and submits. The orchestrator injects the response back into the paused agent, which resumes from where it stopped.</li>
      <li>Escalations can also be <strong>dismissed</strong> without a response — the agent resumes with a signal that the question was dismissed.</li>
      <li>If a task completes or fails while escalations are still open, those escalations are automatically reconciled (closed).</li>
    </ul>
    <p>The navbar badge shows the current count of open escalations across all tasks.</p>
  `);

  const artifacts = section("artifacts", "Artifacts &amp; Notes", `
    <h3>Artifacts</h3>
    <p>Artifacts are <strong>named, versioned data blobs</strong> that agents produce and share within a task. Each time an agent writes an artifact with the same name, a new version is created — prior versions are preserved in history.</p>
    <ul>
      <li><strong>kinds</strong>: transcript, summary, plan, other.</li>
      <li>Valid uses: implementation plans, analysis reports, meeting transcripts, generated code summaries.</li>
      <li>Agents access artifacts via <code>create_artifact</code>, <code>get_artifact</code>, and <code>list_artifacts</code> MCP tools.</li>
      <li>Viewable and editable in the task detail panel (Artifacts tab). Editing creates a new version.</li>
    </ul>

    <h3 style="margin-top: var(--sk-space-4);">Notes</h3>
    <p>Notes are short inline observations (max ~280 characters) recorded by agents for team visibility. They appear in the task detail Notes tab and are delivered to subsequent agent runs on the same task as context.</p>
  `);

  const agents = section("agents", "Agent Types &amp; Configuration", `
    <h3>Supported CLIs</h3>
    <p>Skipper spawns these external agent CLIs: <strong>claude-code</strong>, <strong>codex</strong>, <strong>opencode</strong>, <strong>oz</strong>. Each has different capabilities around stdin, resume sessions, and JSON output mode.</p>

    <h3 style="margin-top: var(--sk-space-4);">Agent Types</h3>
    <p>Agent types define capabilities shared across all instances of that CLI:</p>
    <ul>
      <li>Supported model families.</li>
      <li>Whether the agent supports stdin input (<code>supports_stdin</code>).</li>
      <li>Whether the agent supports resuming a prior session (<code>supports_resume</code>).</li>
      <li>JSON output mode (for structured signal parsing).</li>
    </ul>

    <h3 style="margin-top: var(--sk-space-4);">Agent Instances (Definitions)</h3>
    <p>Agent instances are named, configurable identities built on top of an agent type:</p>
    <ul>
      <li><strong>name</strong> — used in team membership and delegation prompts (e.g. "Coder", "Tester", "Skipper").</li>
      <li><strong>model</strong> — the specific model to use (e.g. claude-sonnet-4-6).</li>
      <li><strong>instruction</strong> — system-level prompt injected at spawn time.</li>
      <li><strong>capabilities</strong> — descriptive tags used by the orchestrator for routing.</li>
    </ul>
    <p>Configure agents at <a href="/config">Config</a>.</p>
  `);

  const realtime = section("realtime", "Realtime Sessions", `
    <p>Realtime tasks process live audio and text input for immediate agent handling, bypassing the normal 30-second tick queue.</p>
    <ul>
      <li><strong>Audio ingestion</strong> — microphone audio is transcribed using a local whisper.cpp server (started automatically on record) or the OpenAI transcription API.</li>
      <li><strong>Text ingestion</strong> — typed text is injected directly into the timeline with high priority and triggers an immediate feed to Skipper when idle.</li>
      <li><strong>Segment deduplication</strong> — overlapping audio is deduplicated (exact + fuzzy matching) before reaching agents.</li>
      <li><strong>Summarisation</strong> — a summarizer agent cleans raw transcriptions into readable text before feeding to Skipper.</li>
      <li>Realtime tasks have their own dedicated team and appear in a separate timeline view on the Dashboard.</li>
    </ul>

    <h3 style="margin-top: var(--sk-space-4);">Pipeline Timing</h3>
    <p>The realtime pipeline operates on a <strong>cadence tick</strong> (default 60s). Each tick runs three stages sequentially:</p>
    <ol>
      <li><strong>Transcribe</strong> — all pending audio segments are sent to whisper, deduped, and stored as text.</li>
      <li><strong>Summarize</strong> (fire-and-forget) — a summarizer agent is spawned to clean/condense raw transcriptions. Output lands in the timeline on exit.</li>
      <li><strong>Feed Skipper</strong> (fire-and-forget) — all unfed timeline entries are batched and sent to the entrypoint agent. Skipped if Skipper is busy (running, has active delegations, or delegation groups).</li>
    </ol>
    <p>Because the summarizer runs async, its output reaches Skipper on the <em>next</em> tick. Worst-case latency: speech → Skipper ≈ 3 minutes (flush + transcribe + summarize + feed).</p>

    <h3 style="margin-top: var(--sk-space-4);">Audio Flush &amp; Overlap</h3>
    <p>The browser accumulates 1-second MediaRecorder chunks and flushes them as a single WebM blob every flush interval (cadence, capped at 60s). Each blob includes 5 seconds of overlap from the previous flush to prevent words being cut at boundaries. The server deduplicates the repeated audio after transcription.</p>

    <h3 style="margin-top: var(--sk-space-4);">Whisper Lifecycle</h3>
    <p>Clicking <strong>Record</strong> starts the whisper server automatically. When recording stops, the client signals <code>recording.stopped</code> over WebSocket — the server transcribes any final pending audio, then shuts whisper down. Whisper can also be stopped manually via the API.</p>
  `);

  const hooks = section("hooks", "User Hooks", `
    <p>Hooks are shell commands that the orchestrator executes automatically in response to task lifecycle events. They run outside of any agent process.</p>

    <h3 style="margin-top: var(--sk-space-4);">Supported events</h3>
    <ul>
      <li><code>task.started</code> — fired when a task transitions to running.</li>
      <li><code>task.completed</code> — fired when a task finishes successfully.</li>
      <li><code>task.failed</code> — fired on task failure or cancellation.</li>
      <li><code>escalation.created</code> — fired when an agent escalates a question.</li>
      <li><code>escalation.resolved</code> — fired when the operator responds to an escalation.</li>
      <li><code>phase.review_pending</code> — fired when a phase completes and is waiting for human review.</li>
    </ul>

    <h3 style="margin-top: var(--sk-space-4);">Placeholder substitution</h3>
    <p>Hook command strings support placeholders: <code>&#123;&#123;task.id&#125;&#125;</code>, <code>&#123;&#123;task.title&#125;&#125;</code>, <code>&#123;&#123;escalation.id&#125;&#125;</code>, etc. The orchestrator substitutes these at execution time.</p>

    <h3 style="margin-top: var(--sk-space-4);">Limits &amp; configuration</h3>
    <ul>
      <li>30-second timeout per hook execution.</li>
      <li>Hooks can be configured per-template (in the Templates editor) or per-task.</li>
      <li>Hook execution history is shown in the template edit form.</li>
    </ul>
  `);

  const mcp = section("mcp", "MCP (Model Context Protocol)", `
    <p>MCP is the <strong>primary</strong> communication channel between agents and the Skipper orchestrator. Agents call strongly-typed tools on the daemon's MCP server instead of printing stdout markers.</p>

    <h3 style="margin-top: var(--sk-space-4);">Transport</h3>
    <p>Streamable HTTP at <code>/mcp</code>. Agents authenticate using a Bearer token equal to their runtime ID, set at spawn time.</p>

    <h3 style="margin-top: var(--sk-space-4);">Tool sets by role</h3>
    <ul>
      <li><strong>Root Skipper agent</strong> — full tool set: delegate, delegate_batch, complete_phase, regress_phase, complete_task, escalate, create_note, create_artifact, get_artifact, list_artifacts, send_message.</li>
      <li><strong>Delegated child agents</strong> — reduced set: create_note, list_notes, create_artifact, list_artifacts, get_artifact, create_escalation. Phase lifecycle tools are rejected.</li>
      <li><strong>External API key holders</strong> — task-management-only tools (for external integrations).</li>
    </ul>

    <h3 style="margin-top: var(--sk-space-4);">Stdout markers (legacy)</h3>
    <p>A narrow set of stdout markers is still parsed for backward compatibility: <code>[MSG:...]</code>, <code>[DELEGATE_COMPLETE]</code>, and a few conversation-agent-only markers. All other orchestration is MCP-only.</p>
  `);

  const conversations = section("conversations", "Conversations", `
    <p>The Conversations feature provides a <strong>chat interface</strong> for interacting with Skipper or specific agents outside the task pipeline — useful for quick questions, planning sessions, or ad-hoc analysis.</p>
    <ul>
      <li>Accessible from the chat panel on the Dashboard or the fullscreen chat view.</li>
      <li>Supports text and multi-part messages.</li>
      <li>Each conversation is persistent and can be resumed across sessions.</li>
      <li><strong>Permission modes</strong> — conversations can run in default, plan, or bypassPermissions mode depending on the required trust level.</li>
      <li>Multiple conversations can be active simultaneously; the sidebar lists them all.</li>
    </ul>
  `);

  const notifications = section("notifications", "Notifications &amp; WebSocket", `
    <h3>Desktop Notification Sounds</h3>
    <p>Skipper plays audio cues when key events occur. Each event can be independently enabled or disabled in <a href="/config">Config → Notifications</a>:</p>
    <ul>
      <li>Task started, completed, failed.</li>
      <li>Escalation created (agent needs your input).</li>
      <li>Phase review pending (awaiting human approval).</li>
    </ul>

    <h3 style="margin-top: var(--sk-space-4);">WebSocket Push</h3>
    <p>The UI maintains a persistent WebSocket connection to the server. The orchestrator pushes real-time fragment updates over this channel, eliminating the need to poll most panels:</p>
    <ul>
      <li>Task status badge updates.</li>
      <li>Escalation count badge.</li>
      <li>Dashboard panel refreshes (active agents, phase indicator).</li>
      <li>Notification sound triggers.</li>
    </ul>
    <p>HTMX polling is used as a fallback for panels that need periodic refresh when WebSocket is not carrying that specific update.</p>
  `);

  const config = section("config", "Configuration", `
    <p>The <a href="/config">Config</a> page is the central control panel for all persistent Skipper settings.</p>
    <ul>
      <li><strong>Agent types</strong> — view the supported CLI types and their capabilities.</li>
      <li><strong>Agent instances</strong> — create, edit, and export named agents with specific models and instructions.</li>
      <li><strong>Teams</strong> — view, edit, and export team definitions (members, phases, entrypoint).</li>
      <li><strong>Feature flags</strong> — enable/disable agent and team visibility in the UI.</li>
      <li><strong>Skipper prompt</strong> — customise the lead agent's base instructions.</li>
      <li><strong>Appearance</strong> — themes, background wallpapers (upload or choose from gallery).</li>
      <li><strong>API keys</strong> — manage keys for external clients that need access to task management tools via MCP.</li>
      <li><strong>Notification sounds</strong> — per-event audio preference toggles.</li>
      <li><strong>Housekeeping</strong> — purge old terminal output and agent session logs to reclaim disk space.</li>
    </ul>
    <p>Agent and team config can be <strong>exported</strong> back to the JSON config files (<code>config/agents.json</code>, <code>config/teams.json</code>) so changes survive database resets.</p>
  `);

  const analytics = section("analytics", "Analytics &amp; Logs", `
    <h3>Token Analytics</h3>
    <p>The <a href="/analytics/tokens">Analytics</a> page shows token usage aggregated by agent type and model:</p>
    <ul>
      <li>Input, output, cache read, and cache write tokens per agent.</li>
      <li>Instance count and total usage events.</li>
      <li>Summary totals across all agents.</li>
    </ul>

    <h3 style="margin-top: var(--sk-space-4);">Log Viewer</h3>
    <p>The <a href="/logs">Logs</a> page shows raw terminal output from all agent processes, filterable by agent and stream (stdout/stderr). Useful for debugging agent behaviour.</p>

    <h3 style="margin-top: var(--sk-space-4);">Agent Terminal Output</h3>
    <p>Each task has a <strong>Terminal</strong> tab showing the full stdout/stderr of the entrypoint agent. Individual agent instance terminals are also accessible from the task's agent tree, and from task links in the log viewer.</p>
  `);

  const content = `
    ${navbar({ currentPath: "/help", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <style>
      .sk-help-page { max-width: 900px; margin: 0 auto; padding: var(--sk-space-6); padding-bottom: var(--sk-space-12); }
      .sk-help-page .sk-panel__body {
        padding: var(--sk-space-4) var(--sk-space-6);
        font-size: var(--sk-text-sm);
        line-height: 1.7;
      }
      .sk-help-page .sk-panel__body p { margin: 0 0 var(--sk-space-3); }
      .sk-help-page .sk-panel__body ul,
      .sk-help-page .sk-panel__body ol { margin: 0 0 var(--sk-space-3); padding-left: var(--sk-space-6); }
      .sk-help-page .sk-panel__body li { margin-bottom: var(--sk-space-1); }
      .sk-help-page .sk-panel__body h3 { font-size: var(--sk-text-base); }
      .sk-help-page .sk-panel__body pre { margin: var(--sk-space-3) 0; }
      .sk-help-page .sk-panel__body code { font-size: 0.85em; padding: 1px 4px; background: var(--sk-surface-2); border-radius: 3px; }
      .sk-help-page .sk-panel__body pre code { padding: 0; background: none; }
    </style>
    <div class="sk-help-page">
      <div class="sk-page-header">
        <h1 class="sk-page-header__title">Help</h1>
        <p class="sk-muted" style="margin-top: var(--sk-space-2);">Reference documentation for the Skipper multi-agent orchestrator UI.</p>
      </div>

      ${toc}
      ${overview}
      ${teams}
      ${templates}
      ${tasks}
      ${delegation}
      ${escalations}
      ${artifacts}
      ${agents}
      ${experimental ? realtime : ""}
      ${experimental ? hooks : ""}
      ${mcp}
      ${experimental ? conversations : ""}
      ${notifications}
      ${config}
      ${analytics}
    </div>
  `;

  return v2layout("Help", content, "/help");
}
