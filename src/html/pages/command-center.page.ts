import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import { renderInlineMarkdown } from "../atoms/render-inline-markdown";
import { formatTimestamp } from "../atoms/format-timestamp";
import { badgeFragment } from "../fragments/badge.fragment";
import { terminalJsonSummary, stripThinking, classifyPlainTerminalLine } from "../terminalJsonSummary";
import { iteratePanel } from "../panels/iterate.panel";
import { isExperimental } from "../../config/feature-flags";
import { parseScheduleMatrix } from "../../tasks/scheduled-scheduler";
import { renderScheduleMatrixEditor, renderScheduleMatrixView, countMatrixHours } from "../atoms/schedule-matrix";
import type { CommandCenterViewModel, TaskSummary, ScheduledTaskSummary } from "../view-models/command-center.vm";
import type { ScheduledRunRow } from "../../data/command-center";
import type { AgentTreeNode } from "../fragments/tree-node.fragment";

interface ScheduledTaskOverride {
  scheduledTask: ScheduledTaskSummary & { working_directory?: string; description?: string | null };
  runs: Array<{ id: string; title: string; status: string; started_at: string | null; completed_at: string | null; result: string | null; created_at: string }>;
  teams: Array<{ id: string; name: string }>;
}

export function commandCenterPage(vm: CommandCenterViewModel, selectedTaskId?: string, scheduledOverride?: ScheduledTaskOverride): string {
  const navHtml = navbar({
    currentPath: "/",
    daemonState: vm.daemonState,
    daemonUptime: vm.daemonUptime,
    escalationCount: vm.escalationCount,
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
  </aside>`;
}

/**
 * Sidebar: one scrolling list, sectioned by liveness instead of storage.
 * "Needs you" (always visible), then collapsible Active / Recurring / Teams,
 * then a history link. Section + series expansion reuses the data-tc-team
 * persistence in skipper.js (keys "sec:<name>" / "rec:<id>").
 */
export function renderSidebarListBody(vm: CommandCenterViewModel, activeId: string | null): string {
  // Terminal tasks can carry a stale needs_review flag (completed while a
  // review was pending); nothing is actionable on them, so they stay out.
  const attention = vm.allTasks.filter(t =>
    t.has_attention && t.status !== "completed" && t.status !== "failed");
  const attnIds = new Set(attention.map(t => t.id));

  // Active = alive or awaiting action, minus what already sits in Needs you.
  const active = vm.allTasks.filter(t =>
    !attnIds.has(t.id) &&
    (t.status === "running" || t.status === "approved" || t.status === "paused" || t.status === "draft"));

  const teamIds = new Set(vm.teams.map(t => t.id));
  const byTeam = new Map<string, TaskSummary[]>();
  const unassigned: TaskSummary[] = [];
  for (const t of vm.allTasks) {
    if (t.team_id && teamIds.has(t.team_id)) {
      const list = byTeam.get(t.team_id) ?? [];
      list.push(t);
      byTeam.set(t.team_id, list);
    } else {
      unassigned.push(t);
    }
  }
  const groups = vm.teams
    .map(team => renderTeamGroup(team, byTeam.get(team.id) ?? [], activeId))
    .join("");
  const other = unassigned.length > 0
    ? renderTeamGroup({ id: "", name: "No team" }, unassigned, activeId)
    : "";

  const recurring = vm.scheduledTasks
    .map(st => renderRecurringSeries(st, vm.scheduledRuns[st.id] ?? [], activeId))
    .join("");

  const attnHtml = attention.length > 0 ? `
    <div class="tc-attn">
      <div class="tc-sec__label tc-attn__label">Needs you</div>
      ${attention.map(t => sidebarItem(t, activeId)).join("")}
    </div>` : "";

  return `<div class="tc-side">
    ${attnHtml}
    ${section("active", "Active", active.length,
      active.length > 0 ? active.map(t => sidebarItem(t, activeId)).join("") : `<div class="tc-team__empty">Nothing running</div>`)}
    ${vm.scheduledTasks.length > 0 ? section("recurring", "Recurring", vm.scheduledTasks.length, recurring) : ""}
    ${section("teams", "Teams", vm.teams.length, `${groups}${other}` || `<div class="tc-team__empty">No teams yet</div>`)}
    <a class="tc-history" href="/tasks">Task history &rarr;</a>
  </div>`;
}

function section(key: string, label: string, count: number, bodyHtml: string): string {
  return `<details class="tc-sec" data-tc-team="sec:${key}" open>
    <summary class="tc-sec__head">
      <span class="tc-team__caret">&#x25B6;</span>
      <span class="tc-sec__label">${escapeHtml(label)}</span>
      ${count > 0 ? `<span class="tc-sec__count">${count}</span>` : ""}
    </summary>
    <div class="tc-sec__body">${bodyHtml}</div>
  </details>`;
}

/**
 * A recurring task as a series row: name (opens the detail view), a strip of
 * the last runs as status squares, and an expandable list of those runs that
 * open each run's task view directly.
 */
function renderRecurringSeries(st: ScheduledTaskSummary, runs: ScheduledRunRow[], activeId: string | null): string {
  const eid = escapeHtml(st.id);
  const badge = formatScheduleBadge(st.schedule_unit, st.schedule_amount, st.schedule_matrix ?? null);
  // Oldest → newest left to right, like a CI run strip.
  const strip = runs.length > 0
    ? `<span class="tc-runstrip">${[...runs].reverse().map(r =>
        `<span class="tc-runsq tc-runsq--${escapeHtml(r.status)}" title="${escapeHtml(r.status)}"></span>`).join("")}</span>`
    : "";
  const runRows = runs.map(r => `
    <a href="/?task=${escapeHtml(r.id)}"
        class="mc-sidebar__item${r.id === activeId ? " mc-sidebar__item--active" : ""}"
        hx-get="/workspace/task/${escapeHtml(r.id)}" hx-target="#mc-main" hx-swap="innerHTML" hx-push-url="/?task=${escapeHtml(r.id)}">
      <span class="mc-sidebar__item-dot mc-sidebar__item-dot--${escapeHtml(r.status)}"></span>
      <span class="mc-sidebar__item-title">${formatTimestamp(r.created_at)}</span>
      <span class="mc-sidebar__item-time">${escapeHtml(r.status)}</span>
    </a>`).join("");
  const hasRunning = runs.some(r => r.status === "running");
  const isActive = st.id === activeId;

  return `<details class="tc-team tc-rec${isActive ? " tc-team--active" : ""}" data-tc-team="rec:${eid}"${isActive || hasRunning ? " open" : ""}>
    <summary>
      <div class="tc-team__head">
        <span class="tc-team__caret">&#x25B6;</span>
        <span class="tc-team__dot${hasRunning ? " tc-team__dot--running" : ""}"></span>
        <a href="/?scheduled=${eid}" class="tc-team__name" style="color:inherit;text-decoration:none;"
          hx-get="/workspace/scheduled/${eid}" hx-target="#mc-main" hx-swap="innerHTML" hx-push-url="/?scheduled=${eid}">${escapeHtml(st.title)}</a>
        ${strip}
        <span class="tc-rec__badge">${escapeHtml(badge)}</span>
      </div>
    </summary>
    <div class="tc-team__tasks">
      ${runRows || `<div class="tc-team__empty">No runs yet</div>`}
      <a class="tc-rec__all" href="/?scheduled=${eid}"
        hx-get="/workspace/scheduled/${eid}" hx-target="#mc-main" hx-swap="innerHTML" hx-push-url="/?scheduled=${eid}">All runs &rarr;</a>
    </div>
  </details>`;
}

export function pickTeamLandingTask(tasks: TaskSummary[]): TaskSummary | null {
  const rank = (t: TaskSummary): number =>
    t.status === "running" ? 0 : t.status === "approved" ? 1 : t.status === "paused" ? 2 : 3;
  // allTasks arrives created_at DESC, so within a rank the first hit is newest.
  return [...tasks].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

function renderTeamGroup(team: { id: string; name: string }, tasks: TaskSummary[], activeId: string | null): string {
  const hasActive = tasks.some(t => t.id === activeId);
  const hasRunning = tasks.some(t => t.status === "running");
  const attention = tasks.filter(t => t.has_attention).length;
  const landing = pickTeamLandingTask(tasks);
  const isOpen = hasActive || hasRunning;

  const nameHtml = landing
    ? `<a href="/?task=${escapeHtml(landing.id)}" class="tc-team__name"
        hx-get="/workspace/task/${escapeHtml(landing.id)}" hx-target="#mc-main" hx-swap="innerHTML" hx-push-url="/?task=${escapeHtml(landing.id)}"
        style="color:inherit;text-decoration:none;">${escapeHtml(team.name)}</a>`
    : `<span class="tc-team__name">${escapeHtml(team.name)}</span>`;

  // Recent tasks only — the deep archive lives on /tasks. The active task is
  // force-included so the selection never renders outside its group.
  const shown = tasks.slice(0, 8);
  if (activeId && tasks.some(t => t.id === activeId) && !shown.some(t => t.id === activeId)) {
    shown.push(tasks.find(t => t.id === activeId)!);
  }
  const overflow = tasks.length > shown.length
    ? `<a class="tc-rec__all" href="/tasks">+${tasks.length - shown.length} older &rarr;</a>`
    : "";
  const taskRows = tasks.length > 0
    ? shown.map(t => sidebarItem(t, activeId)).join("") + overflow
    : `<div class="tc-team__empty">No tasks yet</div>`;

  return `<details class="tc-team${hasActive ? " tc-team--active" : ""}"${isOpen ? " open" : ""} data-tc-team="${escapeHtml(team.id || "none")}">
    <summary>
      <div class="tc-team__head">
        <span class="tc-team__caret">&#x25B6;</span>
        <span class="tc-team__dot${hasRunning ? " tc-team__dot--running" : ""}"></span>
        ${nameHtml}
        ${attention > 0 ? `<span class="tc-team__count" title="Needs your input">${attention}</span>` : ""}
      </div>
    </summary>
    <div class="tc-team__tasks">${taskRows}</div>
  </details>`;
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

function formatScheduleBadge(unit: string | null, amount: number | null, matrix: string | null = null): string {
  if (matrix) return "weekly";
  if (!unit || !amount) return "manual";
  if (unit === "minutes") return amount === 1 ? "1m" : `${amount}m`;
  if (unit === "hours") return amount === 1 ? "1h" : `${amount}h`;
  if (unit === "days") return amount === 1 ? "daily" : `${amount}d`;
  return `${amount}${unit[0]}`;
}

function renderWelcome(vm: CommandCenterViewModel): string {
  // allTasks is ordered created_at DESC across every status, so the first three
  // are the latest tasks regardless of state.
  const latest = vm.allTasks.slice(0, 3);

  const rows = latest.length > 0
    ? latest.map(t => `
        <a class="mc-landing__task" href="/?task=${escapeHtml(t.id)}"
           hx-get="/workspace/task/${escapeHtml(t.id)}" hx-target="#mc-main" hx-swap="innerHTML" hx-push-url="/?task=${escapeHtml(t.id)}">
          <span class="mc-sidebar__item-dot mc-sidebar__item-dot--${escapeHtml(t.status)}"></span>
          <span class="mc-landing__task-title">${escapeHtml(t.title)}</span>
          ${badgeFragment(t.status)}
          <span class="mc-landing__task-time">${formatTimestamp(t.completed_at ?? t.created_at)}</span>
        </a>`).join("")
    : `<div class="mc-landing__empty">No tasks yet. Create your first one.</div>`;

  return `<div class="mc-welcome">
    <div class="mc-landing">
      <div class="mc-landing__header">
        <span class="mc-landing__kicker">Command Center</span>
        <span class="mc-landing__title">What next?</span>
        <span class="mc-landing__hint">Pick up a recent task, or start something new.</span>
      </div>

      <div class="mc-landing__section-label">Latest tasks</div>
      <div class="mc-landing__tasks">${rows}</div>

      <div class="mc-landing__actions">
        <a href="/tasks/new" class="sk-btn sk-btn--primary sk-btn--sm">+ New Task</a>
        <a href="/teams" class="sk-btn sk-btn--sm">Teams</a>
        <a href="/config" class="sk-btn sk-btn--sm">Config</a>
      </div>
    </div>
  </div>`;
}

function renderTaskView(vm: CommandCenterViewModel, task: TaskSummary): string {
  // Draft tasks — show edit form
  if (task.status === "draft") {
    return renderDraftEdit(task, vm.teams);
  }
  // Check if this is a real-time task — render different UI
  const taskRow = vm.allTasks.find(t => t.id === task.id);
  if (taskRow && (taskRow as any).task_type === "real_time") {
    const isSessionActive = vm.realtimeSessionActive[task.id];
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
/**
 * The panel dock: a toggle bar (Timeline · Details · Escalations · Notes ·
 * Artifacts · Messages) over a row of resizable, reorderable columns.
 * `Skipper.dock` (skipper.js) shows any number of them side by side (one must
 * stay open), persists the layout, and inserts the resize dividers. Every panel
 * stays mounted so its hx-get / WS-OOB targets (mc-notes-<id>,
 * mc-artifacts-<id>, mc-messages-<id>, mc-task-escalations-<id>, feed ids) stay
 * stable; the JS just flips `display`. Shared by the standard and realtime task
 * renderers below.
 */
function renderTaskDock(taskId: string, opts: {
  variant: "standard" | "realtime";
  escalationsExtra?: string;
  defaultOpen?: string;
}): string {
  const eid = escapeHtml(taskId);
  const tl = opts.variant === "realtime"
    ? { title: "Timeline", feedId: `mc-rt-feed-${eid}`, url: `/workspace/task/${eid}/realtime-activity`, def: "all",
        filters: [["all", "All"], ["timeline", "Timeline"], ["activity", "Activity"]] as [string, string][] }
    : { title: "Activity", feedId: `mc-activity-feed-${eid}`, url: `/workspace/task/${eid}/activity`, def: "messages",
        filters: [["all", "All"], ["messages", "Messages"], ["tools", "Tools"]] as [string, string][] };

  const timelineControls = `<div class="mc-activity__controls">${tl.filters.map(([k, l]) =>
    `<button class="mc-activity__filter${k === tl.def ? " mc-activity__filter--active" : ""}" data-sk-activity-filter="${k}">${l}</button>`).join("")}</div>`;
  const timelineBody = `<div class="mc-activity__feed" id="${tl.feedId}" data-activity-filter="${tl.def}"
       hx-get="${tl.url}" hx-trigger="load" hx-swap="innerHTML"><span class="sk-muted">Loading...</span></div>`;

  // Column shell: header is the reorder drag handle + a close ✕. `flush` = no body
  // padding (the inner container pads itself).
  const col = (name: string, title: string, controls: string, body: string, flush: boolean) => `
      <div class="mc-outputs__col" data-dock-panel="${name}">
        <div class="mc-outputs__col-header" draggable="true" data-dock-handle="${name}">
          <span class="mc-outputs__col-title">${title}</span>
          <button type="button" class="mc-outputs__col-close" data-dock-close="${name}" title="Close panel" aria-label="Close panel">&times;</button>
        </div>
        ${controls}
        <div class="mc-outputs__col-body"${flush ? ' style="padding:0;"' : ""}>${body}</div>
      </div>`;

  // Details is heavy (agent tree) — defer its fetch until the panel is first
  // opened via the `dockopen` trigger that Skipper.dock fires.
  const detailsBody = `<div data-dock-lazy hx-get="/workspace/task/${eid}/details" hx-trigger="dockopen" hx-swap="innerHTML"><span class="sk-muted" style="padding:var(--sk-space-4);">Loading...</span></div>`;
  const escalationsBody = `<div id="mc-task-escalations-${eid}" hx-get="/fragments/tasks/${eid}/escalations" hx-trigger="load" hx-swap="innerHTML"></div>${opts.escalationsExtra ?? ""}`;
  const notesBody = `<div id="mc-notes-${eid}" style="padding:var(--sk-space-2);" hx-get="/fragments/tasks/${eid}/notes" hx-trigger="load" hx-swap="innerHTML"><span class="sk-muted">Loading notes...</span></div>`;
  // Operator messages (experimental): agent-written updates for the human. Kept
  // out of the dock entirely when the flag is off so the tab bar does not offer a
  // panel whose fragment route 404s.
  const showMessages = isExperimental();
  const messagesBody = `<div id="mc-messages-${eid}" hx-get="/fragments/tasks/${eid}/messages" hx-trigger="load" hx-swap="innerHTML"><span class="sk-muted" style="padding:var(--sk-space-3);display:block;">Loading messages...</span></div>`;
  const artifactsBody = `<div id="mc-artifacts-${eid}" style="padding:var(--sk-space-2);" hx-get="/fragments/tasks/${eid}/artifacts" hx-trigger="load" hx-swap="innerHTML"><span class="sk-muted">Loading artifacts...</span></div>
        <div id="sk-artifact-detail-window" class="artifact-inset" hidden>
          <div class="artifact-inset__bar">
            <span class="artifact-inset__bar-title">Artifact</span>
            <button type="button" class="artifact-inset__close" data-sk-artifact-close title="Close" aria-label="Close artifact">&times;</button>
          </div>
          <div class="artifact-inset__body"><div id="sk-artifact-detail" data-sk-artifact-detail></div></div>
        </div>`;

  return `
    <div class="mc-tabs" role="tablist">
      <button type="button" class="mc-tab" data-mc-tab="timeline" onclick="Skipper.dock.toggle('timeline')">${tl.title}</button>
      <button type="button" class="mc-tab" data-mc-tab="details" onclick="Skipper.dock.toggle('details')">Details</button>
      <button type="button" class="mc-tab" data-mc-tab="input" onclick="Skipper.dock.toggle('input')">Escalations<span data-mc-tab-badge class="mc-tab__badge" hidden></span></button>
      <button type="button" class="mc-tab" data-mc-tab="notes" onclick="Skipper.dock.toggle('notes')">Notes</button>
      <button type="button" class="mc-tab" data-mc-tab="artifacts" onclick="Skipper.dock.toggle('artifacts')">Artifacts</button>
      ${showMessages ? `<button type="button" class="mc-tab" data-mc-tab="messages" onclick="Skipper.dock.toggle('messages')">Messages</button>` : ""}
    </div>
    <div class="mc-outputs" id="mc-outputs" data-dock-default="${escapeHtml(opts.defaultOpen ?? "timeline,notes")}">
      ${col("timeline", tl.title, timelineControls, timelineBody, false)}
      ${col("details", "Details", "", detailsBody, false)}
      ${col("input", "Escalations", "", escalationsBody, false)}
      ${col("notes", "Notes", "", notesBody, true)}
      ${col("artifacts", "Artifacts", "", artifactsBody, true)}
      ${showMessages ? col("messages", "Messages", "", messagesBody, true) : ""}
    </div>`;
}

export function realtimeTaskContent(vm: CommandCenterViewModel, task: TaskSummary, isSessionActive?: boolean): string {
  const eid = escapeHtml(task.id);
  const isRunning = task.status === "running";
  const sessionActive = isRunning && isSessionActive !== false;
  const isPaused = isRunning && isSessionActive === false;

  // Reuse the shared task chrome: phase stepper inlined into the task bar, agent
  // orbs beside it, and the review/escalation prompts inside a User Input tab —
  // exactly like the standard task view.
  const mission = vm.missionsByTask[task.id] ?? (vm.mission?.taskId === task.id ? vm.mission : null);
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

    <!-- Toggle bar + resizable panel dock (flush against the composer) -->
    ${renderTaskDock(task.id, { variant: "realtime" })}

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

  `;
}

/**
 * Task view: full-width header, then a unified timeline column with an
 * artifacts/notes rail inside the same container. Messages, tool groups and
 * escalations all live in the timeline; notes input lives in the rail.
 *
 * Also served as a fragment at /workspace/task/:id for HTMX sidebar clicks.
 */
export function taskMainContent(vm: CommandCenterViewModel, task: TaskSummary): string {
  const eid = escapeHtml(task.id);
  const mission = vm.missionsByTask[task.id] ?? (vm.mission?.taskId === task.id ? vm.mission : null);
  const isRunning = task.status === "running";
  const needsReview = mission?.needsReview ?? false;
  const phaseStepper = mission && mission.phases.length > 0 ? renderPhaseStepper(mission.phases, task.id, isRunning) : "";
  const actions = renderActions(task, needsReview);

  const resultHtml = (task.status === "completed" || task.status === "failed") && task.result_summary ? `
    <div class="sk-panel"><div class="sk-panel__body" style="padding: var(--sk-space-3) var(--sk-space-4); color: var(--sk-text-muted); font-size: var(--sk-text-sm);">${escapeHtml(task.result_summary)}</div></div>
  ` : "";
  const reviewGate = task.status === "failed" && task.needs_review
    ? renderRecoveryPausedBanner(task)
    : needsReview ? renderReviewBanner(task) : "";
  const iterate = task.status === "completed" ? iteratePanel(task.id) : "";
  const attention = reviewGate || iterate || resultHtml
    ? `<div class="mc-attention-slot">${reviewGate}${iterate}${resultHtml}</div>` : "";

  return `
    <!-- Task header: full width above timeline + rail -->
    <div class="mc-task-header mc-task-header--with-phases${isRunning ? " mc-task-header--running" : ""}">
      <span class="mc-node__indicator mc-node__indicator--${task.status === "waiting_delegation" ? "waiting" : task.status}"></span>
      <span class="mc-task-header__title">${escapeHtml(task.title)}</span>
      <div class="mc-task-header__scroll">
        ${phaseStepper ? `<div class="mc-task-header__phases">${phaseStepper}</div>` : ""}
        ${isRunning || task.status === "completed" ? `<div class="mc-task-header__orbs">
          <div id="mc-steer-${eid}"
            hx-get="/fragments/dashboard/latest-steer?task=${eid}"
            hx-trigger="load"
            hx-target="this"
            hx-swap="innerHTML"></div>
        </div>` : ""}
      </div>
      <div class="mc-task-header__actions">${actions}</div>
    </div>

    ${attention}

    <div class="tc-work">
      <div class="tc-timeline-col">
        <div class="tc-timeline" id="mc-timeline-${eid}" data-tc-stick="on">
          <div class="tc-timeline__inner" id="mc-timeline-inner-${eid}"
            hx-get="/workspace/task/${eid}/timeline" hx-trigger="load" hx-swap="innerHTML"><span class="sk-muted">Loading...</span></div>
        </div>
      </div>

      <div class="tc-divider" data-tc-divider title="Drag to resize"></div>

      <aside class="tc-rail">
        <input type="radio" class="tc-rt tc-rt-arts" name="tc-rail-tab" id="tc-rt-arts" checked>
        <input type="radio" class="tc-rt tc-rt-notes" name="tc-rail-tab" id="tc-rt-notes">
        <input type="radio" class="tc-rt tc-rt-activity" name="tc-rail-tab" id="tc-rt-activity">
        <div class="tc-rail__tabs">
          <label class="tc-tab--arts" for="tc-rt-arts">Artifacts</label>
          <label class="tc-tab--notes" for="tc-rt-notes">Notes</label>
          <label class="tc-tab--activity" for="tc-rt-activity">Activity</label>
        </div>
        <div class="tc-rail__pane tc-rail__pane--arts">
          <div id="mc-artifacts-${eid}" hx-get="/fragments/tasks/${eid}/artifacts" hx-trigger="load" hx-swap="innerHTML"><span class="sk-muted">Loading artifacts...</span></div>
        </div>
        <div class="tc-rail__pane tc-rail__pane--notes">
          <div id="mc-notes-${eid}" hx-get="/fragments/tasks/${eid}/notes" hx-trigger="load" hx-swap="innerHTML"><span class="sk-muted">Loading notes...</span></div>
        </div>
        <div class="tc-rail__pane tc-rail__pane--activity">
          <div class="mc-activity__controls">
            <button class="mc-activity__filter" data-sk-activity-filter="all">All</button>
            <button class="mc-activity__filter mc-activity__filter--active" data-sk-activity-filter="messages">Messages</button>
            <button class="mc-activity__filter" data-sk-activity-filter="tools">Tools</button>
          </div>
          <div class="mc-activity__feed" id="mc-activity-feed-${eid}" data-activity-filter="messages"
            hx-get="/workspace/task/${eid}/activity" hx-trigger="load" hx-swap="innerHTML"><span class="sk-muted">Loading...</span></div>
        </div>
        <div class="tc-rail__more">
          <a onclick="Skipper.modal.open('tc-details-modal')"
             hx-get="/workspace/task/${eid}/details" hx-target="#tc-details-modal-body" hx-swap="innerHTML">Details &amp; agents</a>
        </div>
      </aside>
    </div>

    <!-- Fullscreen artifact overlay (same ids as the classic inset so the
         artifact links, editor and close JS work unchanged) -->
    <div id="sk-artifact-detail-window" class="tc-artifact-overlay" hidden>
      <div class="artifact-inset__bar">
        <span class="artifact-inset__bar-title">Artifact</span>
        <button type="button" class="artifact-inset__close" data-sk-artifact-close title="Close" aria-label="Close artifact">&times;</button>
      </div>
      <div class="artifact-inset__body"><div id="sk-artifact-detail" data-sk-artifact-detail></div></div>
    </div>

    <!-- Details modal -->
    <div id="tc-details-modal" class="sk-modal" data-sk-modal-backdrop style="padding:1rem;">
      <div class="sk-modal__content" style="width:min(900px, 95vw); max-height:85vh; display:flex; flex-direction:column;">
        <div class="sk-modal__header" style="padding:0.5rem 1rem; gap:0.75rem;">
          <span style="font-weight:600;">Details</span>
          <button class="sk-btn sk-btn--sm" data-sk-modal-close="tc-details-modal">Close</button>
        </div>
        <div class="sk-modal__body" id="tc-details-modal-body" style="flex:1; min-height:0; overflow:auto; padding:0.75rem 1rem;">
          <span class="sk-muted">Loading...</span>
        </div>
      </div>
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
  perKindLimit = 120,
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
        } else if (type === "assistant" || type === "user" || type === "message" || typeof parsed.result === "string"
          // Grok response/reasoning chunks: {type:"text"|"thought",data:"…"}. Prose,
          // so they belong under the Messages filter rather than with system events.
          || ((type === "text" || type === "thought") && typeof parsed.data === "string")
          // OpenCode whole-message text: {type:"text",part:{text:"…"}} (part, not data).
          || (type === "text" && !!(parsed.part as Record<string, unknown> | undefined)?.text)) {
          kind = "message";
        }
      } else {
        summary = data.length > 200 ? data.slice(0, 200) + "..." : data;
        kind = classifyPlainTerminalLine(line.stream, data);
      }
    } else {
      summary = data.length > 200 ? data.slice(0, 200) + "..." : data;
      kind = classifyPlainTerminalLine(line.stream, data);
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
      <span class="mc-activity__text">${kind === "message" ? renderInlineMarkdown(summary) : escapeHtml(summary)}</span>
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
        <span class="mc-activity__text">${kind === "message" ? renderInlineMarkdown(preview) : escapeHtml(preview)}</span>
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
        } else if (type === "assistant" || type === "user" || type === "message" || typeof parsed.result === "string"
          // Grok response/reasoning chunks: {type:"text"|"thought",data:"…"}. Prose,
          // so they belong under the Messages filter rather than with system events.
          || ((type === "text" || type === "thought") && typeof parsed.data === "string")
          // OpenCode whole-message text: {type:"text",part:{text:"…"}} (part, not data).
          || (type === "text" && !!(parsed.part as Record<string, unknown> | undefined)?.text)) {
          kind = "message";
        }
      } else {
        summary = data.length > 200 ? data.slice(0, 200) + "..." : data;
        kind = classifyPlainTerminalLine(row.stream, data);
      }
    } else {
      summary = data.length > 200 ? data.slice(0, 200) + "..." : data;
      kind = classifyPlainTerminalLine(row.stream, data);
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
      <span class="mc-activity__text">${kind === "message" ? renderInlineMarkdown(summary) : escapeHtml(summary)}</span>
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
