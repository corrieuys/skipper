import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import { renderInlineMarkdown } from "../atoms/render-inline-markdown";
import { formatTimestamp } from "../atoms/format-timestamp";
import { terminalJsonSummary, stripThinking, classifyPlainTerminalLine } from "../terminalJsonSummary";
import { isExperimental } from "../../config/feature-flags";
import { readSeriesMemoryConfig } from "../../task-memory/scope";
import { formatBytes } from "../../orchestrator/artifact-files";
import {
  statusChip,
  modeChip,
  displayStatusOf,
  displayDotClass,
  displayIndicatorClass,
  displayRunSquareClass,
  taskResultHasError,
} from "../fragments/status-chip.fragment";
import { isSoloTeamId } from "../../agents/solo";
import { entityIcon, lucideSvg } from "../atoms/lucide";
import { iconIdentityPicker, iconIdentityPickerScript } from "../atoms/icon-identity-picker";
import { starButtonFragment } from "../fragments/star-button.fragment";
import { parseScheduleMatrix } from "../../tasks/scheduled-scheduler";
import { renderScheduleMatrixEditor, renderScheduleMatrixView, countMatrixHours } from "../atoms/schedule-matrix";
import type { CommandCenterViewModel, TaskSummary, ScheduledTaskSummary } from "../view-models/command-center.vm";
import type { ScheduledRunRow } from "../../data/command-center";
import type { AgentTreeNode } from "../fragments/tree-node.fragment";

// Task-header title: cap at 40 chars, ellipsis if longer; full text on hover.
function headerTitle(title: string): string {
  const t = title ?? "";
  const short = t.length > 40 ? t.slice(0, 40) + "…" : t;
  const attr = t.length > 40 ? ` title="${escapeHtml(t)}"` : "";
  return `<span class="mc-task-header__title"${attr}>${escapeHtml(short)}</span>`;
}

/**
 * The task header's identity cluster: chosen icon (if any) + title + an edit
 * pencil (swaps in the inline name/icon editor, see the /fragments/tasks/:id/
 * identity-edit route) + the star toggle. Rendered in an id'd slot so the edit
 * fragment can swap it in place.
 */
export function taskHeaderIdentity(task: TaskSummary, opts: { oob?: boolean } = {}): string {
  const eid = escapeHtml(task.id);
  const icon = task.icon
    ? `<span class="mc-task-header__icon">${entityIcon(task.icon, task.icon_color, { size: 18 })}</span>`
    : "";
  // When oob, this renders as an out-of-band swap: it updates the open task's
  // header identity slot (if that task is on screen), else htmx ignores it.
  const oob = opts.oob ? ` hx-swap-oob="true"` : "";
  return `<span class="mc-task-header__identity" id="mc-task-identity-${eid}"${oob}>
    ${icon}
    ${headerTitle(task.title)}
    <button type="button" class="mc-task-header__edit"
      hx-get="/fragments/tasks/${eid}/identity-edit" hx-target="#mc-task-identity-${eid}" hx-swap="outerHTML"
      title="Edit name & icon" aria-label="Edit name and icon">${lucideSvg("pencil", { size: 13, color: "#8b93a7" })}</button>
    ${starButtonFragment(task.id, task.starred, "task")}
  </span>`;
}

/**
 * Inline editor swapped into the header identity slot by the edit pencil. Saves
 * title + icon for a task in ANY status (POST /api/tasks/:id/identity re-renders
 * the whole task view into #mc-main); Cancel re-fetches the task view to discard.
 * Carries its own picker script (idempotent) since it arrives via an htmx swap.
 */
export function renderTaskIdentityEdit(task: TaskSummary): string {
  const eid = escapeHtml(task.id);
  return `<span class="mc-task-header__identity mc-task-header__identity--edit" id="mc-task-identity-${eid}">
    <form class="mc-identity-edit" hx-post="/api/tasks/${eid}/identity"
      hx-target="#mc-task-identity-${eid}" hx-swap="outerHTML">
      <input type="text" name="title" class="sk-input sk-input--sm mc-identity-edit__title" value="${escapeHtml(task.title)}" required aria-label="Task name" autofocus>
      <details class="mc-identity-edit__icon">
        <summary title="Choose an icon">${lucideSvg(task.icon ?? "image", { size: 15, color: task.icon_color ?? "#8b93a7" })}</summary>
        <div class="mc-identity-edit__picker">${iconIdentityPicker({ icon: task.icon, color: task.icon_color, nameIcon: "icon", nameColor: "iconColor" })}</div>
      </details>
      <button type="submit" class="sk-btn sk-btn--primary sk-btn--sm">Save</button>
      <button type="button" class="sk-btn sk-btn--sm"
        hx-get="/fragments/tasks/${eid}/identity" hx-target="#mc-task-identity-${eid}" hx-swap="outerHTML">Cancel</button>
    </form>
    ${iconIdentityPickerScript()}
  </span>`;
}

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
      : vm.allTasks.find(t => t.display_status === "working");

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
      <button class="mc-sidebar__collapse-teams" data-sk-collapse-teams title="Collapse all folders" aria-label="Collapse all folders">&#x2212;</button>
      <button class="mc-sidebar__collapse-btn" data-sk-sidebar-toggle title="Pin sidebar open">&#x25C0;</button>
    </div>
    <div class="mc-sidebar__list" id="mc-sidebar-list">
      ${renderSidebarListBody(vm, activeId)}
    </div>
    <div class="mc-sidebar__resize" data-sk-sidebar-resize title="Drag to resize" aria-hidden="true"></div>
  </aside>`;
}

/**
 * Sidebar: one scrolling list, sectioned by liveness instead of storage.
 * "Needs you" (always visible), then collapsible Active / Recurring / Teams,
 * then a history link. Section + series expansion reuses the data-tc-team
 * persistence in skipper.js (keys "sec:<name>" / "rec:<id>").
 */
export function renderSidebarListBody(vm: CommandCenterViewModel, activeId: string | null): string {
  // Settled tasks can carry a stale needs_review flag (settled while a
  // review was pending); nothing is actionable on them, so they stay out.
  const attention = vm.allTasks.filter(t =>
    t.has_attention && t.status !== "settled");
  const attnIds = new Set(attention.map(t => t.id));

  // Active = alive or awaiting action, minus what already sits in Needs you.
  const active = vm.allTasks.filter(t =>
    !attnIds.has(t.id) &&
    (t.status === "active" || t.status === "draft"));

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
  // Solo agents (single agent OR custom agent run solo) are projected as
  // teams-of-one (`sa:`/`ca:`); group them all under one "Agents" section, apart
  // from real teams.
  const regularTeams = vm.teams.filter(t => !isSoloTeamId(t.id));
  const soloTeams = vm.teams.filter(t => isSoloTeamId(t.id));
  const renderGroups = (teams: Array<{ id: string; name: string }>): string =>
    teams.map(team => renderTeamGroup(team, byTeam.get(team.id) ?? [], activeId)).join("");
  const groups = renderGroups(regularTeams);
  const soloGroups = renderGroups(soloTeams);
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

  // Recent = the 5 latest tasks not already surfaced in Needs you or Active.
  // allTasks is created_at DESC, so a slice after the exclusion is chronological.
  const shownIds = new Set<string>([...attnIds, ...active.map(t => t.id)]);
  const recent = vm.allTasks.filter(t => !shownIds.has(t.id)).slice(0, 5);

  // Tabbed boards (mirrors the iOS segmented control: Latest / Teams /
  // Agents). Latest stacks Needs you + Active + Recurring + Recent; each other
  // tab shows one list. The active board is a client-side toggle persisted as
  // `sidebarBoard` and re-applied after WS re-renders (see skipper.js), so the
  // server always renders Latest active and the client corrects it.
  const latestBody = `${attnHtml}
    ${section("active", "Active", active.length,
      active.length > 0 ? active.map(t => sidebarItem(t, activeId)).join("") : `<div class="tc-team__empty">Nothing running</div>`)}
    ${vm.scheduledTasks.length > 0 ? section("Scheduled", "Recurring", vm.scheduledTasks.length, recurring) : ""}
    ${recent.length > 0 ? section("recent", "Recent", recent.length,
      recent.map(t => sidebarItem(t, activeId)).join("")) : ""}`;
  const teamsBody = (`${groups}${other}`) || `<div class="tc-team__empty">No teams yet</div>`;
  const agentsBody = soloTeams.length > 0
    ? soloGroups : `<div class="tc-team__empty">No agents yet</div>`;

  // Favorites board: every starred task + starred recurring task, newest first.
  // allTasks is already created_at DESC. Toggling a star emits task:state_changed,
  // so the whole sidebar (this board included) re-renders live.
  const favTasks = vm.allTasks.filter(t => t.starred);
  const favRecurring = vm.scheduledTasks.filter(st => !!st.starred);
  const favCount = favTasks.length + favRecurring.length;
  const favoritesBody = favCount > 0
    ? `${favTasks.map(t => sidebarItem(t, activeId)).join("")}
       ${favRecurring.map(st => renderRecurringSeries(st, vm.scheduledRuns[st.id] ?? [], activeId)).join("")}`
    : `<div class="tc-team__empty">No starred tasks yet. Tap the star on any task to pin it here.</div>`;

  return `<div class="tc-side">
    <div class="tc-tabs" role="tablist">
      ${tab("latest", "Latest", 0, true)}
      ${tab("favorites", "Favorites", favCount, false)}
      ${tab("teams", "Teams", regularTeams.length, false)}
      ${tab("agents", "Agents", soloTeams.length, false)}
    </div>
    ${board("latest", latestBody, true)}
    ${board("favorites", favoritesBody, false)}
    ${board("teams", teamsBody, false)}
    ${board("agents", agentsBody, false)}
    <a class="tc-history" href="/tasks">Task history &rarr;</a>
  </div>`;
}

/**
 * An out-of-band swap that refreshes ONLY the sidebar list (`#mc-sidebar-list`),
 * mirroring the WS ui-push path. Appended to the star route responses so
 * favoriting updates the Favorites board live WITHOUT re-rendering `#mc-main`
 * (the task view stays put — no page refresh). activeId is null, matching the WS
 * refresh; the client re-applies board/active state on swap.
 */
export function renderSidebarOob(db: unknown): string {
  const { buildCommandCenterViewModel } = require("../view-models/command-center.vm");
  const vm = buildCommandCenterViewModel(db);
  return `<div id="mc-sidebar-list" class="mc-sidebar__list" hx-swap-oob="outerHTML">${renderSidebarListBody(vm, null)}</div>`;
}

function tab(key: string, label: string, count: number, active: boolean): string {
  return `<button type="button" class="tc-tab${active ? " tc-tab--active" : ""}" data-tc-board="${key}" role="tab" aria-selected="${active}">
    <span class="tc-tab__label">${escapeHtml(label)}</span>${count > 0 ? `<span class="tc-tab__count">${count}</span>` : ""}
  </button>`;
}

function board(key: string, bodyHtml: string, active: boolean): string {
  return `<div class="tc-board" data-tc-board-panel="${key}"${active ? "" : " hidden"}>${bodyHtml}</div>`;
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
  // Run rows only carry the stored status; approximate the display state from
  // whether the last run settled (completed_at) or is still live.
  const runDisplay = (r: ScheduledRunRow): "working" | "idle" | "completed" | "failed" =>
    r.status === "settled"
      ? (taskResultHasError(r.result) ? "failed" : "completed")
      : r.completed_at ? "idle" : "working";
  // Oldest to newest left to right, like a CI run strip.
  const strip = runs.length > 0
    ? `<span class="tc-runstrip">${[...runs].reverse().map(r =>
        `<span class="tc-runsq tc-runsq--${displayRunSquareClass(runDisplay(r))}" title="${escapeHtml(runDisplay(r))}"></span>`).join("")}</span>`
    : "";
  const runRows = runs.map(r => `
    <a href="/?task=${escapeHtml(r.id)}"
        class="mc-sidebar__item${r.id === activeId ? " mc-sidebar__item--active" : ""}"
        hx-get="/workspace/task/${escapeHtml(r.id)}" hx-target="#mc-main" hx-swap="innerHTML" hx-push-url="/?task=${escapeHtml(r.id)}">
      <span class="mc-sidebar__item-dot mc-sidebar__item-dot--${displayDotClass(runDisplay(r))}"></span>
      <span class="mc-sidebar__item-title">${formatTimestamp(r.created_at)}</span>
      <span class="mc-sidebar__item-time">${escapeHtml(runDisplay(r))}</span>
    </a>`).join("");
  const hasRunning = runs.some(r => runDisplay(r) === "working");
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
  const rank = (t: TaskSummary): number => {
    switch (t.display_status) {
      case "working": return 0;
      case "review": return 1;
      case "blocked": return 1;
      case "queued": return 2;
      case "paused": return 3;
      case "idle": return 4;
      default: return 5;
    }
  };
  // allTasks arrives created_at DESC, so within a rank the first hit is newest.
  return [...tasks].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

function renderTeamGroup(team: { id: string; name: string; icon?: string | null; icon_color?: string | null }, tasks: TaskSummary[], activeId: string | null): string {
  const hasActive = tasks.some(t => t.id === activeId);
  const hasRunning = tasks.some(t => t.display_status === "working");
  const attention = tasks.filter(t => t.has_attention).length;
  const landing = pickTeamLandingTask(tasks);
  // Collapsed by default on startup; only the group holding the currently
  // viewed task stays open so the selection is never hidden. Client-side
  // persistence (tcTeamOpen) still remembers the user's own toggles.
  const isOpen = hasActive;

  const nameHtml = landing
    ? `<a href="/?task=${escapeHtml(landing.id)}" class="tc-team__name"
        hx-get="/workspace/task/${escapeHtml(landing.id)}" hx-target="#mc-main" hx-swap="innerHTML" hx-push-url="/?task=${escapeHtml(landing.id)}"
        style="color:inherit;text-decoration:none;">${escapeHtml(team.name)}</a>`
    : `<span class="tc-team__name">${escapeHtml(team.name)}</span>`;

  // Recent tasks only — the full history lives on /tasks. The active task is
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
        ${team.icon
          ? `<span class="mc-sidebar__item-icon">${entityIcon(team.icon, team.icon_color, { size: 15 })}</span>`
          : `<span class="tc-team__dot${hasRunning ? " tc-team__dot--running" : ""}"></span>`}
        ${nameHtml}
        ${attention > 0 ? `<span class="tc-team__count" title="Needs your input">${attention}</span>` : ""}
        ${team.id ? `<a class="tc-team__add" href="/tasks/new?team=${escapeHtml(team.id)}"
          hx-get="/tasks/new?team=${escapeHtml(team.id)}" hx-target="#mc-main" hx-swap="innerHTML"
          hx-push-url="/tasks/new?team=${escapeHtml(team.id)}" onclick="event.stopPropagation();"
          title="New task for this team" aria-label="New task for this team">+</a>` : ""}
      </div>
    </summary>
    <div class="tc-team__tasks">${taskRows}</div>
  </details>`;
}

// A blank title means the daemon is still generating one; show a shimmer
// placeholder until it lands. updateTitle emits task:state_changed, which
// re-renders this row with the real title, so no client polling is needed.
function sidebarTitle(title: string): string {
  if (title && title.trim()) return `<span class="mc-sidebar__item-title">${escapeHtml(title)}</span>`;
  return `<span class="mc-sidebar__item-title tc-title-skel" title="Generating title..." aria-label="Generating title"><span class="tc-title-skel__bar"></span></span>`;
}

function sidebarItem(t: TaskSummary, activeId: string | null): string {
  const isActive = t.id === activeId;
  const display = displayStatusOf(t);
  const isRunning = display === "working";
  // A chosen icon replaces the status dot; the tint comes from the task's color.
  const lead = t.icon
    ? `<span class="mc-sidebar__item-icon">${entityIcon(t.icon, t.icon_color, { size: 15 })}</span>`
    : `<span class="mc-sidebar__item-dot mc-sidebar__item-dot--${displayDotClass(display, t.result_has_error)}"></span>`;
  return `<a href="/?task=${escapeHtml(t.id)}"
      class="mc-sidebar__item${isActive ? " mc-sidebar__item--active" : ""}${isRunning ? " mc-sidebar__item--running" : ""}"
      hx-get="/workspace/task/${escapeHtml(t.id)}" hx-target="#mc-main" hx-swap="innerHTML" hx-push-url="/?task=${escapeHtml(t.id)}">
    ${lead}
    ${sidebarTitle(t.title)}
    ${t.has_attention ? '<span class="mc-sidebar__item-attention" title="Needs your input (escalation or review)"></span>' : ""}
    ${modeChip(t.mode, { compact: true })}
    ${starButtonFragment(t.id, t.starred, "task")}
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
          <span class="mc-sidebar__item-dot mc-sidebar__item-dot--${displayDotClass(displayStatusOf(t), t.result_has_error)}"></span>
          <span class="mc-landing__task-title">${escapeHtml(t.title)}</span>
          ${statusChip(displayStatusOf(t), t.result_has_error)}
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
  // Draft tasks: show edit form
  if (task.status === "draft") {
    return renderDraftEdit(task, vm.teams);
  }
  // One view for both modes: autopilot on/off must not swap the chrome.
  return taskMainContent(vm, task);
}

export function renderDraftEdit(task: TaskSummary, _teams?: Array<{ id: string; name: string }>): string {
  void _teams; // team select is rendered via the shared slot endpoint
  const eid = escapeHtml(task.id);
  const slotQuery = new URLSearchParams({
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
      <span class="mc-task-header__identity">
        ${task.icon ? `<span class="mc-task-header__icon">${entityIcon(task.icon, task.icon_color, { size: 18 })}</span>` : ""}
        ${headerTitle(task.title)}
        ${starButtonFragment(task.id, task.starred, "task")}
      </span>
      <span class="sk-badge sk-badge--draft">draft</span>
      <div class="mc-task-header__actions">
        ${renderAutopilotToggle(task)}
        ${renderMemoryToggle(task)}
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
              <details class="sk-collapse-field"${task.icon ? " open" : ""}>
                <summary class="sk-label" style="cursor:pointer;list-style:none;">
                  <span class="sk-collapse-field__caret">&#x25B6;</span> Icon
                  <span style="font-weight:normal;font-size:0.72rem;color:var(--muted);">(optional)</span>
                </summary>
                <div style="margin-top:var(--sk-space-2);">${iconIdentityPicker({ icon: task.icon, color: task.icon_color, nameIcon: "icon", nameColor: "iconColor" })}</div>
              </details>
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
    ${iconIdentityPickerScript()}
  `;
}

/**
 * Composer + record controls shared by every non-draft task view. Text posts to
 * the unified input endpoint (daemon.inputTask); audio uses the realtime
 * recording pipeline, which works for any active task. On a settled task the
 * text composer stays live (posting input revives the task); recording needs an
 * active task, so the record button is disabled until input revives it.
 */
export function renderTaskComposer(taskId: string, opts: { settled?: boolean } = {}): string {
  const eid = escapeHtml(taskId);
  const settled = opts.settled === true;
  const placeholder = settled ? "Send input to continue this task..." : "Type a message or instruction...";
  const recordBtn = settled
    ? `<button id="btn-start-recording" class="sk-btn sk-btn--sm" disabled
          title="Recording needs a live task. Send a text message first; input revives this task."
          style="display:inline-flex;align-items:center;gap:0.35rem;opacity:0.5;cursor:not-allowed;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
          Record
        </button>`
    : `<button id="btn-start-recording" onclick="startRealtimeAudio('${eid}', 60, 5)" class="sk-btn sk-btn--sm" title="Start audio recording (auto-starts whisper)" style="display:inline-flex;align-items:center;gap:0.35rem;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
          Record
        </button>`;
  return `
    <div class="mc-rt-composer">
      <form hx-post="/api/tasks/${eid}/input" hx-swap="none"
            hx-on::after-request="if(event.detail.successful){this.querySelector('input[name=text]').value='';}" class="mc-rt-composer__form">
        <input type="text" name="text" placeholder="${placeholder}" required autocomplete="off" class="mc-rt-composer__input" />
        <button type="submit" class="sk-btn sk-btn--sm sk-btn--primary">Send</button>
      </form>
      <div id="rt-audio-controls" class="mc-rt-composer__audio">
        ${recordBtn}
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
  const display = displayStatusOf(task);
  const isActive = task.status === "active";
  const isWorking = display === "working";
  const needsReview = mission?.needsReview ?? false;
  const phaseStepper = mission && mission.phases.length > 0 ? renderPhaseStepper(mission.phases, task.id, isWorking) : "";
  const actions = renderActions(task, needsReview);

  const showResult = (task.status === "settled" || display === "idle") && task.result_summary;
  const resultHtml = showResult ? `
    <div class="sk-panel"><div class="sk-panel__body" style="padding: var(--sk-space-3) var(--sk-space-4); color: var(--sk-text-muted); font-size: var(--sk-text-sm);">${escapeHtml(task.result_summary!)}</div></div>
  ` : "";
  const reviewGate = needsReview ? renderReviewBanner(task) : "";
  const attention = reviewGate || resultHtml
    ? `<div class="mc-attention-slot">${reviewGate}${resultHtml}</div>` : "";

  return `
    <!-- Task header: full width above timeline + rail -->
    <div class="mc-task-header mc-task-header--with-phases${isWorking ? " mc-task-header--running" : ""}">
      <span class="mc-node__indicator mc-node__indicator--${displayIndicatorClass(display, task.result_has_error)}"></span>
      ${taskHeaderIdentity(task)}
      ${escalationHeaderSlot(task.id, task.open_escalation_count)}
      <div class="mc-task-header__scroll">
        ${phaseStepper ? `<div class="mc-task-header__phases">${phaseStepper}</div>` : ""}
        ${isActive ? `<div class="mc-task-header__orbs">
          <div id="mc-steer-${eid}"
            hx-get="/fragments/dashboard/latest-steer?task=${eid}"
            hx-trigger="load"
            hx-target="this"
            hx-swap="innerHTML"></div>
        </div>` : ""}
      </div>
      <div class="mc-task-header__actions">
        <button type="button" class="sk-btn sk-btn--sm" onclick="Skipper.modal.open('tc-details-modal')"
          hx-get="/workspace/task/${eid}/details" hx-target="#tc-details-modal-body" hx-swap="innerHTML">Details</button>
        ${actions}
      </div>
    </div>

    <!-- Composer (text + audio): the unified input, available on every active
         task and every settled task. Input wakes an idle task, answers a review
         gate, accumulates while agents are busy, or revives a settled task. -->
    ${isActive ? renderTaskComposer(task.id) : task.status === "settled" ? renderTaskComposer(task.id, { settled: true }) : ""}

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
          <div id="mc-activity-poke-${eid}" data-sk-activity-poke="${eid}" hidden></div>
          <div class="mc-activity__feed" id="mc-activity-feed-${eid}" data-activity-filter="messages" data-sk-activity-feed="${eid}"
            hx-get="/workspace/task/${eid}/activity" hx-trigger="load" hx-swap="innerHTML"><span class="sk-muted">Loading...</span></div>
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

/**
 * Quiet autopilot pill for the task header. Reflects task.mode (workflow =
 * autopilot on); clicking posts the flipped value to /api/tasks/:id/autopilot,
 * which HX-redirects back to the task view. Rendered on draft + active tasks
 * only (the route rejects settled tasks).
 */
function renderAutopilotToggle(task: Pick<TaskSummary, "id" | "mode">): string {
  const eid = escapeHtml(task.id);
  const on = task.mode !== "conversational";
  const title = on
    ? "Autopilot on: the team drives the task to the end of its phases. Click to switch to manual."
    : "Autopilot off: the task waits for your input between turns. Click to switch to autopilot.";
  return `<button type="button" class="tc-autopilot${on ? " tc-autopilot--on" : ""}"
      hx-post="/api/tasks/${eid}/autopilot" hx-vals='{"on":"${on ? "false" : "true"}"}' hx-swap="none"
      title="${title}" aria-pressed="${on}">
    <span class="tc-autopilot__dot"></span>Autopilot</button>`;
}

/**
 * Memory pill beside the autopilot one (experimental). Reflects
 * task_config.memory_enabled; clicking posts the flipped value to
 * /api/tasks/:id/memory, which backfills on enable and HX-redirects back.
 */
function renderMemoryToggle(task: Pick<TaskSummary, "id" | "memory_enabled" | "memory_mode" | "source_scheduled_task_id">): string {
  if (!isExperimental()) return "";
  const eid = escapeHtml(task.id);
  const on = task.memory_enabled;
  if (task.source_scheduled_task_id) {
    // A run's memory is decided by its recurring task; the pill links there.
    const shared = task.memory_mode === "shared";
    const label = shared ? "Shared memory" : "Memory";
    const title = on
      ? (shared ? "Memory shared across every run of this recurring task. Set on the recurring task." : "Memory on for this run. Set on the recurring task.")
      : "Memory off. Set on the recurring task.";
    return `<a class="tc-autopilot${on ? " tc-autopilot--on" : ""}" href="/?scheduled=${escapeHtml(task.source_scheduled_task_id)}" title="${title}" style="text-decoration:none;">
      <span class="tc-autopilot__dot"></span>${label}</a>`;
  }
  const title = on
    ? "Memory on: input, messages, and notes are recorded for agents to query. Click to turn off."
    : "Memory off. Click to record input, messages, and notes for agents to query (existing entries are copied in).";
  return `<button type="button" class="tc-autopilot${on ? " tc-autopilot--on" : ""}"
      hx-post="/api/tasks/${eid}/memory" hx-vals='{"on":"${on ? "false" : "true"}"}' hx-swap="none"
      title="${title}" aria-pressed="${on}">
    <span class="tc-autopilot__dot"></span>Memory</button>`;
}

function renderActions(task: TaskSummary, needsReview?: boolean): string {
  const eid = escapeHtml(task.id);
  const btns: string[] = [];
  if (task.status === "draft") {
    btns.push(renderAutopilotToggle(task));
    btns.push(renderMemoryToggle(task));
    btns.push(`<button class="sk-btn sk-btn--primary sk-btn--sm" hx-post="/api/tasks/${eid}/approve" hx-swap="none">Approve</button>`);
    btns.push(`<button class="sk-btn sk-btn--danger sk-btn--sm" hx-delete="/api/tasks/${eid}" hx-swap="none" hx-confirm="Delete this draft?">Delete</button>`);
  } else if (task.status === "active") {
    btns.push(renderAutopilotToggle(task));
    btns.push(renderMemoryToggle(task));
    if (needsReview) {
      btns.push(`<button class="sk-btn sk-btn--primary sk-btn--sm" hx-post="/api/tasks/${eid}/approve-phase" hx-swap="none">Approve Phase</button>`);
    }
    if (displayStatusOf(task) === "queued") {
      btns.push(`<button class="sk-btn sk-btn--sm" hx-post="/api/tasks/${eid}/unapprove" hx-swap="none" title="Send the task back to draft (only before its first run starts).">Unapprove</button>`);
    }
    if (task.paused) {
      btns.push(`<button class="sk-btn sk-btn--primary sk-btn--sm" hx-post="/api/tasks/${eid}/resume" hx-swap="none" title="Respawn agents and continue from where the task was paused.">Resume</button>`);
    } else {
      btns.push(`<button class="sk-btn sk-btn--sm" hx-post="/api/tasks/${eid}/pause" hx-swap="none" hx-confirm="Pause this task? All its agents and their subprocesses will be stopped; you can resume later.">Pause</button>`);
    }
    btns.push(`<button class="sk-btn sk-btn--sm" hx-post="/api/tasks/${eid}/complete" hx-swap="none" hx-confirm="Mark this task complete? Any live agents will be stopped and the task moves to done." title="Finish this task now. Stops any live agents and marks it complete; sending input revives it.">Complete</button>`);
    btns.push(`<button class="sk-btn sk-btn--danger sk-btn--sm" hx-post="/api/tasks/${eid}/cancel" hx-swap="none" hx-confirm="Cancel this task? Any live agents will be stopped.">Cancel</button>`);
  } else if (task.status === "settled") {
    btns.push(`<button class="sk-btn sk-btn--primary sk-btn--sm" hx-post="/api/tasks/${eid}/resume" hx-swap="none" title="Reactivate this task and wake the agent from where it left off. Notes, artifacts, and checkpoints are intact.">Resume</button>`);
    btns.push(`<button class="sk-btn sk-btn--danger sk-btn--sm" hx-delete="/api/tasks/${eid}" hx-swap="none" hx-confirm="Delete this task and all its data?">Delete</button>`);
  }
  return btns.join("");
}

// Warning-tinted status pill matching the escalation card's badge slot.
const warnBadge = (label: string) =>
  `<span class="sk-badge" style="background: color-mix(in srgb, var(--sk-accent-warning) 22%, transparent); color: var(--sk-accent-warning);">${label}</span>`;

// Task-header label shown when the task has open escalation(s). Warning-tinted
// badge with an alert glyph; the escalation detail itself lives in the timeline.
// Rendered inside a stable-id slot that is ALWAYS present (empty at count 0) so
// ui-push can OOB-swap it live when an escalation is raised or resolved while the
// task is open — see ws/ui-push.ts pushV2TaskHeaderEscalation.
export function escalationHeaderSlot(taskId: string, count: number): string {
  const eid = escapeHtml(taskId);
  const inner = count > 0
    ? `<span class="mc-task-header__escalation sk-badge" title="Open escalation needs your input"
        style="background: color-mix(in srgb, var(--sk-accent-warning) 22%, transparent); color: var(--sk-accent-warning); display: inline-flex; align-items: center; gap: 4px;">
        <span aria-hidden="true" style="font-weight: 700;">&#9888;</span>${escapeHtml(count === 1 ? "1 escalation" : `${count} escalations`)}</span>`
    : "";
  return `<span id="mc-task-escalation-${eid}" class="mc-task-header__escalation-slot">${inner}</span>`;
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
 * Parse terminal output and return human-readable activity entries, one row
 * per input line, in the order given (the feed reads newest-first).
 *
 * A row carries only its summary and the output's id (`data-sk-activity-id`);
 * the raw frame is fetched on click from /workspace/activity/:id. Embedding the
 * frame in the markup meant a 100-row page could weigh 20 MB on a task with
 * big tool results — that was the "timeline takes forever to load" bug.
 *
 * The client filters kinds via CSS (msg / tool). Pages are small and the feed
 * lazy-loads older pages as the user scrolls (see the /activity route), so a
 * burst of tool rows no longer needs a per-kind budget: a filtered view simply
 * reveals the load-more sentinel sooner and pulls the next page.
 */
export function parseTerminalActivity(
  lines: Array<{ id?: number; stream: string; data: string; agent_name?: string; process_pid?: number | null; created_at?: string }>,
): string {
  if (lines.length === 0) return `<div class="mc-activity__empty">No activity yet</div>`;

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
      // Pre-line-storage rows can be a bare 32KB slice of a base64 payload
      // (no JSON, no whitespace); showing them as "messages" is pure noise.
      if (looksLikeBinaryJunk(data)) return "";
      summary = data.length > 200 ? data.slice(0, 200) + "..." : data;
      kind = classifyPlainTerminalLine(line.stream, data);
    }

    if (kind === "message") summary = stripThinking(summary);
    if (!summary) return "";

    const kindLabel = kind === "tool" ? "tool" : kind === "message" ? "msg" : "sys";
    const agentLabel = line.agent_name ? `<span class="mc-activity__agent">${escapeHtml(line.agent_name)}</span>` : "";
    const pidLabel = line.process_pid != null
      ? `<span class="mc-activity__pid" title="Process ID">PID ${line.process_pid}</span>`
      : "";

    return `<div class="mc-activity__item mc-activity__item--${kind}" data-activity-kind="${kind}"
        data-sk-activity-row
        data-sk-activity-id="${line.id ?? ""}"
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

/** A long run of non-whitespace (a base64 fragment) rather than readable output. */
function looksLikeBinaryJunk(data: string): boolean {
  return data.length > 1000 && !/\s/.test(data.slice(0, 400));
}

/**
 * Lazy-load sentinel appended below a full page of activity rows. When it
 * scrolls into view (`intersect once` — the feed is its own overflow
 * container, so `revealed` would never fire) it swaps itself for the next
 * older page, which ends in its own sentinel until a short page comes back.
 */
export function activityLoadMoreSentinel(taskId: string, beforeId: number): string {
  return `<div class="mc-activity__more" data-sk-activity-more
      hx-get="/workspace/task/${escapeHtml(taskId)}/activity?before=${beforeId}"
      hx-trigger="intersect once" hx-swap="outerHTML" hx-target="this">
      <span class="sk-muted">Loading older activity…</span>
    </div>`;
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
      ${headerTitle(st.title)}
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

      ${isExperimental() ? renderSeriesMemoryPanel(st) : ""}

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

/** Series memory fields shared by the draft edit form. */
function renderSeriesMemoryFields(st: ScheduledTaskSummary): string {
  const cfg = readSeriesMemoryConfig(st.task_config);
  const opt = (v: string, label: string) => `<option value="${v}"${cfg.mode === v ? " selected" : ""}>${label}</option>`;
  return `
            <div class="sk-form-row" style="gap:var(--sk-space-3);">
              <div class="sk-form-group" style="flex:1;">
                <label class="sk-label">Memory across runs</label>
                <select name="memoryMode" class="sk-select">
                  ${opt("off", "Off")}${opt("run", "Per run (each run its own memory)")}${opt("shared", "Shared across runs")}
                </select>
                <div class="sk-muted sk-text-xs" style="margin-top:var(--sk-space-1);">
                  Shared: every run can query what earlier runs recorded, and the memory outlives the runs themselves.
                </div>
              </div>
              <div class="sk-form-group" style="width:170px;">
                <label class="sk-label">Keep entries for (days)</label>
                <input type="number" name="memoryRetentionDays" class="sk-input" min="0" step="1" value="${cfg.retentionDays}" placeholder="0 = indefinitely">
              </div>
            </div>
            <div class="sk-muted sk-text-xs" style="margin:calc(-1 * var(--sk-space-2)) 0 var(--sk-space-3);">Keep entries for: shared memory only. Entries older than this are dropped when new ones are written. 0 keeps them indefinitely.</div>`;
}

/**
 * Memory panel on the approved recurring-task detail: the series mode
 * (off / per run / shared), retention, what is stored, and Clear memory.
 * Posts to /api/scheduled-tasks/:id/memory, which backfills every run when the
 * mode becomes shared. Memory is owned by the series, so it outlives the runs
 * that recurring-run retention deletes.
 */
function renderSeriesMemoryPanel(st: ScheduledTaskSummary): string {
  const eid = escapeHtml(st.id);
  const cfg = readSeriesMemoryConfig(st.task_config);
  const mem = st.memory_summary ?? null;
  const opt = (v: string, label: string) => `<option value="${v}"${cfg.mode === v ? " selected" : ""}>${label}</option>`;
  let summary = "";
  if (mem && (mem.entries > 0 || mem.deleted > 0)) {
    const model = mem.models.map((m) => m.replace(/^local:|^custom:/, "")).join(", ");
    summary = `<div class="sk-text-xs" style="margin-top:var(--sk-space-3);">
        Shared across ${mem.runs} run${mem.runs === 1 ? "" : "s"} &middot; ${mem.entries} entries, ${mem.vectors} vectors${mem.pending > 0 ? ` (${mem.pending} pending)` : ""}${mem.dims ? `, ${mem.dims} dims` : ""}${model ? ` &middot; ${escapeHtml(model)}` : ""}
        &middot; ${formatBytes(mem.total_bytes)} <span class="sk-muted">(text ${formatBytes(mem.content_bytes)}, vectors ${formatBytes(mem.vector_bytes)})</span>${mem.deleted > 0 ? ` &middot; ${mem.deleted} deleted by agents` : ""}
        ${mem.oldest_at ? `<div class="sk-muted" style="margin-top:2px;">${formatTimestamp(mem.oldest_at)} to ${formatTimestamp(mem.newest_at ?? mem.oldest_at)}</div>` : ""}
      </div>`;
  } else if (cfg.mode === "shared") {
    summary = `<div class="sk-muted sk-text-xs" style="margin-top:var(--sk-space-3);">No entries yet.</div>`;
  }
  return `
      <div class="sk-panel" style="margin-top:var(--sk-space-3);">
        <div class="sk-panel__header"><span class="sk-panel__title">Memory</span></div>
        <div class="sk-panel__body" style="padding:var(--sk-space-4);">
          <div class="sk-muted sk-text-sm" style="margin-bottom:var(--sk-space-2);">
            What runs of this task remember. <strong>Shared</strong> lets every run query what earlier runs recorded (entries carry their run and time); the memory belongs to this recurring task and stays when old runs are deleted. <strong>Per run</strong> gives each run its own memory. Agents read it with <code>query_task_memory</code>; they never write to it.
          </div>
          <form hx-post="/api/scheduled-tasks/${eid}/memory" hx-swap="none" style="display:flex;gap:var(--sk-space-3);align-items:flex-end;flex-wrap:wrap;">
            <div class="sk-form-group" style="flex:1;min-width:220px;margin:0;">
              <label class="sk-label">Memory across runs</label>
              <select name="mode" class="sk-select">${opt("off", "Off")}${opt("run", "Per run (each run its own memory)")}${opt("shared", "Shared across runs")}</select>
            </div>
            <div class="sk-form-group" style="width:170px;margin:0;">
              <label class="sk-label">Keep entries for (days)</label>
              <input type="number" name="retention_days" class="sk-input" min="0" step="1" value="${cfg.retentionDays}" placeholder="0 = indefinitely">
            </div>
            <button type="submit" class="sk-btn sk-btn--sm sk-btn--primary">Save</button>
            ${mem && (mem.entries > 0 || mem.deleted > 0) ? `<button type="button" class="sk-btn sk-btn--danger sk-btn--sm" hx-post="/api/scheduled-tasks/${eid}/memory/clear" hx-swap="none"
              hx-confirm="Delete every memory entry of this recurring task? Runs keep their notes and messages; only the memory copy is removed.">Clear memory</button>` : ""}
          </form>
          <div class="sk-muted sk-text-xs" style="margin-top:var(--sk-space-2);">Keep entries for: shared memory only. Entries older than this are dropped when new ones are written. 0 keeps them indefinitely.</div>
          ${summary}
        </div>
      </div>`;
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
      ${headerTitle(st.title)}
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
            ${isExperimental() ? renderSeriesMemoryFields(st) : ""}
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
    const hasError = taskResultHasError(r.result);
    const isSettled = r.status === "settled";
    const statusLabel = isSettled
      ? (hasError ? "failed" : "completed")
      : r.completed_at ? (hasError ? "error" : "done") : "running";
    const statusClass = hasError ? "sk-badge--failed"
      : (!isSettled && !r.completed_at) ? "sk-badge--running"
        : "sk-badge--completed";
    let duration = "-";
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
          <td><span class="sk-badge ${statusClass}" style="font-size:10px;padding:1px 5px;">${escapeHtml(statusLabel)}</span></td>
          <td>${duration}</td>
          <td class="sk-muted sk-text-xs">${resultSummary ? escapeHtml(resultSummary) : "-"}</td>
        </tr>`;
  }).join("")}
    </tbody>
  </table>`;
}
