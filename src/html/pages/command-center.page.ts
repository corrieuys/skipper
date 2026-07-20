import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import { formatTimestamp } from "../atoms/format-timestamp";
import { terminalJsonSummary, stripThinking } from "../terminalJsonSummary";
import { iteratePanel } from "../panels/iterate.panel";
import { isExperimental } from "../../config/feature-flags";
import { parseScheduleMatrix } from "../../tasks/scheduled-scheduler";
import { renderScheduleMatrixEditor, renderScheduleMatrixView, countMatrixHours } from "../atoms/schedule-matrix";
import type { CommandCenterViewModel, TaskSummary, ScheduledTaskSummary } from "../view-models/command-center.vm";
import type { AgentTreeNode } from "../fragments/tree-node.fragment";

interface ScheduledTaskOverride {
  scheduledTask: ScheduledTaskSummary & { working_directory?: string; description?: string | null };
  runs: Array<{ id: string; title: string; status: string; started_at: string | null; completed_at: string | null; result: string | null; created_at: string }>;
  teams: Array<{ id: string; name: string }>;
}

export function commandCenterPage(vm: CommandCenterViewModel, selectedTaskId?: string, scheduledOverride?: ScheduledTaskOverride): string {
  const experimental = isExperimental();
  const navHtml = navbar({
    currentPath: "/",
    daemonState: vm.daemonState,
    daemonUptime: vm.daemonUptime,
    escalationCount: vm.escalationCount,
    showChatToggle: experimental,
    skipperConnectEnabled: vm.skipperConnectEnabled,
  });

  // Determine what to show in main area
  const selected = scheduledOverride ? null
    : selectedTaskId
      ? vm.allTasks.find(t => t.id === selectedTaskId)
      : vm.allTasks.find(t => t.status === "running");

  const activeId = scheduledOverride ? scheduledOverride.scheduledTask.id : (selected?.id ?? null);

  return v2layout("Skipper", `
    ${navHtml}
    <div class="mc-workspace" id="mc-workspace">
      <div class="mc-sidebar__backdrop" data-sk-sidebar-close></div>
      ${renderSidebar(vm, activeId)}
      <div class="mc-main" id="mc-main">
        ${scheduledOverride
      ? renderScheduledTaskDetail(scheduledOverride.scheduledTask as any, scheduledOverride.teams, scheduledOverride.runs)
      : selected ? renderTaskView(vm, selected) : renderWelcome(vm)}
      </div>
      <div id="mc-main-refresh" style="display:none;"></div>
      ${experimental ? `
      <!-- Chat bottom panel -->
      <div class="mc-chat-panel" id="mc-chat-panel">
        <div class="mc-chat-panel__resize-handle" data-sk-chat-resize></div>
        <div class="mc-chat-panel__header">
          <button class="conv-sidebar-toggle" onclick="document.getElementById('mc-chat-panel').classList.toggle('mc-chat-panel--sidebar-collapsed')" title="Toggle conversation list">&#x2630;</button>
          <span class="mc-chat-panel__title">Chat</span>
          <button class="mc-chat-panel__close" data-sk-chat-toggle title="Close Chat">&times;</button>
        </div>
        <div class="mc-chat-panel__body" id="dashboard-chat-panel"
             hx-get="/fragments/dashboard/chat" hx-trigger="load" hx-swap="innerHTML">
          <span class="sk-muted" style="padding: var(--sk-space-4); display:block; text-align:center;">Loading chat...</span>
        </div>
      </div>
      ` : ""}
    </div>
  `, "/", selected ? ["dashboard", `task:${selected.id}`] : ["dashboard"]);
}

function renderSidebar(vm: CommandCenterViewModel, activeId: string | null): string {
  return `<aside class="mc-sidebar">
    <div class="mc-sidebar__header">
      <a href="/tasks/new" class="mc-sidebar__create">+ New Task</a>
      <button class="mc-sidebar__collapse-btn" data-sk-sidebar-toggle title="Pin sidebar open">&#x25C0;</button>
    </div>

    <div class="mc-sidebar__list" id="mc-sidebar-list">
      ${renderSidebarListBody(vm, activeId)}
    </div>

    <div class="mc-sidebar__footer">
      <label class="sk-checkbox">
        <input type="checkbox" name="enabled" ${vm.parallelExecution ? "checked" : ""}
          hx-post="/api/settings/parallel-tasks" hx-trigger="change" hx-swap="none">
        <span class="sk-checkbox__toggle"></span>
        <span class="sk-checkbox__label">Run tasks in parallel</span>
      </label>
    </div>
  </aside>`;
}

export function renderSidebarListBody(vm: CommandCenterViewModel, activeId: string | null): string {
  const running = vm.allTasks.filter(t => t.status === "running");
  const queued = vm.allTasks.filter(t => t.status === "approved");
  // Paused tasks live under Recent, sorted first so the 5-item cap can't push
  // them out — unlike completed/failed they still need operator action (Resume).
  const recent = vm.allTasks
    .filter(t => t.status === "completed" || t.status === "failed" || t.status === "paused")
    .sort((a, b) => (a.status === "paused" ? 0 : 1) - (b.status === "paused" ? 0 : 1))
    .slice(0, 5);
  const drafts = vm.allTasks.filter(t => t.status === "draft").slice(0, 5);

  return `
    ${running.length > 0 ? `
      <div class="mc-sidebar__group-label">Running</div>
      ${running.map(t => sidebarItem(t, activeId)).join("")}
    ` : ""}

    ${queued.length > 0 ? `
      <div class="mc-sidebar__group-label">Queue (${queued.length})</div>
      ${queued.map(t => sidebarItem(t, activeId)).join("")}
    ` : ""}

    ${recent.length > 0 ? `
      <div class="mc-sidebar__group-label">Recent</div>
      ${recent.map(t => sidebarItem(t, activeId)).join("")}
    ` : ""}

    ${drafts.length > 0 ? `
      <div class="mc-sidebar__group-label">Drafts</div>
      ${drafts.map(t => sidebarItem(t, activeId)).join("")}
    ` : ""}

    ${vm.scheduledTasks.length > 0 ? `
      <div class="mc-sidebar__group-label">Recurring</div>
      ${vm.scheduledTasks.map(st => sidebarScheduledItem(st, activeId)).join("")}
    ` : ""}

    ${isExperimental() && vm.recentConversations.length > 0 ? `
      <div id="mc-sidebar-chats">
        <div class="mc-sidebar__group-label">Chats</div>
        ${vm.recentConversations.map(c => sidebarChatItem(c)).join("")}
      </div>
    ` : `<div id="mc-sidebar-chats"></div>`}
  `;
}

function sidebarItem(t: TaskSummary, activeId: string | null): string {
  const isActive = t.id === activeId;
  const isRunning = t.status === "running";
  const isRT = t.task_type === "real_time";
  return `<a href="/?task=${escapeHtml(t.id)}"
      class="mc-sidebar__item${isActive ? " mc-sidebar__item--active" : ""}${isRunning ? " mc-sidebar__item--running" : ""}"
      hx-get="/workspace/task/${escapeHtml(t.id)}" hx-target="#mc-main" hx-swap="innerHTML" hx-push-url="/?task=${escapeHtml(t.id)}">
    <span class="mc-sidebar__item-dot mc-sidebar__item-dot--${t.status}"></span>
    <span class="mc-sidebar__item-title">${escapeHtml(t.title)}</span>
    ${t.has_attention ? '<span class="mc-sidebar__item-attention" title="Needs your input (escalation or review)"></span>' : ""}
    ${isRT ? '<span class="sk-badge sk-badge--waiting" style="font-size:8px;padding:1px 4px;">RT</span>' : ""}
    <span class="mc-sidebar__item-time">${t.completed_at ? formatTimestamp(t.completed_at) : formatTimestamp(t.created_at)}</span>
  </a>`;
}

function sidebarScheduledItem(st: ScheduledTaskSummary, activeId: string | null): string {
  const isActive = st.id === activeId;
  const badge = formatScheduleBadge(st.schedule_unit, st.schedule_amount);
  const statusDot = st.status === "approved" ? "mc-sidebar__item-dot--running" : "mc-sidebar__item-dot--draft";
  return `<a href="/?scheduled=${escapeHtml(st.id)}"
      class="mc-sidebar__item${isActive ? " mc-sidebar__item--active" : ""}"
      hx-get="/workspace/scheduled/${escapeHtml(st.id)}" hx-target="#mc-main" hx-swap="innerHTML" hx-push-url="/?scheduled=${escapeHtml(st.id)}">
    <span class="mc-sidebar__item-dot ${statusDot}"></span>
    <span class="mc-sidebar__item-title">${escapeHtml(st.title)}</span>
    <span class="sk-badge sk-badge--waiting" style="font-size:8px;padding:1px 4px;">${badge}</span>
    <span class="mc-sidebar__item-time">${formatTimestamp(st.created_at)}</span>
  </a>`;
}

function formatScheduleBadge(unit: string | null, amount: number | null, matrix: string | null = null): string {
  if (matrix) return "weekly";
  if (!unit || !amount) return "manual";
  if (unit === "minutes") return amount === 1 ? "1m" : `${amount}m`;
  if (unit === "hours") return amount === 1 ? "1h" : `${amount}h`;
  if (unit === "days") return amount === 1 ? "daily" : `${amount}d`;
  return `${amount}${unit[0]}`;
}

function sidebarChatItem(conv: { id: string; title: string; status: string; updated_at: string }): string {
  const dotClass = conv.status === "active" ? "mc-sidebar__item-dot--active" : "mc-sidebar__item-dot--archived";
  const eid = escapeHtml(conv.id);
  return `<a class="mc-sidebar__item"
      hx-get="/fragments/chat/${eid}" hx-target="#dashboard-chat-panel" hx-swap="innerHTML"
      onclick="if(!document.getElementById('mc-workspace').classList.contains('mc-workspace--chat-open')){Skipper.chat.toggle();}"
      style="cursor:pointer;">
    <span class="mc-sidebar__item-dot ${dotClass}"></span>
    <span class="mc-sidebar__item-title">${escapeHtml(conv.title)}</span>
    <span class="mc-sidebar__item-time">${formatTimestamp(conv.updated_at)}</span>
  </a>`;
}

// Architecture map shown as the dashboard backdrop when no task is selected.
// Hidden by default; the retro themes (win95, geocities) reveal + style it —
// see .mc-welcome__ascii in mission-control.ts and the per-theme overrides in
// themes.ts. Alignment assumes a monospace font, so the geocities override
// must keep beating its global Comic Sans rule.
const HOW_SKIPPER_WORKS_ASCII = `
             ~ ~ ~   H O W   S K I P P E R   W O R K S   ~ ~ ~

+-----------+                    +-------------------------------------+
|  BROWSER  | --- http/htmx ---> |              BUN SERVER             |
|    UI     | <---- ws push ---- |     routes . html . /ws . /mcp      |
+-----------+                    +------------------+------------------+
                                                    |
+-----------+                    +------------------v------------------+
| OPERATOR  | ----- approve ---> |            MANAGER DAEMON           |
|   (you)   |                    |    tick loop . health . recovery    |
+-----------+                    | draft > approved > running > done   |
   ^    ^                        +------------------+------------------+
   |    |                                           |
   |    |                        +------------------v------------------+
   |    |   phase reviews        |              PHASE LOOP             |
   |    +------------------------|  phase idx 0..n  complete | regress |
   |                             +------------------+------------------+
   |                                                | spawns
   |                             +------------------v------------------+
   |        escalations          |           ROOT AGENT (cli)          |
   +-----------------------------|  claude-code  codex  opencode  grok   |
                                 +----+-------------+------------+-----+
                                      |             |            |
                            mcp tools |      stdout |   delegate |
                                      v     markers v            v
                                 +----------------------+  +------------+
                                 |      EVENT BUS       |  | SUB-AGENTS |
                                 |     agent:signal     |<-| workers    |
                                 +---+--------------+---+  +------------+
                                     |              |
                   notes . artifacts |              | ws -> live ui
                                     v              v
                              +-----------+   +-----------+
                              |~/.skipper |   | dashboard |
                              | sqlite db |   |  updates  |
                              +-----------+   +-----------+

  * connect : outbound ws . remote control . public artifact links
  * whisper : local transcription for realtime voice tasks
  * greg    : resident heckler
`;

function renderWelcome(_vm: CommandCenterViewModel): string {
  return `<div class="mc-welcome"><pre class="mc-welcome__ascii" aria-hidden="true">${escapeHtml(HOW_SKIPPER_WORKS_ASCII)}</pre></div>`;
}

function renderTaskView(vm: CommandCenterViewModel, task: TaskSummary): string {
  // Draft tasks — show edit form
  if (task.status === "draft") {
    return renderDraftEdit(task, vm.teams);
  }
  // Check if this is a real-time task — render different UI
  const taskRow = vm.allTasks.find(t => t.id === task.id);
  if (taskRow && (taskRow as any).task_type === "real_time") {
    const isSessionActive = vm.realtimeSessionActive.get(task.id);
    return realtimeTaskContent(vm, task, isSessionActive);
  }
  return taskMainContent(vm, task);
}

export function renderDraftEdit(task: TaskSummary, _teams?: Array<{ id: string; name: string }>): string {
  void _teams; // team select is rendered via the shared slot endpoint
  const eid = escapeHtml(task.id);
  const slotQuery = new URLSearchParams({
    taskType: "standard",
    context: "full",
    selectedTeamId: task.team_id ?? "",
  }).toString();
  const phaseQuery = new URLSearchParams({
    teamId: task.team_id ?? "",
    taskId: task.id,
  }).toString();
  return `
    <div class="mc-task-header">
      <span class="mc-node__indicator mc-node__indicator--pending"></span>
      <span class="mc-task-header__title">${escapeHtml(task.title)}</span>
      <span class="sk-badge sk-badge--draft">draft</span>
      <div class="mc-task-header__actions">
        <button class="sk-btn sk-btn--primary sk-btn--sm" hx-post="/api/tasks/${eid}/approve" hx-swap="none">Approve</button>
        <button class="sk-btn sk-btn--danger sk-btn--sm" hx-delete="/api/tasks/${eid}" hx-swap="none" hx-confirm="Delete this draft?">Delete</button>
      </div>
    </div>
    <div style="padding: var(--sk-space-4) var(--sk-space-6); max-width: 700px;">
      <div class="sk-panel">
        <div class="sk-panel__header"><span class="sk-panel__title">Configuration</span></div>
        <div class="sk-panel__body" style="padding: var(--sk-space-4);">
          <form hx-post="/api/tasks/${eid}/update" hx-target="#mc-main" hx-swap="innerHTML">
            <div class="sk-form-group">
              <label class="sk-label">Title</label>
              <input type="text" name="title" class="sk-input" value="${escapeHtml(task.title)}" required>
            </div>
            <div class="sk-form-group">
              <label class="sk-label">Description</label>
              <textarea name="description" class="sk-textarea" rows="6">${task.description ? escapeHtml(task.description) : ""}</textarea>
            </div>
            <div class="sk-form-group">
              <label class="sk-label">Working Directory</label>
              <input type="text" name="workingDirectory" class="sk-input" value="${escapeHtml(task.working_directory || "")}" placeholder="/path/to/repo" required>
            </div>
            <div class="sk-form-row">
              <div id="task-form-team-slot" style="display:contents;"
                hx-get="/fragments/task-form/team?${slotQuery}"
                hx-trigger="load"
                hx-target="this"
                hx-swap="outerHTML"></div>
            </div>
            <div id="phase-config-slot"
              hx-get="/fragments/task-form/phase-config?${phaseQuery}"
              hx-trigger="load, change[target.name=='teamId'] from:document"
              hx-include="[name='teamId']"
              hx-target="this"
              hx-swap="innerHTML"></div>
            <div style="display:flex; gap:var(--sk-space-3); margin-top:var(--sk-space-4);">
              <button type="submit" class="sk-btn sk-btn--sm">Save Changes</button>
              <button type="submit" class="sk-btn sk-btn--primary sk-btn--sm" name="approve" value="1">Save &amp; Approve</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;
}

/** Real-time task view — shows timeline, session controls, and audio pipeline */
export function realtimeTaskContent(vm: CommandCenterViewModel, task: TaskSummary, isSessionActive?: boolean): string {
  const eid = escapeHtml(task.id);
  const isRunning = task.status === "running";
  const sessionActive = isRunning && isSessionActive !== false;
  const isPaused = isRunning && isSessionActive === false;

  // Reuse the shared task chrome: phase stepper inlined into the task bar, agent
  // orbs beside it, and the review/escalation prompts inside a User Input tab —
  // exactly like the standard task view.
  const mission = vm.missionsByTask.get(task.id) ?? (vm.mission?.taskId === task.id ? vm.mission : null);
  const needsReview = mission?.needsReview ?? false;
  const phaseStepper = mission && mission.phases.length > 0 ? renderPhaseStepper(mission.phases, task.id, isRunning) : "";

  const reload = `if(event.detail.successful){htmx.ajax('GET','/workspace/task/${eid}',{target:'#mc-main',swap:'innerHTML'});}`;
  const reloadStopAudio = `${reload}if(typeof stopRealtimeAudio==='function')stopRealtimeAudio();`;
  let headerButtons = "";
  if (sessionActive) {
    headerButtons = `
          <button class="sk-btn sk-btn--sm"
                  hx-post="/api/tasks/${eid}/realtime/session/stop" hx-swap="none"
                  hx-on::after-request="${reloadStopAudio}">Pause Session</button>
          <button class="sk-btn sk-btn--sm"
                  hx-post="/api/tasks/${eid}/complete" hx-swap="none"
                  hx-confirm="Complete this task? The session will be stopped."
                  hx-on::after-request="${reloadStopAudio}">Complete</button>
          <button class="sk-btn sk-btn--danger sk-btn--sm"
                  hx-post="/api/tasks/${eid}/cancel" hx-swap="none"
                  hx-confirm="Archive this real-time task? This will permanently stop the session."
                  hx-on::after-request="${reloadStopAudio}">Archive</button>`;
  } else if (isPaused) {
    headerButtons = `
          <button class="sk-btn sk-btn--primary sk-btn--sm"
                  hx-post="/api/tasks/${eid}/realtime/session/start" hx-swap="none"
                  hx-on::after-request="${reload}">Resume Session</button>
          <button class="sk-btn sk-btn--sm"
                  hx-post="/api/tasks/${eid}/complete" hx-swap="none"
                  hx-confirm="Mark this task as completed?"
                  hx-on::after-request="${reload}">Complete</button>
          <button class="sk-btn sk-btn--danger sk-btn--sm"
                  hx-post="/api/tasks/${eid}/cancel" hx-swap="none"
                  hx-confirm="Archive this real-time task? This will permanently stop the session."
                  hx-on::after-request="${reloadStopAudio}">Archive</button>`;
  } else if (task.status === "approved") {
    headerButtons = `
          <button class="sk-btn sk-btn--primary sk-btn--sm"
                  hx-post="/api/tasks/${eid}/realtime/session/start" hx-swap="none"
                  hx-on::after-request="${reload}">Start Session</button>
          <button class="sk-btn sk-btn--sm"
                  hx-post="/api/tasks/${eid}/cancel" hx-swap="none"
                  hx-confirm="Cancel this real-time task?"
                  hx-on::after-request="${reload}">Cancel</button>`;
  } else if (task.status === "completed") {
    headerButtons = `
          <button class="sk-btn sk-btn--sm"
                  hx-post="/api/realtime-tasks/${eid}/unarchive" hx-swap="none"
                  hx-on::after-request="${reload}">Reopen</button>`;
  } else if (task.status === "failed") {
    headerButtons = `
          <button class="sk-btn sk-btn--sm"
                  hx-post="/api/realtime-tasks/${eid}/unarchive" hx-swap="none"
                  hx-on::after-request="${reload}">Retry</button>`;
  }

  // Review gate / recovery banner sits between the task bar and the tab strip
  // (its historic home), not inside a tab. The Escalations tab holds only
  // agent escalations now.
  const reviewGate = task.status === "failed" && task.needs_review
    ? renderRecoveryPausedBanner(task)
    : needsReview ? renderReviewBanner(task) : "";
  const defaultTab = "outputs";
  const tabCls = (name: string) => name === defaultTab ? "mc-tab mc-tab--active" : "mc-tab";
  const panelCls = (name: string) => name === defaultTab ? "mc-tab-panel mc-tab-panel--active" : "mc-tab-panel";

  return `
    <!-- Task bar — phase stepper + agent orbs inlined (shared chrome) -->
    <div class="mc-task-header mc-task-header--with-phases${isRunning ? " mc-task-header--running" : ""}">
      <span class="mc-node__indicator mc-node__indicator--${isPaused ? "paused" : task.status}"></span>
      <span class="mc-task-header__title">${escapeHtml(task.title)}</span>
      <div class="mc-task-header__scroll">
        ${phaseStepper ? `<div class="mc-task-header__phases">${phaseStepper}</div>` : ""}
        ${isRunning ? `<div class="mc-task-header__orbs">
          <div id="mc-steer-${eid}"
            hx-get="/fragments/dashboard/latest-steer?task=${eid}"
            hx-trigger="load"
            hx-target="this"
            hx-swap="innerHTML"></div>
        </div>` : ""}
      </div>
      <div class="mc-task-header__actions">${headerButtons}</div>
    </div>

    <!-- Real-time composer (text + audio) — the primary input, kept directly
         under the task bar so it stays reachable on any tab. -->
    ${sessionActive ? `
    <div class="mc-rt-composer">
      <form hx-post="/api/realtime-tasks/${eid}/input" hx-swap="none"
            hx-on::after-request="if(event.detail.successful){this.querySelector('input[name=text]').value='';}" class="mc-rt-composer__form">
        <input type="text" name="text" placeholder="Type a message or cue..." required autocomplete="off" class="mc-rt-composer__input" />
        <button type="submit" class="sk-btn sk-btn--sm sk-btn--primary">Send</button>
      </form>
      <div id="rt-audio-controls" class="mc-rt-composer__audio">
        <button id="btn-start-recording" onclick="startRealtimeAudio('${eid}', 60, 5)" class="sk-btn sk-btn--sm" title="Start audio recording (auto-starts whisper)" style="display:inline-flex;align-items:center;gap:0.35rem;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
          Record
        </button>
        <button id="btn-stop-recording" onclick="stopRealtimeAudio()" class="sk-btn sk-btn--sm sk-btn--danger sk-animate-pulse" title="Stop recording and whisper" style="display:none;align-items:center;gap:0.35rem;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
          Stop
        </button>
        <span id="audio-status" class="sk-muted sk-text-xs"></span>
      </div>
      <div id="audio-visualizer-wrap" class="mc-rt-composer__viz" style="display:none;">
        <canvas id="audio-visualizer" width="600" height="80" style="width:100%;height:72px;display:block;"></canvas>
      </div>
    </div>
    <script src="/realtime-audio.js"></script>
    ` : ""}

    <!-- Review gate / recovery banner — between the task bar and the tabs -->
    ${reviewGate ? `<div class="mc-attention-slot">${reviewGate}</div>` : ""}

    <!-- Tabs flush against the composer / task bar -->
    <div class="mc-tabs">
      <button class="${tabCls("outputs")}" data-mc-tab="outputs" onclick="Skipper.tabs.show('outputs')">Outputs</button>
      <button class="${tabCls("details")}" data-mc-tab="details" onclick="Skipper.tabs.show('details')">Details</button>
      <button class="${tabCls("input")}" data-mc-tab="input" onclick="Skipper.tabs.show('input')">Escalations</button>
    </div>

    <!-- Outputs tab — Timeline+Activity | Notes | Artifacts side-by-side -->
    <div class="${panelCls("outputs")}" id="mc-tab-outputs">
      <div class="mc-outputs" id="mc-outputs">
        <!-- Unified feed column (timeline entries + agent activity merged) -->
        <div class="mc-outputs__col" data-outputs-col="activity">
          <div class="mc-outputs__col-header">Timeline</div>
          <div class="mc-activity__controls">
            <button class="mc-activity__filter mc-activity__filter--active" data-sk-activity-filter="all">All</button>
            <button class="mc-activity__filter" data-sk-activity-filter="timeline">Timeline</button>
            <button class="mc-activity__filter" data-sk-activity-filter="activity">Activity</button>
          </div>
          <div class="mc-outputs__col-body">
            <div class="mc-activity__feed" id="mc-rt-feed-${eid}" data-activity-filter="all"
                 hx-get="/workspace/task/${eid}/realtime-activity"
                 hx-trigger="load" hx-swap="innerHTML">
              <span class="sk-muted">Loading...</span>
            </div>
          </div>
        </div>
        <!-- Divider -->
        <div class="mc-outputs__divider" data-sk-outputs-resize="0"></div>
        <!-- Output column — Notes / Artifacts tabs -->
        <div class="mc-outputs__col" data-outputs-col="output">
          <div class="mc-outputs__col-header">Output</div>
          <div class="mc-activity__controls">
            <button class="mc-activity__filter mc-activity__filter--active" data-sk-output-tab="notes">Notes</button>
            <button class="mc-activity__filter" data-sk-output-tab="artifacts">Artifacts</button>
          </div>
          <div class="mc-outputs__col-body" style="padding:0;">
            <div id="mc-notes-${eid}" data-sk-output-panel="notes" style="padding:var(--sk-space-2);"
                 hx-get="/fragments/tasks/${eid}/notes"
                 hx-trigger="load" hx-swap="innerHTML">
              <span class="sk-muted">Loading notes...</span>
            </div>
            <div id="mc-artifacts-${eid}" data-sk-output-panel="artifacts" style="padding:var(--sk-space-2);display:none;"
                 hx-get="/fragments/tasks/${eid}/artifacts"
                 hx-trigger="load" hx-swap="innerHTML">
              <span class="sk-muted">Loading artifacts...</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Details tab -->
    <div class="${panelCls("details")}" id="mc-tab-details"
         hx-get="/workspace/task/${eid}/details" hx-trigger="revealed" hx-swap="innerHTML">
      <span class="sk-muted" style="padding: var(--sk-space-4);">Loading...</span>
    </div>

    <!-- Escalations tab — agent escalation prompts -->
    <div class="${panelCls("input")}" id="mc-tab-input">
      <div id="mc-task-escalations-${eid}"
           hx-get="/fragments/tasks/${eid}/escalations"
           hx-trigger="load"
           hx-swap="innerHTML"></div>
    </div>

    <!-- Activity detail modal -->
    <div id="activity-detail-modal" class="sk-modal" data-sk-modal-backdrop style="padding:1rem;">
      <div class="sk-modal__content" style="width:min(900px, 95vw); max-height:85vh; display:flex; flex-direction:column;">
        <div class="sk-modal__header" style="padding:0.5rem 1rem; gap:0.75rem;">
          <span id="activity-detail-modal-title" style="font-weight:600;">Activity</span>
          <span id="activity-detail-modal-meta" class="sk-muted sk-text-xs" style="flex:1;"></span>
          <button class="sk-btn sk-btn--sm" data-sk-modal-close="activity-detail-modal">Close</button>
        </div>
        <div class="sk-modal__body" style="flex:1; min-height:0; overflow:auto; padding:0.75rem 1rem;">
          <pre id="activity-detail-modal-body" style="margin:0; white-space:pre-wrap; word-break:break-word; font-family:var(--sk-font-mono); font-size:12px; line-height:1.45;"></pre>
        </div>
      </div>
    </div>

    <!-- Delegation prompt modal (Details tab prompt pills open here) -->
    <div id="sk-delegation-modal" class="sk-modal" data-sk-modal-backdrop style="padding:1rem;">
      <div class="sk-modal__content" style="width:min(900px, 95vw); max-height:85vh; display:flex; flex-direction:column;">
        <div class="sk-modal__header" style="padding:0.5rem 1rem; gap:0.75rem;">
          <span style="font-weight:600;">Delegation</span>
          <button class="sk-btn sk-btn--sm" data-sk-modal-close="sk-delegation-modal">Close</button>
        </div>
        <div class="sk-modal__body" id="sk-delegation-modal-body" style="flex:1; min-height:0; overflow:auto; padding:0.75rem 1rem;">
          <span class="sk-muted">Loading delegation...</span>
        </div>
      </div>
    </div>

    <!-- Artifact modal (used by v1 fragment onclick handlers) -->
    <div id="task-artifact-modal" class="sk-modal" data-sk-modal-backdrop style="padding:0.5rem;">
      <div class="sk-modal__content" style="width:99vw;height:99vh;max-width:none;max-height:none;display:flex;flex-direction:column;overflow:hidden;">
        <div class="sk-modal__header" style="padding:0.4rem 0.85rem;">
          <span>Artifact</span>
          <button class="sk-btn sk-btn--sm" data-sk-modal-close="task-artifact-modal">Close</button>
        </div>
        <div class="sk-modal__body" id="task-artifact-modal-body" style="flex:1;min-height:0;overflow:auto;padding:0.75rem 1rem;">
          <span class="sk-muted">Loading...</span>
        </div>
      </div>
    </div>
  `;
}

/** This is also served as a fragment at /workspace/task/:id for HTMX sidebar clicks */
export function taskMainContent(vm: CommandCenterViewModel, task: TaskSummary): string {
  // Use task-specific mission data, fall back to running mission
  const mission = vm.missionsByTask.get(task.id) ?? (vm.mission?.taskId === task.id ? vm.mission : null);
  const isRunning = task.status === "running";
  const needsReview = mission?.needsReview ?? false;

  // Phase stepper with labels — passes taskId + isRunning so it can poll itself
  const phaseStepper = mission && mission.phases.length > 0 ? renderPhaseStepper(mission.phases, task.id, isRunning) : "";

  // Status-appropriate actions
  const actions = renderActions(task, needsReview);

  // Result for completed/failed tasks. Only emit the wrapper when there's a
  // summary to show — otherwise the empty padded div leaves a dark band
  // between the phase stepper and the tab row.
  const resultHtml = (task.status === "completed" || task.status === "failed") && task.result_summary ? `
    <div style="padding: var(--sk-space-3) var(--sk-space-4); font-size: var(--sk-text-sm);">
      <div style="color: var(--sk-text-muted); margin-bottom: var(--sk-space-3);">${escapeHtml(task.result_summary)}</div>
    </div>
  ` : "";

  // Review gate / recovery banner sits between the task bar and the tab strip
  // (its historic home), not inside a tab.
  const reviewGate = task.status === "failed" && task.needs_review
    ? renderRecoveryPausedBanner(task)
    : needsReview ? renderReviewBanner(task) : "";
  // The iterate panel sits in the same banner slot as the review gate (between
  // the task bar and the tabs), not inside a tab.
  const iterate = task.status === "completed" ? iteratePanel(task.id) : "";
  // Default to the Escalations tab when it holds a result summary worth seeing;
  // else Outputs.
  const inputHasContent = !!resultHtml;
  const defaultTab = inputHasContent ? "input" : "outputs";
  const tabCls = (name: string) => name === defaultTab ? "mc-tab mc-tab--active" : "mc-tab";
  const panelCls = (name: string) => name === defaultTab ? "mc-tab-panel mc-tab-panel--active" : "mc-tab-panel";

  return `
    <!-- Task header (phase stepper + agent orbs inlined) -->
    <div class="mc-task-header mc-task-header--with-phases${isRunning ? " mc-task-header--running" : ""}">
      <span class="mc-node__indicator mc-node__indicator--${task.status === "waiting_delegation" ? "waiting" : task.status}"></span>
      <span class="mc-task-header__title">${escapeHtml(task.title)}</span>
      <div class="mc-task-header__scroll">
        ${phaseStepper ? `<div class="mc-task-header__phases">${phaseStepper}</div>` : ""}
        ${isRunning || task.status === "completed" ? `<div class="mc-task-header__orbs">
          <div id="mc-steer-${escapeHtml(task.id)}"
            hx-get="/fragments/dashboard/latest-steer?task=${escapeHtml(task.id)}"
            hx-trigger="load"
            hx-target="this"
            hx-swap="innerHTML"></div>
        </div>` : ""}
      </div>
      <div class="mc-task-header__actions">
        ${actions}
      </div>
    </div>

    <!-- Review gate / recovery banner + iterate panel — between the task bar
         and the tabs -->
    ${reviewGate || iterate ? `<div class="mc-attention-slot">${reviewGate}${iterate}</div>` : ""}

    <!-- Tabbed content — flush against the task bar. -->
    <div class="mc-tabs">
      <button class="${tabCls("outputs")}" data-mc-tab="outputs" onclick="Skipper.tabs.show('outputs')">Outputs</button>
      <button class="${tabCls("details")}" data-mc-tab="details" onclick="Skipper.tabs.show('details')">Details</button>
      <button class="${tabCls("input")}" data-mc-tab="input" onclick="Skipper.tabs.show('input')">Escalations</button>
    </div>

    <!-- Outputs tab — Activity | Notes | Artifacts side-by-side -->
    <div class="${panelCls("outputs")}" id="mc-tab-outputs">
      <div class="mc-outputs" id="mc-outputs">
        <!-- Activity column -->
        <div class="mc-outputs__col" data-outputs-col="activity">
          <div class="mc-outputs__col-header">Activity</div>
          <!-- Filters live OUTSIDE the scrollable body so they stay pinned
               while the feed scrolls. -->
          <div class="mc-activity__controls">
            <button class="mc-activity__filter" data-sk-activity-filter="all">All</button>
            <button class="mc-activity__filter mc-activity__filter--active" data-sk-activity-filter="messages">Messages</button>
            <button class="mc-activity__filter" data-sk-activity-filter="tools">Tools</button>
          </div>
          <div class="mc-outputs__col-body">
            <div class="mc-activity__feed" id="mc-activity-feed-${escapeHtml(task.id)}" data-activity-filter="messages"
                 hx-get="/workspace/task/${escapeHtml(task.id)}/activity"
                 hx-trigger="load" hx-swap="innerHTML">
              <span class="sk-muted">Loading activity...</span>
            </div>
          </div>
        </div>
        <!-- Divider 1 -->
        <div class="mc-outputs__divider" data-sk-outputs-resize="0"></div>
        <!-- Output column — Notes / Artifacts tabs -->
        <div class="mc-outputs__col" data-outputs-col="output">
          <div class="mc-outputs__col-header">Output</div>
          <!-- Tab strip OUTSIDE the scrollable body so Notes/Artifacts buttons
               stay pinned while the panel below scrolls. -->
          <div class="mc-activity__controls">
            <button class="mc-activity__filter mc-activity__filter--active" data-sk-output-tab="notes">Notes</button>
            <button class="mc-activity__filter" data-sk-output-tab="artifacts">Artifacts</button>
          </div>
          <div class="mc-outputs__col-body" style="padding:0;">
            <div id="mc-notes-${escapeHtml(task.id)}" data-sk-output-panel="notes" style="padding:var(--sk-space-2);"
                 hx-get="/fragments/tasks/${escapeHtml(task.id)}/notes"
                 hx-trigger="load" hx-swap="innerHTML">
              <span class="sk-muted">Loading notes...</span>
            </div>
            <div id="mc-artifacts-${escapeHtml(task.id)}" data-sk-output-panel="artifacts" style="padding:var(--sk-space-2);display:none;"
                 hx-get="/fragments/tasks/${escapeHtml(task.id)}/artifacts"
                 hx-trigger="load" hx-swap="innerHTML">
              <span class="sk-muted">Loading artifacts...</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Details tab -->
    <div class="${panelCls("details")}" id="mc-tab-details"
         hx-get="/workspace/task/${escapeHtml(task.id)}/details" hx-trigger="revealed" hx-swap="innerHTML">
      <span class="sk-muted" style="padding: var(--sk-space-4);">Loading...</span>
    </div>

    <!-- Escalations tab — agent escalation prompts + result summary -->
    <div class="${panelCls("input")}" id="mc-tab-input">
      <div id="mc-task-escalations-${escapeHtml(task.id)}"
           hx-get="/fragments/tasks/${escapeHtml(task.id)}/escalations"
           hx-trigger="load"
           hx-swap="innerHTML"></div>
      ${resultHtml}
      ${!resultHtml
        ? `<div class="sk-panel"><div class="sk-panel__body mc-userinput__empty sk-muted" style="padding: var(--sk-space-4); text-align:center;">Nothing needs your input right now.</div></div>`
        : ""}
    </div>

    <!-- Activity detail modal -->
    <div id="activity-detail-modal" class="sk-modal" data-sk-modal-backdrop style="padding:1rem;">
      <div class="sk-modal__content" style="width:min(900px, 95vw); max-height:85vh; display:flex; flex-direction:column;">
        <div class="sk-modal__header" style="padding:0.5rem 1rem; gap:0.75rem;">
          <span id="activity-detail-modal-title" style="font-weight:600;">Activity</span>
          <span id="activity-detail-modal-meta" class="sk-muted sk-text-xs" style="flex:1;"></span>
          <button class="sk-btn sk-btn--sm" data-sk-modal-close="activity-detail-modal">Close</button>
        </div>
        <div class="sk-modal__body" style="flex:1; min-height:0; overflow:auto; padding:0.75rem 1rem;">
          <pre id="activity-detail-modal-body" style="margin:0; white-space:pre-wrap; word-break:break-word; font-family:var(--sk-font-mono); font-size:12px; line-height:1.45;"></pre>
        </div>
      </div>
    </div>

    <!-- Delegation prompt modal -->
    <div id="sk-delegation-modal" class="sk-modal" data-sk-modal-backdrop style="padding:1rem;">
      <div class="sk-modal__content" style="width:min(900px, 95vw); max-height:85vh; display:flex; flex-direction:column;">
        <div class="sk-modal__header" style="padding:0.5rem 1rem; gap:0.75rem;">
          <span style="font-weight:600;">Delegation</span>
          <button class="sk-btn sk-btn--sm" data-sk-modal-close="sk-delegation-modal">Close</button>
        </div>
        <div class="sk-modal__body" id="sk-delegation-modal-body" style="flex:1; min-height:0; overflow:auto; padding:0.75rem 1rem;">
          <span class="sk-muted">Loading delegation...</span>
        </div>
      </div>
    </div>

    <!-- Artifact modal -->
    <div id="task-artifact-modal" class="sk-modal" data-sk-modal-backdrop style="padding:0.5rem;">
      <div class="sk-modal__content" style="width:99vw;height:99vh;max-width:none;max-height:none;display:flex;flex-direction:column;overflow:hidden;">
        <div class="sk-modal__header" style="padding:0.4rem 0.85rem;">
          <span>Artifact</span>
          <button class="sk-btn sk-btn--sm" data-sk-modal-close="task-artifact-modal">Close</button>
        </div>
        <div class="sk-modal__body" id="task-artifact-modal-body" style="flex:1;min-height:0;overflow:auto;padding:0.75rem 1rem;">
          <span class="sk-muted">Loading...</span>
        </div>
      </div>
    </div>
  `;
}

function renderActions(task: TaskSummary, needsReview?: boolean): string {
  const btns: string[] = [];
  if (task.status === "draft") {
    btns.push(`<button class="sk-btn sk-btn--primary sk-btn--sm" hx-post="/api/tasks/${escapeHtml(task.id)}/approve" hx-swap="none">Approve</button>`);
  } else if (task.status === "approved") {
    btns.push(`<button class="sk-btn sk-btn--sm" hx-post="/api/tasks/${escapeHtml(task.id)}/unapprove" hx-swap="none">Unapprove</button>`);
  } else if (task.status === "running") {
    if (needsReview) {
      btns.push(`<button class="sk-btn sk-btn--primary sk-btn--sm" hx-post="/api/tasks/${escapeHtml(task.id)}/approve-phase" hx-swap="none">Approve Phase</button>`);
    }
    btns.push(`<button class="sk-btn sk-btn--sm" hx-post="/api/tasks/${escapeHtml(task.id)}/pause" hx-swap="none" hx-confirm="Pause this task? All its agents and their subprocesses will be stopped; you can resume later.">Pause</button>`);
    btns.push(`<button class="sk-btn sk-btn--sm" hx-post="/api/tasks/${escapeHtml(task.id)}/complete" hx-swap="none" hx-confirm="Mark this task as complete and kill all active agents?">Complete</button>`);
    btns.push(`<button class="sk-btn sk-btn--danger sk-btn--sm" hx-post="/api/tasks/${escapeHtml(task.id)}/cancel" hx-swap="none" hx-confirm="Cancel?">Cancel</button>`);
  } else if (task.status === "paused") {
    btns.push(`<button class="sk-btn sk-btn--primary sk-btn--sm" hx-post="/api/tasks/${escapeHtml(task.id)}/resume-from-pause" hx-swap="none" title="Respawn agents and continue from where the task was paused.">Resume</button>`);
    btns.push(`<button class="sk-btn sk-btn--danger sk-btn--sm" hx-post="/api/tasks/${escapeHtml(task.id)}/cancel" hx-swap="none" hx-confirm="Cancel?">Cancel</button>`);
  } else if (task.status === "failed") {
    btns.push(`<button class="sk-btn sk-btn--primary sk-btn--sm" hx-post="/api/tasks/${escapeHtml(task.id)}/resume" hx-swap="none" title="Resume at the current phase. Skipper inspects notes/artifacts/delegations and continues from where the task left off.">Resume</button>`);
    btns.push(`<button class="sk-btn sk-btn--sm" hx-post="/api/tasks/${escapeHtml(task.id)}/retry" hx-swap="none" title="Reset to phase 0 and start over.">Retry</button>`);
  }
  return btns.join("");
}

// Warning-tinted status pill matching the escalation card's badge slot.
const warnBadge = (label: string) =>
  `<span class="sk-badge" style="background: color-mix(in srgb, var(--sk-accent-warning) 22%, transparent); color: var(--sk-accent-warning);">${label}</span>`;

function renderRecoveryPausedBanner(task: TaskSummary): string {
  const eid = escapeHtml(task.id);
  return `<div class="sk-panel sk-mb-4" data-mc-pending="recovery">
    <div class="sk-panel__header">
      <div class="sk-flex sk-items-center sk-gap-2">
        <span class="esc-alert-bang" style="color: var(--sk-accent-warning); font-weight: 700;">&#x23F8;</span>
        <strong style="color: var(--sk-text);">Recovery paused</strong>
        <span class="sk-text-xs sk-muted">skipper</span>
        ${warnBadge("paused")}
      </div>
    </div>
    <div class="sk-panel__body">
      <div class="sk-mb-4" style="color: var(--sk-text-muted); font-size: var(--sk-text-sm);">
        Skipper died twice without progress. Notes and artifacts are intact. Resume to continue.
      </div>
      <div class="sk-flex sk-gap-2">
        <button class="sk-btn sk-btn--primary sk-btn--sm" hx-post="/api/tasks/${eid}/resume" hx-swap="none">Resume</button>
      </div>
    </div>
  </div>`;
}

function renderReviewBanner(task: TaskSummary): string {
  const eid = escapeHtml(task.id);
  return `<div class="sk-panel sk-mb-4" data-mc-pending="review">
    <div class="sk-panel__header">
      <div class="sk-flex sk-items-center sk-gap-2">
        <span class="esc-alert-bang" style="color: var(--sk-accent-warning); font-weight: 700;">&#x270E;</span>
        <strong style="color: var(--sk-text);">Phase review required</strong>
        ${warnBadge("review")}
      </div>
    </div>
    <div class="sk-panel__body">
      <div class="sk-mb-2" style="color: var(--sk-text-muted); font-size: var(--sk-text-sm);">
        Approve to advance to the next phase, or reject with guidance for a redo.
      </div>
      <div class="sk-flex sk-gap-2">
        <button class="sk-btn sk-btn--primary sk-btn--sm" onclick="const r=this.closest('.sk-panel'); r.querySelector('.mc-reject-form').style.display='none'; r.querySelector('.mc-approve-form').style.display='flex';">Approve</button>
        <button class="sk-btn sk-btn--sm" onclick="const r=this.closest('.sk-panel'); r.querySelector('.mc-approve-form').style.display='none'; r.querySelector('.mc-reject-form').style.display='flex';">Reject</button>
      </div>
      <form class="mc-approve-form" style="display:none; width:100%; margin-top:var(--sk-space-2); gap:var(--sk-space-2); align-items:center;"
            hx-post="/api/tasks/${eid}/approve-phase" hx-swap="none"
            hx-on::after-request="if(event.detail.successful){this.style.display='none';this.querySelector('textarea').value='';}">
        <textarea name="message" class="sk-input" rows="2" placeholder="Optional note for the next phase (guidance, scope tweaks, things to watch out for)..." style="flex:1; font-size:var(--sk-text-sm); resize:none;"></textarea>
        <button type="submit" class="sk-btn sk-btn--primary sk-btn--sm" style="flex-shrink:0;">Approve &amp; Advance</button>
      </form>
      <form class="mc-reject-form" style="display:none; width:100%; margin-top:var(--sk-space-2); gap:var(--sk-space-2); align-items:center;"
            hx-post="/api/tasks/${eid}/reject-phase" hx-swap="none"
            hx-on::after-request="if(event.detail.successful){this.style.display='none';}">
        <textarea name="message" class="sk-input" rows="2" placeholder="Why are you rejecting? What should change?" style="flex:1; font-size:var(--sk-text-sm); resize:none;" required></textarea>
        <button type="submit" class="sk-btn sk-btn--danger sk-btn--sm" style="flex-shrink:0;">Send Rejection</button>
      </form>
    </div>
  </div>`;
}

function renderPhaseStepper(phases: Array<{ name: string; status: string }>, taskId?: string, isRunning?: boolean): string {
  if (phases.length === 0) return "";
  const pollAttrs = taskId && isRunning
    ? ` hx-get="/workspace/task/${escapeHtml(taskId)}/phase-strip" hx-trigger="every 5s" hx-swap="outerHTML"`
    : "";
  const idAttr = taskId ? ` id="mc-phase-stepper-${escapeHtml(taskId)}"` : "";
  return `<div${idAttr} class="mc-phase-stepper"${pollAttrs}>
    ${phases.map((p, i) => {
    // Space-optimised task bar: only the active phase (current, or paused for
    // review) shows its name; every other phase collapses to just its number.
    const isActive = p.status === "current" || p.status === "review";
    return `<div class="mc-phase-step mc-phase-step--${p.status}">
        <span class="mc-phase-step__dot">${i + 1}</span>
        ${isActive ? `<span class="mc-phase-step__name">${escapeHtml(p.name)}</span>` : ""}
      </div>${i < phases.length - 1 ? '<div class="mc-phase-step__connector"></div>' : ""}`;
  }).join("")}
  </div>`;
}

export function renderPhaseStripFragment(phases: Array<{ name: string; status: string }>, taskId: string, isRunning: boolean): string {
  return renderPhaseStepper(phases, taskId, isRunning);
}

export function renderAgentList(agents: AgentTreeNode[]): string {
  if (agents.length === 0) return "";
  return `<div class="mc-agents">
    ${agents.map(a => {
    const s = a.status === "waiting_delegation" ? "waiting" : a.status;
    return `<div class="mc-agent-row mc-agent-row--${s}">
        <span class="mc-node__indicator mc-node__indicator--${s}"></span>
        <span class="mc-agent-row__name">${escapeHtml(a.agentName)}</span>
        <span class="mc-agent-row__status">${s}</span>
        ${a.pid ? `<span class="mc-agent-row__pid">PID ${a.pid}</span>` : ""}
        ${a.depth > 0 ? `<span class="mc-agent-row__depth">L${a.depth}</span>` : ""}
      </div>`;
  }).join("")}
  </div>`;
}

/**
 * Parse terminal output and return human-readable activity entries.
 *
 * The client filters kinds via CSS (msg / tool), so if the row window were a
 * single shared cap, a burst of tool rows would starve the message filter:
 * 18 tools + 2 messages in the window means the Messages tab shows just 2. To
 * stop one kind from crowding out another, each kind gets its OWN budget.
 * `lines` arrive newest-first, so keeping the first `perKindLimit` of each kind
 * keeps the newest of each — and the Messages tab fills to `perKindLimit` even
 * when tool rows dominate the raw stream (caller must pull a wide enough window).
 */
export function parseTerminalActivity(
  lines: Array<{ stream: string; data: string; agent_name?: string; process_pid?: number | null; created_at?: string }>,
  perKindLimit = 40,
): string {
  if (lines.length === 0) return `<div class="mc-activity__empty">No activity yet</div>`;

  const kindCounts: Record<string, number> = { message: 0, tool: 0, event: 0 };
  const items = lines.map(line => {
    const data = line.data.trim();
    let kind: "message" | "tool" | "event" = "event";
    let summary = "";

    // Try JSON parse (data may contain newline-delimited JSON objects)
    if (data.startsWith("{")) {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        // Multi-object line: parse the first JSON object only
        const firstLine = data.split("\n").find(l => l.trim().startsWith("{"));
        if (firstLine) {
          try { parsed = JSON.parse(firstLine.trim()); } catch { /* give up */ }
        }
      }

      if (parsed) {
        summary = terminalJsonSummary(parsed);

        // Classify
        const type = typeof parsed.type === "string" ? parsed.type : "";
        const item = parsed.item && typeof parsed.item === "object" ? parsed.item as Record<string, unknown> : null;
        const itemType = item && typeof item.type === "string" ? item.type : "";
        const message = parsed.message && typeof parsed.message === "object" ? parsed.message as Record<string, unknown> : null;
        const content = message?.content;

        if (itemType === "command_execution" || itemType === "tool_call" || itemType === "tool_result" || itemType === "tool_use" || type.includes("tool")) {
          kind = "tool";
        } else if (Array.isArray(content)) {
          const hasToolBlock = content.some((b: any) => b?.type === "tool_use" || b?.type === "tool_result");
          kind = hasToolBlock ? "tool" : "message";
        } else if (type === "assistant" || type === "user" || type === "message" || typeof parsed.result === "string") {
          kind = "message";
        }
      } else {
        summary = data.length > 200 ? data.slice(0, 200) + "..." : data;
        kind = line.stream === "stderr" ? "event" : "message";
      }
    } else {
      summary = data.length > 200 ? data.slice(0, 200) + "..." : data;
      kind = line.stream === "stderr" ? "event" : "message";
    }

    if (kind === "message") summary = stripThinking(summary);
    if (!summary) return "";

    // Per-kind budget: once a kind is full, drop further (older) rows of that
    // kind. Newest-first input means we keep the newest `perKindLimit` of each.
    if (kindCounts[kind] >= perKindLimit) return "";
    kindCounts[kind]++;

    const kindLabel = kind === "tool" ? "tool" : kind === "message" ? "msg" : "sys";
    const agentLabel = line.agent_name ? `<span class="mc-activity__agent">${escapeHtml(line.agent_name)}</span>` : "";
    const pidLabel = line.process_pid != null
      ? `<span class="mc-activity__pid" title="Process ID">PID ${line.process_pid}</span>`
      : "";

    return `<div class="mc-activity__item mc-activity__item--${kind}" data-activity-kind="${kind}"
        data-sk-activity-row
        data-sk-activity-data="${escapeHtml(line.data)}"
        data-sk-activity-agent="${escapeHtml(line.agent_name ?? "")}"
        data-sk-activity-pid="${line.process_pid ?? ""}"
        data-sk-activity-time="${escapeHtml(line.created_at ?? "")}"
        data-sk-activity-kind="${kind}">
      <span class="mc-activity__kind mc-activity__kind--${kind}">${kindLabel}</span>
      ${agentLabel}
      ${pidLabel}
      <span class="mc-activity__text">${escapeHtml(summary)}</span>
    </div>`;
  }).filter(Boolean).join("");

  return items.length > 0 ? items : `<div class="mc-activity__empty">No activity yet</div>`;
}

export interface RealtimeActivityRow {
  source: "timeline" | "terminal";
  // timeline fields
  entry_type?: string;
  content?: string;
  priority?: string;
  // terminal fields
  stream?: string;
  data?: string;
  agent_name?: string;
  process_pid?: number | null;
  // shared
  created_at: string;
}

export function parseRealtimeActivity(rows: RealtimeActivityRow[]): string {
  if (rows.length === 0) return `<div class="mc-activity__empty">No activity yet</div>`;

  return rows.map(row => {
    if (row.source === "timeline") {
      const entryType = row.entry_type ?? "text";
      const content = row.content ?? "";
      const kind = entryType === "error" ? "event" : entryType === "summary" ? "tool" : "message";
      const kindLabel = entryType === "summary" ? "sum" : entryType === "error" ? "err" : "txt";
      const preview = content.length > 200 ? content.slice(0, 200) + "…" : content;
      const priorityTag = row.priority === "high"
        ? ` <span class="mc-activity__kind" style="color:var(--sk-accent-warning);background:rgba(255,208,128,0.12);font-size:8px;">HIGH</span>`
        : "";
      const timeLabel = row.created_at ? `<span class="mc-activity__pid">${formatTimestamp(row.created_at)}</span>` : "";

      return `<div class="mc-activity__item mc-activity__item--${kind} mc-activity__item--timeline" data-activity-kind="timeline"
          data-sk-activity-row
          data-sk-activity-data="${escapeHtml(content)}"
          data-sk-activity-time="${escapeHtml(row.created_at ?? "")}"
          data-sk-activity-kind="timeline">
        <span class="mc-activity__kind mc-activity__kind--${kind}">${kindLabel}</span>${priorityTag}
        ${timeLabel}
        <span class="mc-activity__text">${escapeHtml(preview)}</span>
      </div>`;
    }

    // terminal output row — reuse existing parsing logic
    const data = (row.data ?? "").trim();
    let kind: "message" | "tool" | "event" = "event";
    let summary = "";

    if (data.startsWith("{")) {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        const firstLine = data.split("\n").find(l => l.trim().startsWith("{"));
        if (firstLine) {
          try { parsed = JSON.parse(firstLine.trim()); } catch { /* give up */ }
        }
      }

      if (parsed) {
        summary = terminalJsonSummary(parsed);
        const type = typeof parsed.type === "string" ? parsed.type : "";
        const item = parsed.item && typeof parsed.item === "object" ? parsed.item as Record<string, unknown> : null;
        const itemType = item && typeof item.type === "string" ? item.type : "";
        const message = parsed.message && typeof parsed.message === "object" ? parsed.message as Record<string, unknown> : null;
        const content = message?.content;

        if (itemType === "command_execution" || itemType === "tool_call" || itemType === "tool_result" || itemType === "tool_use" || type.includes("tool")) {
          kind = "tool";
        } else if (Array.isArray(content)) {
          const hasToolBlock = content.some((b: any) => b?.type === "tool_use" || b?.type === "tool_result");
          kind = hasToolBlock ? "tool" : "message";
        } else if (type === "assistant" || type === "user" || type === "message" || typeof parsed.result === "string") {
          kind = "message";
        }
      } else {
        summary = data.length > 200 ? data.slice(0, 200) + "..." : data;
        kind = row.stream === "stderr" ? "event" : "message";
      }
    } else {
      summary = data.length > 200 ? data.slice(0, 200) + "..." : data;
      kind = row.stream === "stderr" ? "event" : "message";
    }

    if (kind === "message") summary = stripThinking(summary);
    if (!summary) return "";

    const kindLabel = kind === "tool" ? "tool" : kind === "message" ? "msg" : "sys";
    const agentLabel = row.agent_name ? `<span class="mc-activity__agent">${escapeHtml(row.agent_name)}</span>` : "";
    const pidLabel = row.process_pid != null
      ? `<span class="mc-activity__pid" title="Process ID">PID ${row.process_pid}</span>`
      : "";

    return `<div class="mc-activity__item mc-activity__item--${kind} mc-activity__item--activity" data-activity-kind="activity"
        data-sk-activity-row
        data-sk-activity-data="${escapeHtml(row.data ?? "")}"
        data-sk-activity-agent="${escapeHtml(row.agent_name ?? "")}"
        data-sk-activity-pid="${row.process_pid ?? ""}"
        data-sk-activity-time="${escapeHtml(row.created_at ?? "")}"
        data-sk-activity-kind="activity">
      <span class="mc-activity__kind mc-activity__kind--${kind}">${kindLabel}</span>
      ${agentLabel}
      ${pidLabel}
      <span class="mc-activity__text">${escapeHtml(summary)}</span>
    </div>`;
  }).filter(Boolean).join("");
}

export function renderScheduledTaskDetail(
  st: ScheduledTaskSummary,
  teams: Array<{ id: string; name: string }>,
  runs: Array<{ id: string; title: string; status: string; started_at: string | null; completed_at: string | null; result: string | null; created_at: string }>,
): string {
  const eid = escapeHtml(st.id);
  const matrix = parseScheduleMatrix(st.schedule_matrix ?? null);
  const badge = formatScheduleBadge(st.schedule_unit, st.schedule_amount, st.schedule_matrix ?? null);
  const hasInterval = !!(st.schedule_unit && st.schedule_amount);

  if (st.status === "draft") {
    return renderScheduledDraftEdit(st, teams, runs);
  }

  return `
    <div class="mc-task-header">
      <span class="mc-node__indicator mc-node__indicator--running"></span>
      <span class="mc-task-header__title">${escapeHtml(st.title)}</span>
      <span class="sk-badge sk-badge--running">approved</span>
      <span class="sk-badge sk-badge--waiting" style="font-size:9px;padding:1px 5px;">${badge}</span>
      ${st.team_name ? `<span class="sk-muted sk-text-xs">${escapeHtml(st.team_name)}</span>` : ""}
      <div class="mc-task-header__actions">
        ${hasInterval || matrix ? `<button class="sk-btn sk-btn--sm" hx-post="/api/scheduled-tasks/${eid}/clear-schedule" hx-swap="none"
                hx-confirm="Clear the schedule? This task will become manual-only (Run Now).">Clear schedule</button>` : ""}
        <button class="sk-btn sk-btn--sm" hx-post="/api/scheduled-tasks/${eid}/unapprove" hx-swap="none">Unapprove</button>
        <button class="sk-btn sk-btn--danger sk-btn--sm" hx-delete="/api/scheduled-tasks/${eid}" hx-swap="none"
                hx-confirm="Delete this recurring task?">Delete</button>
      </div>
    </div>

    <div style="padding: var(--sk-space-4) var(--sk-space-6);">
      <form hx-post="/api/scheduled-tasks/${eid}/run-now" hx-swap="none"
            style="display:flex;gap:var(--sk-space-2);align-items:center;margin-bottom:var(--sk-space-6);">
        <textarea name="input" class="sk-input" rows="2" placeholder="Optional: extra instructions injected into this run's prompt (leave blank for a plain run)..."
                  style="flex:1; font-size:var(--sk-text-sm); resize:none;"></textarea>
        <button type="submit" class="sk-btn sk-btn--primary sk-btn--sm" style="flex-shrink:0;">Run Now</button>
      </form>

      <div class="sk-panel" style="margin-bottom:var(--sk-space-3);">
        <div class="sk-panel__header"><span class="sk-panel__title">Overview</span></div>
        <div class="sk-panel__body" style="padding:var(--sk-space-4);">
          <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:var(--sk-space-4);">
            <div>
              <div class="sk-muted sk-text-xs">Schedule</div>
              <div style="font-weight:600;">${hasInterval ? `Every ${st.schedule_amount} ${st.schedule_unit}` : matrix ? `Weekly schedule (${countMatrixHours(matrix)} hours/week)` : "Manual only"}</div>
            </div>
            <div>
              <div class="sk-muted sk-text-xs">Next Run</div>
              <div>${st.next_run_at ? formatTimestamp(st.next_run_at) : "<span class='sk-muted'>—</span>"}</div>
            </div>
            <div>
              <div class="sk-muted sk-text-xs">Last Run</div>
              <div>${st.last_run_at ? formatTimestamp(st.last_run_at) : "<span class='sk-muted'>—</span>"}</div>
            </div>
          </div>

          ${matrix ? `<div style="margin-top:var(--sk-space-4);">${renderScheduleMatrixView(matrix)}</div>` : ""}

          ${st.description ? `<div style="margin-top:var(--sk-space-4);"><div class="sk-muted sk-text-xs" style="margin-bottom:var(--sk-space-1);">Description</div><div style="white-space:pre-wrap;max-height:10lh;overflow-y:auto;">${escapeHtml(st.description)}</div></div>` : ""}

          ${st.global_store_instructions ? `<div style="margin-top:var(--sk-space-4);"><div class="sk-muted sk-text-xs" style="margin-bottom:var(--sk-space-1);">Global Store Instructions</div><div style="white-space:pre-wrap;max-height:10lh;overflow-y:auto;">${escapeHtml(st.global_store_instructions)}</div></div>` : ""}
        </div>
      </div>

      ${renderWebhookPanel(st)}

      ${isExperimental() ? `
      <div class="sk-panel" style="margin-top:var(--sk-space-3);">
        <div class="sk-panel__header"><span class="sk-panel__title">Slack Slash Command</span></div>
        <div class="sk-panel__body" style="padding:var(--sk-space-4);">
          <form hx-post="/api/scheduled-tasks/${eid}/slash-command" hx-swap="none"
                style="display:flex;gap:var(--sk-space-2);align-items:center;"
                hx-on::after-request="if(event.detail.successful){var b=this.querySelector('[data-save]');if(b){b.textContent='Saved';setTimeout(function(){b.textContent='Save';},1200);}}">
            <input type="text" name="slashCommand" class="sk-input" style="flex:1;" placeholder="/nightly-report"
                   value="${escapeHtml(typeof st.task_config?.slashCommand === "string" ? st.task_config.slashCommand : "")}">
            <button type="submit" data-save class="sk-btn sk-btn--primary sk-btn--sm" style="flex-shrink:0;">Save</button>
          </form>
          <p class="sk-muted sk-text-xs" style="margin:var(--sk-space-2) 0 0;">
            Run this recurring task now from Slack (arg text = run input). Leave blank to unbind. Requires Socket Mode under <a href="/config">Config</a>.
          </p>
        </div>
      </div>
      ` : ""}

      <div class="sk-panel" style="margin-top:var(--sk-space-3);">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Runs</span>
          <span class="sk-muted sk-text-xs">${runs.length} recent</span>
        </div>
        <div class="sk-panel__body" id="scheduled-runs-list"
             hx-get="/workspace/scheduled/${eid}/runs" hx-trigger="load, every 5s" hx-swap="innerHTML">
          ${renderScheduledRuns(runs)}
        </div>
      </div>
    </div>
  `;
}

/**
 * Webhook trigger panel on the approved scheduled-task detail. The URL embeds
 * the per-task secret and is relayed by the connect integrator; an empty POST
 * fires "Run Now"; a request body is injected into the run's prompt.
 */
function renderWebhookPanel(st: ScheduledTaskSummary): string {
  const eid = escapeHtml(st.id);
  const enabled = !!st.webhook_key;
  const url = st.webhook_url ?? null;

  let body: string;
  if (!enabled) {
    body = `
      <div class="sk-muted sk-text-sm" style="margin-bottom:var(--sk-space-2);">
        Trigger this task from external services with a static URL. The secret is embedded in the URL, so anyone holding it can fire this task.
      </div>
      <button class="sk-btn sk-btn--sm" hx-post="/api/scheduled-tasks/${eid}/webhook/enable" hx-swap="none">Enable webhook trigger</button>`;
  } else {
    body = `
      ${url
        ? `<div style="display:flex;gap:var(--sk-space-2);align-items:center;margin-bottom:var(--sk-space-2);">
            <input class="sk-input" readonly value="${escapeHtml(url)}" id="webhook-url-${eid}"
                   style="flex:1;font-size:var(--sk-text-xs);font-family:var(--sk-font-mono);" onclick="this.select()"/>
            <button class="sk-btn sk-btn--sm" style="flex-shrink:0;"
                    onclick="navigator.clipboard.writeText(document.getElementById('webhook-url-${eid}').value).then(()=>{this.textContent='Copied';setTimeout(()=>this.textContent='Copy',1500)})">Copy</button>
          </div>
          <div class="sk-muted sk-text-xs" style="margin-bottom:var(--sk-space-2);">POST to this URL fires a run. A JSON or text body is injected into the run's prompt as the webhook payload.</div>`
        : `<div class="sk-muted sk-text-sm" style="margin-bottom:var(--sk-space-2);">Webhook trigger is enabled, but Skipper Connect is not configured. Set the Connect URL and key on the Config page to get a public URL.</div>`}
      <form hx-post="/api/scheduled-tasks/${eid}/webhook/debounce" hx-swap="none"
            style="display:flex;gap:var(--sk-space-2);align-items:center;margin-bottom:var(--sk-space-2);">
        <label class="sk-muted sk-text-xs" style="flex-shrink:0;margin-bottom:0;">Debounce: ignore webhooks within</label>
        <input type="number" name="debounceMinutes" class="sk-input" min="1" step="1"
               value="${st.webhook_debounce_minutes ?? 1}"
               style="width:56px;height:var(--sk-btn-height-sm);margin:0;padding:0 0.45rem;font-size:var(--sk-text-xs);text-align:center;">
        <span class="sk-muted sk-text-xs" style="flex-shrink:0;">minute(s) of the previous one</span>
        <button type="submit" class="sk-btn sk-btn--sm">Save</button>
      </form>
      <div class="sk-muted sk-text-xs" style="margin-bottom:var(--sk-space-2);">Only the first webhook of a burst fires a run; each ignored webhook extends the quiet window. Scheduled and manual runs are not affected.</div>
      <div style="display:flex;gap:var(--sk-space-2);">
        <button class="sk-btn sk-btn--sm" hx-post="/api/scheduled-tasks/${eid}/webhook/regenerate" hx-swap="none"
                hx-confirm="Regenerate the secret? Every previously shared webhook URL stops working.">Regenerate secret</button>
        <button class="sk-btn sk-btn--danger sk-btn--sm" hx-post="/api/scheduled-tasks/${eid}/webhook/disable" hx-swap="none"
                hx-confirm="Disable the webhook trigger?">Disable</button>
      </div>`;
  }

  return `
      <div class="sk-panel" style="margin-top:var(--sk-space-3);">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Webhook Trigger</span>
          <span class="sk-badge ${enabled ? "sk-badge--running" : "sk-badge--waiting"}" style="font-size:9px;padding:1px 5px;">${enabled ? "enabled" : "off"}</span>
        </div>
        <div class="sk-panel__body" style="padding:var(--sk-space-4);">${body}</div>
      </div>`;
}

function renderScheduledDraftEdit(st: ScheduledTaskSummary, teams: Array<{ id: string; name: string }>, runs: Array<{ id: string; title: string; status: string; started_at: string | null; completed_at: string | null; result: string | null; created_at: string }> = []): string {
  const eid = escapeHtml(st.id);
  const badge = formatScheduleBadge(st.schedule_unit, st.schedule_amount, st.schedule_matrix ?? null);
  const matrix = parseScheduleMatrix(st.schedule_matrix ?? null);
  const mode = matrix ? "weekly" : st.schedule_unit ? "interval" : "";
  return `
    <div class="mc-task-header">
      <span class="mc-node__indicator mc-node__indicator--pending"></span>
      <span class="mc-task-header__title">${escapeHtml(st.title)}</span>
      <span class="sk-badge sk-badge--draft">draft</span>
      <span class="sk-badge sk-badge--waiting" style="font-size:9px;padding:1px 5px;">${badge}</span>
      ${st.team_name ? `<span class="sk-muted sk-text-xs">${escapeHtml(st.team_name)}</span>` : ""}
      <div class="mc-task-header__actions">
        <button class="sk-btn sk-btn--primary sk-btn--sm" hx-post="/api/scheduled-tasks/${eid}/approve" hx-swap="none">Approve</button>
        <button class="sk-btn sk-btn--danger sk-btn--sm" hx-delete="/api/scheduled-tasks/${eid}" hx-swap="none"
                hx-confirm="Delete this recurring task?" hx-on::after-request="if(event.detail.successful){window.location='/';}">Delete</button>
      </div>
    </div>

    <div style="padding: var(--sk-space-4) var(--sk-space-6);">
      <div class="sk-panel">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Configuration</span>
        </div>
        <div class="sk-panel__body" style="padding: var(--sk-space-4);">
          <form hx-post="/api/scheduled-tasks/${eid}/update" hx-swap="none">
            <div class="sk-form-group">
              <label class="sk-label">Title</label>
              <input type="text" name="title" class="sk-input" value="${escapeHtml(st.title)}" required>
            </div>
            <div class="sk-form-group">
              <label class="sk-label">Description</label>
              <textarea name="description" class="sk-textarea" rows="4">${st.description ? escapeHtml(st.description) : ""}</textarea>
            </div>
            <div class="sk-form-group">
              <label class="sk-label">Global Store Instructions</label>
              <textarea name="globalStoreInstructions" class="sk-textarea" rows="3"
                placeholder="Optional. Key names and payload structure for cross-run state, e.g.: store the last processed timestamp under key 'report-window' and resume from it next run.">${st.global_store_instructions ? escapeHtml(st.global_store_instructions) : ""}</textarea>
              <div class="sk-muted sk-text-xs" style="margin-top:var(--sk-space-1);">
                Injected into every run's prompt; authorizes Skipper to use the global store for state shared across runs.
              </div>
            </div>
            ${isExperimental() ? `
            <div class="sk-form-group">
              <label class="sk-label">Slack Slash Command</label>
              <input type="text" name="slashCommand" class="sk-input"
                value="${escapeHtml(typeof st.task_config?.slashCommand === "string" ? st.task_config.slashCommand : "")}"
                placeholder="/nightly-report">
              <div class="sk-muted sk-text-xs" style="margin-top:var(--sk-space-1);">
                Bind a Slack slash command to run this recurring task now (arg text = run input). Register the command in your Slack app and enable Socket Mode under <a href="/config">Config</a>. Leave blank to unbind.
              </div>
            </div>
            ` : ""}
            <div class="sk-form-row" style="gap:var(--sk-space-3);">
              <div class="sk-form-group" style="flex:1;">
                <label class="sk-label">Working Directory</label>
                <input type="text" name="workingDirectory" class="sk-input" placeholder="/path/to/repo">
              </div>
            </div>
            <div class="sk-form-row" style="gap:var(--sk-space-3);">
              <div class="sk-form-group" style="flex:1;">
                <label class="sk-label">Team</label>
                <select name="teamId" class="sk-select" required>
                  <option value="">Select team...</option>
                  ${teams.map(t => `<option value="${t.id}"${t.id === st.team_id ? " selected" : ""}>${escapeHtml(t.name)}</option>`).join("")}
                </select>
              </div>
            </div>
            <div class="sk-form-group">
              <label class="sk-label">Schedule</label>
              <select name="scheduleMode" class="sk-select" style="max-width:220px;">
                <option value=""${mode === "" ? " selected" : ""}>None (manual only)</option>
                <option value="interval"${mode === "interval" ? " selected" : ""}>Fixed interval</option>
                <option value="weekly"${mode === "weekly" ? " selected" : ""}>Weekly schedule</option>
              </select>
            </div>
            <div id="schedule-interval-fields" style="${mode === "interval" ? "" : "display:none;"}">
              <div class="sk-form-row" style="gap:var(--sk-space-3);">
                <div class="sk-form-group" style="flex:1;">
                  <label class="sk-label">Run every</label>
                  <input type="number" name="scheduleAmount" class="sk-input" min="1" value="${st.schedule_amount ?? ""}" style="max-width:100px;"${mode !== "interval" ? " disabled" : ""}>
                </div>
                <div class="sk-form-group" style="flex:1;">
                  <label class="sk-label">Unit</label>
                  <select name="scheduleUnit" class="sk-select"${mode !== "interval" ? " disabled" : ""}>
                    <option value="minutes"${st.schedule_unit === "minutes" ? " selected" : ""}>Minutes</option>
                    <option value="hours"${st.schedule_unit === "hours" || !st.schedule_unit ? " selected" : ""}>Hours</option>
                    <option value="days"${st.schedule_unit === "days" ? " selected" : ""}>Days</option>
                  </select>
                </div>
              </div>
            </div>
            <div id="schedule-matrix-fields" style="${mode === "weekly" ? "" : "display:none;"}">
              <div class="sk-form-group">
                <label class="sk-label">Weekly schedule</label>
                ${renderScheduleMatrixEditor(matrix, { inputDisabled: mode !== "weekly" })}
              </div>
            </div>
            <div class="sk-muted sk-text-xs" style="margin-top:calc(-1 * var(--sk-space-2)); margin-bottom:var(--sk-space-3);">
              Leave the schedule as "None" to run this task only manually via Run Now.
            </div>
            <div style="display:flex; gap:var(--sk-space-3); margin-top:var(--sk-space-4);">
              <button type="submit" class="sk-btn sk-btn--primary sk-btn--sm">Save Changes</button>
            </div>
          </form>
        </div>
      </div>

      <div class="sk-panel" style="margin-top:var(--sk-space-4);">
        <div class="sk-panel__header">
          <span class="sk-panel__title">Runs</span>
          <span class="sk-muted sk-text-xs">${runs.length} recent</span>
        </div>
        <div class="sk-panel__body" id="scheduled-runs-list"
             hx-get="/workspace/scheduled/${eid}/runs" hx-trigger="load, every 5s" hx-swap="innerHTML">
          ${renderScheduledRuns(runs)}
        </div>
      </div>
    </div>
  `;
}

export function renderScheduledRuns(runs: Array<{ id: string; title: string; status: string; started_at: string | null; completed_at: string | null; result: string | null; created_at: string }>): string {
  if (runs.length === 0) {
    return `<div class="sk-muted" style="padding:var(--sk-space-3);text-align:center;">No runs yet</div>`;
  }

  return `<table class="sk-table" style="width:100%;">
    <thead><tr><th>Started</th><th>Status</th><th>Duration</th><th>Result</th></tr></thead>
    <tbody>
      ${runs.map(r => {
    const statusClass = r.status === "completed" ? "sk-badge--completed"
      : r.status === "failed" ? "sk-badge--failed"
        : r.status === "running" ? "sk-badge--running"
          : "sk-badge--draft";
    let duration = "—";
    if (r.started_at && r.completed_at) {
      const ms = new Date(r.completed_at).getTime() - new Date(r.started_at).getTime();
      const secs = Math.round(ms / 1000);
      duration = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
    }
    let resultSummary = "";
    if (r.result) {
      try {
        const parsed = JSON.parse(r.result);
        resultSummary = typeof parsed === "string" ? parsed.slice(0, 80) : (parsed.summary ?? parsed.message ?? "").slice(0, 80);
      } catch {
        resultSummary = r.result.slice(0, 80);
      }
    }
    return `<tr style="cursor:pointer;" onclick="htmx.ajax('GET','/workspace/task/${escapeHtml(r.id)}',{target:'#mc-main',swap:'innerHTML'});history.pushState(null,'','/?task=${escapeHtml(r.id)}');">
          <td>${formatTimestamp(r.created_at)}</td>
          <td><span class="sk-badge ${statusClass}" style="font-size:10px;padding:1px 5px;">${escapeHtml(r.status)}</span></td>
          <td>${duration}</td>
          <td class="sk-muted sk-text-xs">${resultSummary ? escapeHtml(resultSummary) : "—"}</td>
        </tr>`;
  }).join("")}
    </tbody>
  </table>`;
}
