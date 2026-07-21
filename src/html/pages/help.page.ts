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
          <li><a href="#tasks">Tasks</a></li>
          <li><a href="#delegation">Delegation${experimental ? " &amp; Consensus" : ""}</a></li>
          <li><a href="#escalations">Escalations</a></li>
          <li><a href="#artifacts">Artifacts &amp; Notes</a></li>
          <li><a href="#agents">Agent Types &amp; Agents</a></li>
          ${experimental ? `<li><a href="#realtime">Realtime Sessions</a></li>` : ""}
          <li><a href="#mcp">MCP (Model Context Protocol)</a></li>
          ${experimental ? `<li><a href="#conversations">Conversations</a></li>` : ""}
          <li><a href="#notifications">Notifications &amp; WebSocket</a></li>
          <li><a href="#config">Configuration</a></li>
          <li><a href="#logs">Logs</a></li>
        </ol>
      </div>
    </div>`;

  const overview = section("overview", "Overview", `
    <p>Skipper is a <strong>multi-agent orchestrator</strong> that spawns and coordinates external CLI agents — claude-code, codex, opencode, grok — to execute long-running tasks through structured phases of work.</p>
    <h3 style="margin-top: var(--sk-space-4);">Architecture</h3>
    <ul>
      <li>A <strong>daemon tick loop</strong> runs every 30 seconds, picking the next approved task from the queue and spawning the entrypoint agent.</li>
      <li>Agents communicate with the orchestrator via <strong>MCP tools</strong> (primary) or <strong>stdout markers</strong> (legacy). Signals route through an event bus to the relevant handler modules.</li>
      <li>The daemon manages phase progression, delegation, escalations,${experimental ? " consensus," : ""} recovery, and health monitoring.</li>
    </ul>
    <h3 style="margin-top: var(--sk-space-4);">UI Overview</h3>
    <ul>
      <li>Server-rendered HTML dashboard, updated in real time via <strong>WebSocket push</strong> and HTMX polling.</li>
      <li>Pages: Dashboard (Command Center), Tasks, Escalations, Config, Logs${experimental ? ", Global Store" : ""}, Help.</li>
      <li>The sidebar on the Dashboard lists tasks; clicking one loads the task workspace into the main area without a full page reload.</li>
    </ul>
  `);

  const teams = section("teams", "Teams (Core Concept)", `
    <p>A <strong>team</strong> is the foundational organizational unit in Skipper. It defines <em>how</em> agents collaborate on a task: the roles they play, their hierarchy, and the phases of work they follow.</p>

    <p>Teams are created and edited on the <a href="/config">Config</a> page (<em>+ New Team</em> / <em>Edit</em>). A team embeds its own agents and phases inline — there is no separate global roster to wire up.</p>

    <h3 style="margin-top: var(--sk-space-4);">Team Structure</h3>
    <ul>
      <li><strong>Team Name</strong> — human-readable label (e.g. "Software Team").</li>
      <li><strong>Skipper Prompt</strong> — optional extra context for Skipper, the implicit team lead. It is prepended to Skipper's base instructions for every task this team runs.</li>
      <li><strong>Phases</strong> — an ordered list of execution stages (see Phases below). At least one is required.</li>
      <li><strong>Agents</strong> — the team's specialist members (see Agents below).</li>
    </ul>
    <p><strong>Skipper is the implicit, fixed entrypoint</strong> of every team — the level-0 lead spawned when a task starts. You do not add or pick it; it is always present and drives the work.</p>

    <h3 style="margin-top: var(--sk-space-4);">Agents (Team Members)</h3>
    <p>Each agent is authored <strong>inline on the team</strong> (not referenced from a shared pool). Per agent you set:</p>
    <ul>
      <li><strong>Name</strong> — used in delegation prompts (e.g. "Coder", "Tester", "Analyst").</li>
      <li><strong>Type</strong> — the underlying CLI agent type (claude-code, codex, opencode, grok).</li>
      <li><strong>Model</strong> — the model to run (or <code>default</code>).</li>
      <li><strong>Role</strong> — optional free-text label for what the agent does.</li>
      <li><strong>Instruction</strong> — system-level prompt injected when this agent is spawned.</li>
    </ul>
    <p>Do not add Skipper as an agent — it is the implicit lead. Every agent reports to Skipper by default, and Skipper delegates sub-tasks to them during a phase.</p>

    <h3 style="margin-top: var(--sk-space-4);">Phases</h3>
    <p>Phases are the sequential execution stages of a task. A typical software team might have: <em>Planning → Implementation → Testing → Cleanup</em>. Each phase defines:</p>
    <ul>
      <li><strong>name</strong> — identifier, also used to key per-task phase overrides.</li>
      <li><strong>prompt</strong> — instructions injected into Skipper when this phase starts. Skipper is respawned or resumed with the new prompt at each phase transition. Can be overridden for a single task at creation time (see Tasks &rarr; Configuration).</li>
      <li><strong>review gate</strong> — when enabled, the task pauses after this phase completes and waits for human approval before advancing to the next phase.</li>
    </ul>
    ${experimental ? `<p><strong>Consensus</strong> (parallel multi-agent execution for a phase) is configured as a <em>per-task phase override</em> on the New Task form, not on the team itself — see Delegation &amp; Consensus.</p>` : ""}

    <h3 style="margin-top: var(--sk-space-4);">Review Gates</h3>
    <p>When a phase has its review gate enabled, the task enters a <strong>needs_review</strong> state after the phase completes. The Dashboard shows a review banner. The operator approves (optionally with a note) or rejects from the UI, injecting their decision back into Skipper on resume.</p>

    <h3 style="margin-top: var(--sk-space-4);">How Teams Orchestrate Agents</h3>
    <p>Skipper (the implicit lead) coordinates by:</p>
    <ul>
      <li>Calling <code>delegate</code> or <code>delegate_batch</code> MCP tools to spawn its team's agents for sub-tasks.</li>
      <li>Calling <code>complete_phase</code> to advance to the next phase (after passing any review gate).</li>
      <li>Calling <code>escalate</code> to surface questions to the human operator.</li>
      <li>Calling <code>complete_task</code> when the final phase finishes.</li>
    </ul>
    <p>Manage and export all teams on the <a href="/config">Config</a> page.</p>
  `);

  const tasks = section("tasks", "Tasks", `
    <p>A <strong>task</strong> is the unit of work in Skipper. It ties together a team, a description, and lifecycle state.</p>

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
      <li>Team assignment.</li>
      <li>Per-phase overrides — set at task creation in a collapsible <em>Phase overrides</em> panel that appears once a team is selected (collapsed by default, since most tasks won't override). For each phase you can override the <strong>prompt</strong> — the full phase prompt becomes editable for this task only — and the <strong>review gate</strong>${experimental ? ", plus consensus settings" : ""}. Phases you leave untouched inherit the team defaults.</li>
      <li>Working directory — the filesystem path the entrypoint agent operates in.</li>
    </ul>

    <h3 style="margin-top: var(--sk-space-4);">Recurring Tasks</h3>
    <p>Recurring is a <strong>task type</strong> — choose it from the Task Type dropdown on the <a href="/tasks/new">New Task</a> form and the schedule fields appear inline (there is no separate recurring page). Set an interval (amount + unit: minutes, hours, days) to automatically create and approve a new task instance each interval, or leave the interval unset to run it only on demand with Run Now. Every fire is a <strong>fresh, independent task</strong> — no state carries over between runs. Manage recurring definitions from the Recurring group in the Dashboard sidebar.</p>

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
      <li>The task opens with an <strong>Escalations</strong> tab holding its open questions; a pending review gate shows as a banner between the task bar and the tabs. The sidebar marks any task needing input with a yellow dot.</li>
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

  const agents = section("agents", "Agent Types &amp; Agents", `
    <h3>Supported CLIs (Agent Types)</h3>
    <p>Skipper spawns these external agent CLIs: <strong>claude-code</strong>, <strong>codex</strong>, <strong>opencode</strong>, <strong>grok</strong>. Each agent type has fixed capabilities:</p>
    <ul>
      <li>Supported model families.</li>
      <li>Whether it supports stdin input (<code>supports_stdin</code>).</li>
      <li>Whether it supports resuming a prior session (<code>supports_resume</code>).</li>
      <li>JSON output mode (for structured signal parsing).</li>
    </ul>
    <p>Agent types are seeded by Skipper and are not edited from the UI.</p>

    <h3 style="margin-top: var(--sk-space-4);">Agents</h3>
    <p>Agents are the named members of a team, and they are <strong>authored inline when you edit a team</strong> — there is no separate global agent registry. Each agent picks an agent type, a model, and an optional role and system instruction. See <a href="#teams">Teams &rarr; Agents</a> for the full field list. Skipper itself is the implicit lead and is configured per-team via the team's Skipper Prompt.</p>
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

  const mcp = section("mcp", "MCP (Model Context Protocol)", `
    <p>MCP is the <strong>primary</strong> communication channel between agents and the Skipper orchestrator. Agents call strongly-typed tools on the daemon's MCP server instead of printing stdout markers.</p>

    <h3 style="margin-top: var(--sk-space-4);">Transport</h3>
    <p>Streamable HTTP at <code>/mcp</code>. Agents authenticate using a Bearer token equal to their runtime ID, set at spawn time.</p>

    <h3 style="margin-top: var(--sk-space-4);">Tool sets by role</h3>
    <ul>
      <li><strong>Root Skipper agent</strong> — full tool set: delegate, delegate_batch, complete_phase, regress_phase, complete_task, escalate, create_note, list_notes, create_artifact, get_artifact, list_artifacts, send_message${experimental ? ", and the global-store tools (set_global_value, get_global_value, query_global_store, delete_global_value)" : ""}.</li>
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
    <p>The <a href="/config">Config</a> page holds persistent Skipper settings, organised into these panels:</p>
    <ul>
      <li><strong>Teams</strong> — create, edit, delete, import, and export team definitions (skipper prompt, phases, and inline agent members). Export produces JSON you can paste or upload via Import; team config is also written back to <code>config/teams.json</code> so it survives a database reset.</li>
      <li><strong>Sound Notifications</strong> — per-event audio toggles (task started/completed/failed, escalation created, phase review pending).</li>
      <li><strong>Terminal Output Retention</strong> — set the retention window and purge old terminal output, agent sessions, and events to reclaim disk space.</li>
      ${experimental ? `<li><strong>Task Auto-Delete</strong> — auto-delete finished (completed/failed) tasks after a set number of days of inactivity, with separate windows for one-off tasks and recurring-task runs. The daemon sweeps hourly; 0 disables it. Active tasks are never deleted.</li>` : ""}
    </ul>
  `);

  const logs = section("logs", "Logs", `
    <h3>Log Viewer</h3>
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
      ${tasks}
      ${delegation}
      ${escalations}
      ${artifacts}
      ${agents}
      ${experimental ? realtime : ""}
      ${mcp}
      ${experimental ? conversations : ""}
      ${notifications}
      ${config}
      ${logs}
    </div>
  `;

  return v2layout("Help", content, "/help");
}
