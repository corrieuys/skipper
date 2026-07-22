// Server-rendered HTML components for real-time task pages
import { formatTimestamp } from "./formatTimestamp";
import { layout } from "./layout";
import type { DaemonStatus } from "./components";
import type { RealtimeConfig } from "../realtime/config";
import { escapeHtml } from "./atoms/escape-html";

export interface RunningAgentInstance {
  id: string;
  template_agent_id: string;
  agent_name: string;
  status: string;
  created_at: string;
}

export interface TaskNote {
  id: string;
  agent_id: string;
  agent_name: string | null;
  content: string;
  created_at: string;
}

export interface RealtimeTaskConfig {
  summarizer_agent_id?: string;
  assigned_agent_ids?: string[];
}

export interface RealtimeTaskData {
  id: string;
  title: string;
  description: string | null;
  team_id?: string | null;
  team_name?: string | null;
  status: string;
  task_type: string;
  task_config: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  segment_count?: number;
  session_active?: boolean;
}

export interface AvailableAgent {
  id: string;
  name: string;
  type: string;
  capabilities: string;
}

export interface TeamAssignedAgent {
  id: string;
  name: string;
  role: string | null;
}

export interface TimelineEntry {
  id: string;
  task_id: string;
  entry_type: string;
  content: string;
  source_segment_ids: string;
  fed_to_skipper: number;
  priority?: string;
  created_at: string;
}

export interface PipelineStatus {
  task_id: string;
  analyst_instance_id: string | null;
  analyst_session_id: string | null;
  analyst_status: string;
  action_instance_id: string | null;
  action_status: string;
  last_summary_version: number;
  last_analyst_fed_version: number;
  queued_summary_versions: string;
  cadence_timer_active: number;
  updated_at: string;
  total_segments?: number;
  pending_transcription?: number;
  failed_transcription?: number;
  pending_summarization?: number;
  timeline_entry_count?: number;
}

export function realtimeTasksPage(
  tasks: RealtimeTaskData[],
  errorMessage?: string,
  daemonStatus?: DaemonStatus,
): string {
  const activeTasks = tasks.filter((t) => t.status === "running");
  const stoppedTasks = tasks.filter((t) => t.status !== "running");

  return layout(
    "Real-Time Tasks",
    `<section class="hero-panel compact-hero">
      <div class="page-header page-header-stack">
        <div>
          <p class="eyebrow">Live Monitoring</p>
          <h1>Real-Time Tasks</h1>
          <p class="page-subtitle">Manage real-time monitoring tasks with continuous audio and text input.</p>
        </div>
        <div class="page-actions">
          <a href="/realtime/new" hx-get="/realtime/new" hx-target="body" hx-push-url="true" class="btn-sm">+ New Task</a>
        </div>
      </div>
    </section>
    ${errorMessage ? `<div class="card card-error"><p class="error">${escapeHtml(errorMessage)}</p></div>` : ""}
    <section class="card">
      <div class="section-heading">
        <div>
          <h2>Tasks</h2>
          <p class="muted">${activeTasks.length} active, ${stoppedTasks.length} stopped</p>
        </div>
      </div>
      ${tasks.length === 0
      ? `<div class="empty-state"><div class="empty-state-icon">&#128246;</div><p>No real-time tasks yet</p><p class="muted"><a href="/realtime/new" hx-get="/realtime/new" hx-target="body" hx-push-url="true">Create one</a> to get started</p></div>`
      : `<table class="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Title</th>
                <th>Segments</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${tasks.map((t) => realtimeTaskRow(t)).join("\n")}
            </tbody>
          </table>`}
    </section>`,
    "/tasks",
    daemonStatus,
  );
}

export function realtimeNewTaskPage(errorMessage?: string, daemonStatus?: DaemonStatus): string {
  return layout(
    "New Real-Time Task",
    `<a href="/tasks" hx-get="/tasks" hx-target="body" hx-push-url="true" class="back-link">&larr; Back to Tasks</a>
    <section class="hero-panel compact-hero">
      <p class="eyebrow">Live Monitoring</p>
      <h1>New Real-Time Task</h1>
      <p class="page-subtitle">Create a monitoring task that starts immediately and accepts continuous audio and text input.</p>
    </section>
    ${errorMessage ? `<div class="card card-error"><p class="error">${escapeHtml(errorMessage)}</p></div>` : ""}
    <div class="task-create-layout">
      <section class="card task-form-card">
        <div class="section-heading">
          <div>
            <h2>Task Details</h2>
            <p class="muted">The description tells Skipper what to monitor and when to act.</p>
          </div>
        </div>
        <form class="task-editor-form" hx-post="/api/realtime-tasks" hx-target="body" hx-swap="innerHTML">
          <div class="task-form-grid">
            <label class="task-form-span-2">
              <span>Title</span>
              <input type="text" name="title" required placeholder="e.g. Sprint planning monitor" />
            </label>
            <label class="task-form-span-2">
              <span>Description</span>
              <textarea name="description" rows="4" placeholder="What should be monitored? When should Skipper take action? What kinds of things are important to capture?"></textarea>
            </label>
          </div>
          <div class="form-actions">
            <a href="/" hx-get="/" hx-target="body" hx-push-url="true" class="ghost-link">Cancel</a>
            <button type="submit">Create &amp; Start</button>
          </div>
        </form>
      </section>
      <aside class="card task-create-aside">
        <h3>How It Works</h3>
        <ul class="compact-list">
          <li>The task starts immediately in an active session.</li>
          <li>Record audio or send text messages from the task detail page.</li>
          <li>Audio is transcribed, cleaned up, and added to the timeline.</li>
          <li>Skipper reviews the timeline periodically and acts based on the description you provide.</li>
          <li>Assign agents on the detail page to enable delegation.</li>
        </ul>
      </aside>
    </div>`,
    "/tasks",
    daemonStatus,
  );
}

function realtimeTaskRow(task: RealtimeTaskData): string {
  const isRunning = task.status === "running";
  const isSessionActive = isRunning && task.session_active !== false;
  const isPaused = isRunning && task.session_active === false;
  const isArchived = task.status === "completed";
  const isFailed = task.status === "failed";

  let statusClass: string;
  let statusLabel: string;
  if (isSessionActive) {
    statusClass = "running";
    statusLabel = "active";
  } else if (task.status === "approved") {
    statusClass = "approved";
    statusLabel = "approved";
  } else if (isPaused) {
    statusClass = "paused";
    statusLabel = "paused";
  } else if (isArchived) {
    statusClass = "completed";
    statusLabel = "archived";
  } else if (isFailed) {
    statusClass = "failed";
    statusLabel = "failed";
  } else {
    statusClass = "stopped";
    statusLabel = "stopped";
  }

  const eid = escapeHtml(task.id);
  const menuItems: string[] = [];

  if (isSessionActive) {
    menuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/stop" hx-target="body" hx-swap="innerHTML">Pause</button>`,
    );
    menuItems.push(`<div class="action-divider"></div>`);
    menuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/close" hx-target="body" hx-swap="innerHTML" hx-confirm="Archive this task? This will permanently stop the session." class="action-danger">Archive</button>`,
    );
  } else if (isPaused) {
    menuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/resume" hx-target="body" hx-swap="innerHTML">Resume</button>`,
    );
    menuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/close" hx-target="body" hx-swap="innerHTML" hx-confirm="Archive this task? This will permanently stop the session." class="action-danger">Archive</button>`,
    );
    menuItems.push(`<div class="action-divider"></div>`);
    menuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task and all its data?" class="action-danger">Delete</button>`,
    );
  } else if (task.status === "approved") {
    menuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/start" hx-target="body" hx-swap="innerHTML">Start</button>`,
    );
    menuItems.push(`<div class="action-divider"></div>`);
    menuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task and all its data?" class="action-danger">Delete</button>`,
    );
  }

  if (isArchived) {
    menuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/unarchive" hx-target="body" hx-swap="innerHTML">Unarchive</button>`,
    );
    menuItems.push(`<div class="action-divider"></div>`);
    menuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task and all its data?" class="action-danger">Delete</button>`,
    );
  }

  if (isFailed) {
    menuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/unarchive" hx-target="body" hx-swap="innerHTML">Reopen</button>`,
    );
    menuItems.push(`<div class="action-divider"></div>`);
    menuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task and all its data?" class="action-danger">Delete</button>`,
    );
  }

  const actionsHtml = menuItems.length > 0
    ? `<div class="action-dropdown" tabindex="0"><button type="button" class="action-dropdown-toggle">Actions</button><div class="action-dropdown-menu">${menuItems.join("")}</div></div>`
    : "";

  return `<tr class="task-row">
    <td><span class="badge badge-${statusClass}">${statusLabel}</span></td>
    <td>
      <div class="task-row-title">
        <a href="/realtime/${eid}" hx-get="/realtime/${eid}" hx-target="body" hx-push-url="true">${escapeHtml(task.title)}</a>
        ${task.description ? `<p class="muted task-row-description">${escapeHtml(task.description.length > 88 ? task.description.slice(0, 88) + "..." : task.description)}</p>` : ""}
      </div>
    </td>
    <td>${task.segment_count ?? 0}</td>
    <td>${formatTimestamp(task.created_at)}</td>
    <td><div class="table-actions">${actionsHtml}</div></td>
  </tr>`;
}

export function realtimeTaskDetailPage(
  task: RealtimeTaskData,
  timeline: TimelineEntry[],
  pipelineStatus: PipelineStatus | null,
  config: RealtimeConfig,
  isSessionActive: boolean,
  runningAgents?: RunningAgentInstance[],
  notes?: TaskNote[],
  availableAgents?: AvailableAgent[],
  teamAgents?: TeamAssignedAgent[],
  daemonStatus?: DaemonStatus,
): string {
  const isRunning = task.status === "running";
  const isPaused = isRunning && !isSessionActive;
  const isArchived = task.status === "completed";

  let statusClass: string;
  let statusLabel: string;
  if (isRunning && isSessionActive) {
    statusClass = "running";
    statusLabel = "Active";
  } else if (task.status === "draft") {
    statusClass = "default";
    statusLabel = "Draft";
  } else if (task.status === "approved") {
    statusClass = "approved";
    statusLabel = "Approved";
  } else if (isPaused) {
    statusClass = "paused";
    statusLabel = "Paused";
  } else if (isArchived) {
    statusClass = "completed";
    statusLabel = "Archived";
  } else {
    statusClass = "stopped";
    statusLabel = "Stopped";
  }

  const eid = escapeHtml(task.id);
  const isFailed = task.status === "failed";
  const detailMenuItems: string[] = [];
  if (isRunning && isSessionActive) {
    detailMenuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/stop" hx-target="body" hx-swap="innerHTML">Pause</button>`,
    );
    detailMenuItems.push(`<div class="action-divider"></div>`);
    detailMenuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/close" hx-target="body" hx-swap="innerHTML" hx-confirm="Archive this task? This will permanently stop the session." class="action-danger">Archive</button>`,
    );
  } else if (isPaused) {
    detailMenuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/resume" hx-target="body" hx-swap="innerHTML">Resume</button>`,
    );
    detailMenuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/close" hx-target="body" hx-swap="innerHTML" hx-confirm="Archive this task? This will permanently stop the session." class="action-danger">Archive</button>`,
    );
    detailMenuItems.push(`<div class="action-divider"></div>`);
    detailMenuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task and all its data?" class="action-danger">Delete</button>`,
    );
  } else if (task.status === "approved") {
    detailMenuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/start" hx-target="body" hx-swap="innerHTML">Start</button>`,
    );
    detailMenuItems.push(`<div class="action-divider"></div>`);
    detailMenuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task and all its data?" class="action-danger">Delete</button>`,
    );
  } else if (isArchived) {
    detailMenuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/unarchive" hx-target="body" hx-swap="innerHTML">Unarchive</button>`,
    );
    detailMenuItems.push(`<div class="action-divider"></div>`);
    detailMenuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task and all its data?" class="action-danger">Delete</button>`,
    );
  } else if (isFailed) {
    detailMenuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/unarchive" hx-target="body" hx-swap="innerHTML">Reopen</button>`,
    );
    detailMenuItems.push(`<div class="action-divider"></div>`);
    detailMenuItems.push(
      `<button hx-post="/api/realtime-tasks/${eid}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task and all its data?" class="action-danger">Delete</button>`,
    );
  }
  const actionDropdownHtml = detailMenuItems.length > 0
    ? `<div class="action-dropdown" tabindex="0"><button type="button" class="action-dropdown-toggle">Actions</button><div class="action-dropdown-menu">${detailMenuItems.join("")}</div></div>`
    : "";
  const visibleActionButtons: string[] = [];
  if (isRunning && isSessionActive) {
    visibleActionButtons.push(`<button class="btn-sm" hx-post="/api/realtime-tasks/${eid}/stop" hx-target="body" hx-swap="innerHTML">Pause</button>`);
    visibleActionButtons.push(`<button class="btn-sm btn-danger" hx-post="/api/realtime-tasks/${eid}/close" hx-target="body" hx-swap="innerHTML" hx-confirm="Archive this task? This will permanently stop the session.">Archive</button>`);
  } else if (task.status === "draft") {
    visibleActionButtons.push(`<button class="btn-sm" hx-post="/api/tasks/${eid}/approve" hx-target="body" hx-swap="innerHTML">Accept</button>`);
    visibleActionButtons.push(`<button class="btn-sm btn-danger" hx-post="/api/tasks/${eid}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task and all its data?">Delete</button>`);
  } else if (isPaused) {
    visibleActionButtons.push(`<button class="btn-sm" hx-post="/api/realtime-tasks/${eid}/resume" hx-target="body" hx-swap="innerHTML">Resume</button>`);
    visibleActionButtons.push(`<button class="btn-sm btn-danger" hx-post="/api/realtime-tasks/${eid}/close" hx-target="body" hx-swap="innerHTML" hx-confirm="Archive this task? This will permanently stop the session.">Archive</button>`);
    visibleActionButtons.push(`<button class="btn-sm btn-danger" hx-post="/api/realtime-tasks/${eid}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task and all its data?">Delete</button>`);
  } else if (task.status === "approved") {
    visibleActionButtons.push(`<button class="btn-sm" hx-post="/api/realtime-tasks/${eid}/start" hx-target="body" hx-swap="innerHTML">Accept & Start</button>`);
    visibleActionButtons.push(`<button class="btn-sm btn-danger" hx-post="/api/realtime-tasks/${eid}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task and all its data?">Delete</button>`);
  } else if (isArchived) {
    visibleActionButtons.push(`<button class="btn-sm" hx-post="/api/realtime-tasks/${eid}/unarchive" hx-target="body" hx-swap="innerHTML">Unarchive</button>`);
    visibleActionButtons.push(`<button class="btn-sm btn-danger" hx-post="/api/realtime-tasks/${eid}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task and all its data?">Delete</button>`);
  } else if (isFailed) {
    visibleActionButtons.push(`<button class="btn-sm" hx-post="/api/realtime-tasks/${eid}/unarchive" hx-target="body" hx-swap="innerHTML">Reopen</button>`);
    visibleActionButtons.push(`<button class="btn-sm btn-danger" hx-post="/api/realtime-tasks/${eid}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task and all its data?">Delete</button>`);
  }
  const startNowButtonHtml = task.status === "approved"
    ? `<button class="btn-sm" hx-post="/api/realtime-tasks/${eid}/start" hx-target="body" hx-swap="innerHTML">Start Session</button>`
    : "";

  const allAgents = runningAgents ?? [];
  const activeAgentCount = allAgents.filter((a) => a.status === "running" || a.status === "pending").length;
  const operationsPanelHtml = realtimeOperationsPanel(
    task,
    pipelineStatus,
    teamAgents ?? [],
    availableAgents ?? [],
    allAgents,
    config,
  );

  return layout(
    task.title,
    `<style>
      .rt-page { display: flex; flex-direction: column; gap: 1rem; }

      .rt-status-bar {
        display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(300px, 0.9fr); gap: 1rem;
        padding: 1rem 1.1rem;
        background: var(--surface-high);
      }
      .rt-status-main {
        display: flex; align-items: flex-start; gap: 0.9rem; min-width: 0;
      }
      .rt-status-bar .rt-pulse { width: 10px; height: 10px; flex-shrink: 0; margin-top: 0.45rem; }
      .rt-pulse-active {
        background: var(--tertiary);
        box-shadow: 0 0 6px var(--tertiary), 0 0 12px rgba(176,255,150,0.3);
        animation: rt-pulse-glow 1.5s ease-in-out infinite;
      }
      .rt-pulse-paused { background: var(--secondary); opacity: 0.7; }
      .rt-pulse-stopped { background: var(--muted); opacity: 0.5; }
      @keyframes rt-pulse-glow {
        0%,100% { box-shadow: 0 0 4px var(--tertiary), 0 0 8px rgba(176,255,150,0.2); }
        50% { box-shadow: 0 0 8px var(--tertiary), 0 0 20px rgba(176,255,150,0.3); }
      }
      .rt-status-info { flex: 1; min-width: 0; }
      .rt-status-title { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
      .rt-status-title strong { font-size: 1.35rem; line-height: 1.15; }
      .rt-status-desc { font-size: 0.88rem; margin-top: 0.3rem; max-width: 72ch; }
      .rt-status-meta { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.75rem; }
      .rt-meta-chip {
        display: inline-flex; align-items: center; padding: 0.35rem 0.55rem;
        border: 1px solid var(--outline-variant); background: rgba(255,255,255,0.02);
        font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted);
      }
      .rt-status-side {
        display: flex; flex-direction: column; gap: 0.85rem; min-width: 0;
        border-left: 1px solid var(--ghost-border); padding-left: 1rem;
      }
      .rt-status-side-head {
        display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
      }
      .rt-status-side-label {
        font-size: 0.74rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;
      }
      .rt-status-actions {
        display: flex; gap: 0.5rem; align-items: center; justify-content: flex-end; flex-wrap: wrap;
      }
      .rt-hero-stats {
        display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.5rem;
      }
      .rt-hero-stat {
        padding: 0.65rem 0.75rem; background: var(--surface-bright); border: 1px solid var(--ghost-border);
      }
      .rt-hero-stat-label {
        font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;
      }
      .rt-hero-stat-value {
        margin-top: 0.2rem; font-size: 1rem; font-weight: 700; color: var(--text);
      }
      .rt-hero-stat-value-danger { color: var(--danger, #e55); }

      .rt-edit-toggle {
        background: none; border: none; color: var(--muted); cursor: pointer;
        font-size: 0.8rem; padding: 0.25rem 0.5rem; transition: color 0.15s;
      }
      .rt-edit-toggle:hover { color: var(--text); }
      .rt-edit-panel { display: none; }
      .rt-edit-panel.open { display: block; }

      .rt-grid { display: grid; grid-template-columns: 1fr 320px; gap: 1rem; }
      @media (max-width: 900px) { .rt-grid { grid-template-columns: 1fr; } }
      .rt-main { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
      .rt-sidebar { display: flex; flex-direction: column; gap: 1rem; }
      .rt-secondary-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1rem; }

      .rt-timeline-scroll {
        max-height: 500px; overflow-y: auto; overflow-x: hidden;
        scrollbar-width: thin; scrollbar-color: rgba(173,170,170,0.2) transparent;
      }
      .rt-timeline-scroll::-webkit-scrollbar { width: 5px; }
      .rt-timeline-scroll::-webkit-scrollbar-track { background: transparent; }
      .rt-timeline-scroll::-webkit-scrollbar-thumb { background: rgba(173,170,170,0.2); }

      .rt-timeline-entry {
        padding: 0.75rem; background: var(--surface-bright);
        border-left: 2px solid var(--outline-variant);
      }
      .rt-timeline-entry-header {
        display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;
      }
      .rt-timeline-entry-body {
        white-space: pre-wrap; font-size: 0.88rem; line-height: 1.5; color: var(--text);
      }
      .rt-timeline-entry-meta { font-size: 0.75rem; }
      .rt-timeline-entry[data-type="summary"] { border-left-color: var(--secondary); }
      .rt-timeline-entry[data-type="error"] { border-left-color: var(--danger, #e55); }

      .rt-notes-scroll, .rt-artifacts-scroll {
        max-height: 400px; overflow-y: auto;
        scrollbar-width: thin; scrollbar-color: rgba(173,170,170,0.2) transparent;
      }
      .rt-notes-scroll::-webkit-scrollbar, .rt-artifacts-scroll::-webkit-scrollbar { width: 5px; }
      .rt-notes-scroll::-webkit-scrollbar-track, .rt-artifacts-scroll::-webkit-scrollbar-track { background: transparent; }
      .rt-notes-scroll::-webkit-scrollbar-thumb, .rt-artifacts-scroll::-webkit-scrollbar-thumb { background: rgba(173,170,170,0.2); }

      /* note styles inherited from shared .note-item in base CSS */

      .rt-agent-item {
        display: flex; justify-content: space-between; align-items: center;
        padding: 0.5rem 0.65rem; background: var(--surface-bright);
        font-size: 0.85rem; transition: box-shadow 0.3s;
      }
      .rt-agent-item-running {
        box-shadow: inset 0 0 0 1px rgba(0,251,251,0.2);
        animation: rt-agent-border-pulse 2s ease-in-out infinite;
      }
      @keyframes rt-agent-border-pulse {
        0%,100% { box-shadow: inset 0 0 0 1px rgba(0,251,251,0.12); }
        50% { box-shadow: inset 0 0 0 1px rgba(0,251,251,0.3); }
      }
      .rt-agent-running-dot {
        width: 6px; height: 6px; background: var(--secondary);
        display: inline-block; margin-right: 6px;
        animation: rt-agent-dot-blink 1s ease-in-out infinite;
      }
      @keyframes rt-agent-dot-blink {
        0%,100% { opacity: 1; }
        50% { opacity: 0.3; }
      }

      .rt-pipeline-row {
        display: flex; justify-content: space-between; font-size: 0.85rem;
      }
      .rt-pipeline-divider {
        height: 1px; background: var(--ghost-border); margin: 0.5rem 0;
      }
      .rt-composer-card {
        padding: 0.95rem 1.05rem;
        background: var(--surface-high);
        margin-bottom: 0.75rem;
        overflow: hidden;
      }
      .rt-composer-wrap {
        display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.9rem; align-items: end;
      }
      .rt-composer-field { display: flex; flex-direction: column; gap: 0.45rem; }
      .rt-composer-label {
        font-size: 0.74rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;
      }
      .rt-composer-form { display: flex; gap: 0.6rem; align-items: flex-end; }
      .rt-composer-form input {
        flex: 1; padding: 0.75rem 0; border: none; border-bottom: 1px solid rgba(59,73,76,0.4);
        background: transparent; color: var(--text); outline: none;
      }
      .rt-composer-form button,
      .rt-composer-actions button { height: 1.75rem; }
      .rt-composer-actions {
        display: flex; gap: 0.5rem; align-items: center; justify-content: flex-end; flex-wrap: wrap;
      }
      .rt-panel-section { display: flex; flex-direction: column; gap: 0.65rem; }
      .rt-panel-section + .rt-panel-section {
        padding-top: 0.9rem; margin-top: 0.9rem; border-top: 1px solid var(--ghost-border);
      }
      .rt-panel-kicker {
        font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;
      }
      .rt-sidebar-note { font-size: 0.82rem; color: var(--muted); }

      @media (max-width: 1100px) {
        .rt-status-bar { grid-template-columns: 1fr; }
        .rt-status-side { border-left: none; border-top: 1px solid var(--ghost-border); padding-left: 0; padding-top: 0.9rem; }
      }
      @media (max-width: 780px) {
        .rt-secondary-grid { grid-template-columns: 1fr; }
        .rt-composer-wrap { grid-template-columns: 1fr; }
        .rt-composer-actions { justify-content: flex-start; }
        .rt-hero-stats { grid-template-columns: 1fr; }
      }
    </style>

    <div class="rt-page">
    <a href="/" hx-get="/" hx-target="body" hx-push-url="true" class="back-link">&larr; Back to Dashboard</a>

    <div class="rt-status-bar">
      <div class="rt-status-main">
        <div class="rt-pulse ${isRunning && isSessionActive ? "rt-pulse-active" : isPaused ? "rt-pulse-paused" : "rt-pulse-stopped"}"></div>
        <div class="rt-status-info">
          <div class="rt-status-title">
            <strong>${escapeHtml(task.title)}</strong>
            <span class="badge badge-${statusClass}">${statusLabel}</span>
          </div>
          ${task.description ? `<p class="muted rt-status-desc">${escapeHtml(task.description)}</p>` : ""}
          <div class="rt-status-meta">
            <span class="rt-meta-chip">${escapeHtml(task.team_name || "No team")}</span>
            <span class="rt-meta-chip">Created ${formatTimestamp(task.created_at)}</span>
            <span class="rt-meta-chip">${timeline.length} ${timeline.length === 1 ? "timeline entry" : "timeline entries"}</span>
            <span class="rt-meta-chip">${pipelineStatus?.total_segments ?? task.segment_count ?? 0} segments</span>
          </div>
        </div>
      </div>
      <div class="rt-status-side">
        <div class="rt-status-side-head">
          <span class="rt-status-side-label">Session Controls</span>
          <div class="rt-status-actions">
            <button class="rt-edit-toggle" onclick="document.getElementById('rt-edit-panel').classList.toggle('open')">Edit</button>
            ${startNowButtonHtml}
            ${actionDropdownHtml}
          </div>
        </div>
        <div class="rt-hero-stats">
          <div class="rt-hero-stat">
            <div class="rt-hero-stat-label">Live Session</div>
            <div class="rt-hero-stat-value">${isRunning && isSessionActive ? "Recording" : isPaused ? "Paused" : isArchived ? "Archived" : "Idle"}</div>
          </div>
          <div class="rt-hero-stat">
            <div class="rt-hero-stat-label">Agents</div>
            <div class="rt-hero-stat-value">${activeAgentCount}</div>
          </div>
          <div class="rt-hero-stat">
            <div class="rt-hero-stat-label">Failures</div>
            <div class="rt-hero-stat-value ${(pipelineStatus?.failed_transcription ?? 0) > 0 ? "rt-hero-stat-value-danger" : ""}">${pipelineStatus?.failed_transcription ?? 0}</div>
          </div>
        </div>
      </div>
    </div>

    <section id="rt-edit-panel" class="card rt-edit-panel">
      <form class="task-editor-form" hx-post="/api/realtime-tasks/${eid}" hx-target="body" hx-swap="innerHTML">
        <div class="task-form-grid">
          <label class="task-form-span-2">
            <span>Title</span>
            <input type="text" name="title" value="${escapeHtml(task.title)}" required />
          </label>
          <label class="task-form-span-2">
            <span>Description</span>
            <textarea name="description" rows="3" placeholder="Describe what to monitor and what should trigger action">${task.description ? escapeHtml(task.description) : ""}</textarea>
          </label>
        </div>
        <div class="form-actions">
          <button type="button" class="ghost-link" onclick="document.getElementById('rt-edit-panel').classList.remove('open')">Cancel</button>
          <button type="submit">Save Changes</button>
        </div>
      </form>
    </section>

    ${isRunning
      ? realtimeInputPanel(task, config, visibleActionButtons)
      : visibleActionButtons.length > 0 ? `<section class="card">
      <div class="section-heading">
        <div>
          <h2>Task Controls</h2>
          <p class="muted">Available task actions for this session state.</p>
        </div>
      </div>
      <div class="form-actions">${visibleActionButtons.join("")}</div>
    </section>` : ""}

    <div class="rt-grid">
      <div class="rt-main">
        ${realtimeTimelinePanel(task, timeline)}

        <div class="rt-secondary-grid">
          <section class="card">
            <div class="section-heading">
              <div>
                <h2>Notes</h2>
                <p class="muted">Agent observations and checkpoints.</p>
              </div>
            </div>
            <div class="rt-notes-scroll" id="rt-notes"
                 hx-get="/api/realtime-tasks/${escapeHtml(task.id)}/notes"
                 hx-trigger="load"
                 hx-target="#rt-notes"
                 hx-swap="innerHTML"
                 hx-on:htmx:response-error="event.detail.shouldSwap=false">
              ${notesFragmentHtml(notes ?? [])}
            </div>
          </section>

          <section class="card">
            <div class="section-heading">
              <div>
                <h2>Artifacts</h2>
                <p class="muted">Outputs, summaries, and snapshots.</p>
              </div>
            </div>
            <div class="rt-artifacts-scroll" id="artifact-list"
                 hx-get="/fragments/tasks/${escapeHtml(task.id)}/artifacts"
                 hx-trigger="load"
                 hx-target="#artifact-list"
                 hx-swap="innerHTML"
                 hx-on:htmx:response-error="event.detail.shouldSwap=false">
              <p class="muted">Loading...</p>
            </div>
            <!-- Opened artifact renders here, inside the panel (not full-screen). -->
            <div id="sk-artifact-detail" data-sk-artifact-detail style="display:none;margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid rgba(173,170,170,0.15);"></div>
          </section>
        </div>
      </div>

      <div class="rt-sidebar">
        ${operationsPanelHtml}
      </div>
    </div>

    <script>
      // Artifacts open INSIDE the Artifacts panel (#sk-artifact-detail), not a
      // full-screen modal. This page does not load skipper.js, so define the
      // opener the artifact list-item onclick expects locally. htmx performs the
      // fetch into #sk-artifact-detail; this just reveals + scrolls to it.
      window.skOpenArtifactPanel = function () {
        var d = document.getElementById('sk-artifact-detail');
        if (d) { d.style.display = 'block'; d.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      };
    </script>
    </div>

    ${isRunning && isSessionActive ? navigationProtectionScript(task.id) : ""}`,
    "/tasks",
    daemonStatus,
  );
}

function navigationProtectionScript(taskId: string): string {
  return `<script>
    (function() {
      window.__rtTaskActive = true;

      // 1. Protect actual browser tab close / URL bar navigation
      window.addEventListener('beforeunload', function(e) {
        if (window.__rtTaskActive) {
          e.preventDefault();
          e.returnValue = '';
        }
      });

      // 2. Protect HTMX client-side navigation (hx-get with hx-push-url)
      document.body.addEventListener('htmx:confirm', function(e) {
        if (!window.__rtTaskActive) return;

        var elt = e.detail.elt;
        // Only intercept navigations that change the URL, not polling/fragment fetches
        var isNavigation = elt.hasAttribute('hx-push-url') ||
                          (elt.closest && elt.closest('[hx-push-url]'));
        if (!isNavigation) return;

        // Don't block actions on this page (pause/resume/archive already have their own confirms)
        var href = elt.getAttribute('hx-get') || elt.getAttribute('hx-post') || '';
        if (href.includes('/api/realtime-tasks/')) return;
        if (href === '/realtime/${escapeHtml(taskId)}') return;

        e.preventDefault();
        if (confirm('A realtime session is recording. Leave this page?')) {
          e.detail.issueRequest(true);
        }
      });

      // 3. Also intercept clicks on regular <a> tags that HTMX hasn't processed
      document.addEventListener('click', function(e) {
        if (!window.__rtTaskActive) return;
        var link = e.target.closest && e.target.closest('a[href]');
        if (!link) return;
        // Only intercept links that would navigate away (not # or javascript:)
        var href = link.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
        if (href.includes('/realtime/${escapeHtml(taskId)}')) return;
        // HTMX links will be caught by htmx:confirm above, but as a fallback:
        if (!link.hasAttribute('hx-get') && !link.hasAttribute('hx-post')) {
          if (!confirm('A realtime session is recording. Leave this page?')) {
            e.preventDefault();
          }
        }
      });

      // Clear flag when page is about to swap (navigating away after confirmation)
      document.addEventListener('htmx:beforeSwap', function(e) {
        if (e.detail.target === document.body) {
          window.__rtTaskActive = false;
        }
      });

      // Disarm guard for intentional pause/resume/close — these return HX-Redirect
      // which triggers window.location change (and thus beforeunload) before htmx:beforeSwap fires
      document.body.addEventListener('htmx:beforeRequest', function(e) {
        var hxPost = e.detail.elt.getAttribute('hx-post') || '';
        if (/\/(stop|resume|close)$/.test(hxPost)) {
          window.__rtTaskActive = false;
        }
      });
    })();
  </script>`;
}

function realtimeInputPanel(task: RealtimeTaskData, config: RealtimeConfig, visibleActionButtons: string[]): string {
  return `<section class="rt-composer-card">
    <div class="section-heading">
      <div>
        <h2>Input</h2>
        <p class="muted">Keep the live session moving with text or streaming audio.</p>
      </div>
    </div>
    <div class="rt-composer-wrap">
      <div class="rt-composer-field">
        <span class="rt-composer-label">Message or cue</span>
        <form class="rt-composer-form" id="rt-text-input-form" data-task-id="${escapeHtml(task.id)}"
              hx-post="/api/realtime-tasks/${escapeHtml(task.id)}/input" hx-swap="none"
              hx-on::after-request="if(event.detail.successful){this.querySelector('input[name=text]').value='';}">
          <input type="text" name="text" placeholder="Type a message or instruction..." required autocomplete="off" />
          <button type="submit" class="btn-sm">Send</button>
        </form>
      </div>
      <div class="rt-composer-actions">
        ${visibleActionButtons.join("")}
        <div id="audio-controls" style="display:flex;gap:0.5rem;align-items:center;">
          <button id="btn-start-recording" class="btn-sm" onclick="startRealtimeAudio('${escapeHtml(task.id)}', ${config.cadence_seconds}, ${config.overlap_seconds})" style="gap:0.4rem;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
          Record
          </button>
          <button id="btn-stop-recording" onclick="stopRealtimeAudio()" class="btn-sm btn-danger" style="display:none;gap:0.4rem;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
          Stop
          </button>
          <span id="audio-status" class="muted"></span>
        </div>
      </div>
    </div>
    <div id="audio-visualizer-wrap" style="display:none;margin-top:0.5rem;overflow:hidden;background:var(--sk-surface-0);border:1px solid var(--sk-border-subtle);border-radius:var(--sk-radius);">
      <canvas id="audio-visualizer" width="600" height="80" style="width:100%;height:72px;display:block;"></canvas>
    </div>
    <script src="/realtime.js"></script>
    <script src="/realtime-audio.js"></script>
  </section>`;
}

function realtimeTimelinePanel(task: RealtimeTaskData, timeline: TimelineEntry[]): string {
  return `<section class="card">
    <div class="section-heading">
      <div>
        <h2>Timeline</h2>
        <p class="muted">${timeline.length} ${timeline.length === 1 ? "entry" : "entries"}</p>
      </div>
    </div>
    <div class="rt-timeline-scroll" id="timeline-entries" data-task-id="${escapeHtml(task.id)}">
      ${timeline.length === 0
      ? `<div class="empty-state"><p class="muted">No timeline entries yet</p></div>`
      : timelineEntriesHtml(timeline)}
    </div>
  </section>`;
}

function timelineEntriesHtml(timeline: TimelineEntry[]): string {
  return `<div style="display:flex;flex-direction:column;gap:0.5rem;">
    ${timeline.map((entry) => {
    const badgeClass = entry.entry_type === "error" ? "danger" : entry.entry_type === "summary" ? "info" : "default";
    const typeLabel = entry.entry_type.toUpperCase();
    const priorityBadge = entry.priority === "high"
      ? ` <span class="badge badge-warning" style="font-size:0.6rem;">HIGH</span>`
      : "";
    return `<div class="rt-timeline-entry" data-type="${escapeHtml(entry.entry_type)}">
        <div class="rt-timeline-entry-header">
          <span class="badge badge-${badgeClass}">${typeLabel}</span>${priorityBadge}
          <span class="muted rt-timeline-entry-meta">${formatTimestamp(entry.created_at)}</span>
        </div>
        <div class="rt-timeline-entry-body">${escapeHtml(entry.content)}</div>
        ${entry.fed_to_skipper ? `<span class="muted rt-timeline-entry-meta" style="margin-top:0.3rem;display:inline-block;">Fed to Skipper</span>` : ""}
      </div>`;
  }).join("\n")}
  </div>`;
}

export function timelineEntriesFragment(timeline: TimelineEntry[]): string {
  if (timeline.length === 0) {
    return `<div class="empty-state"><p class="muted">No timeline entries yet</p></div>`;
  }
  return timelineEntriesHtml(timeline);
}

function realtimeOperationsPanel(
  task: RealtimeTaskData,
  pipelineStatus: PipelineStatus | null,
  teamAgents: TeamAssignedAgent[],
  availableAgents: AvailableAgent[],
  agents: RunningAgentInstance[],
  config: RealtimeConfig,
): string {
  return `<section class="card">
    <div class="section-heading">
      <div>
        <h2>Operations</h2>
        <p class="muted">Assignments, activity, pipeline state, and runtime config.</p>
      </div>
    </div>
    <div class="rt-panel-section">
      <div class="rt-panel-kicker">Team Setup</div>
      ${teamAgentsSummaryContent(task, teamAgents, availableAgents)}
    </div>
    <div class="rt-panel-section">
      <div class="rt-panel-kicker">Agent Activity</div>
      <div id="rt-running-agents">
        ${agentsListHtml(agents)}
      </div>
    </div>
    <div class="rt-panel-section">
      <div class="rt-panel-kicker">Pipeline</div>
      ${pipelineSummaryContent(pipelineStatus)}
    </div>
    <div class="rt-panel-section">
      <div class="rt-panel-kicker">Config</div>
      ${configSummaryContent(config)}
    </div>
  </section>`;
}

function pipelineSummaryContent(pipelineStatus: PipelineStatus | null): string {
  if (!pipelineStatus) {
    return `<p class="rt-sidebar-note">No pipeline state yet.</p>`;
  }

  return `<div style="display:flex;flex-direction:column;gap:0.5rem;">
    <div class="rt-pipeline-row"><span>Segments</span><strong>${pipelineStatus.total_segments ?? 0}</strong></div>
    <div class="rt-pipeline-row"><span>Pending Transcription</span><strong>${pipelineStatus.pending_transcription ?? 0}</strong></div>
    ${(pipelineStatus.failed_transcription ?? 0) > 0 ? `<div class="rt-pipeline-row" style="color:var(--danger,#e55);"><span>Failed Transcription</span><strong>${pipelineStatus.failed_transcription}</strong></div>` : ""}
    <div class="rt-pipeline-row"><span>Pending Summarization</span><strong>${pipelineStatus.pending_summarization ?? 0}</strong></div>
    <div class="rt-pipeline-row"><span>Timeline Entries</span><strong>${pipelineStatus.timeline_entry_count ?? 0}</strong></div>
    <div class="rt-pipeline-divider"></div>
    <div class="rt-pipeline-row"><span>Cadence Timer</span><span class="badge badge-${pipelineStatus.cadence_timer_active ? "running" : "default"}">${pipelineStatus.cadence_timer_active ? "Active" : "Inactive"}</span></div>
    <div class="rt-pipeline-row"><span>Updated</span><span class="muted">${formatTimestamp(pipelineStatus.updated_at)}</span></div>
  </div>`;
}

function teamAgentsSummaryContent(
  task: RealtimeTaskData,
  teamAgents: TeamAssignedAgent[],
  availableAgents: AvailableAgent[],
): string {
  const taskConfig = parseTaskConfig(task);
  const assignedIds = taskConfig.assigned_agent_ids ?? [];
  const summarizerId = taskConfig.summarizer_agent_id?.trim() || "realtime-summarizer";
  const availableById = new Map(availableAgents.map((a) => [a.id, a]));
  const teamById = new Map(teamAgents.map((a) => [a.id, a]));
  const individualCandidates = [...assignedIds, summarizerId];
  const individualAgents = individualCandidates
    .filter((id, idx) => id && individualCandidates.indexOf(id) === idx)
    .map((id) => teamById.get(id)
      ? { id, name: teamById.get(id)!.name }
      : { id, name: availableById.get(id)?.name ?? id });

  return `<div style="display:flex;flex-direction:column;gap:0.8rem;">
    <div class="rt-pipeline-row"><span>Team</span><strong>${task.team_name ? escapeHtml(task.team_name) : "Unassigned"}</strong></div>
    <div>
      <div class="rt-sidebar-note">Team agents</div>
      ${teamAgents.length === 0
      ? `<p class="rt-sidebar-note">No team agents</p>`
      : `<div style="display:flex;flex-direction:column;gap:0.35rem;margin-top:0.35rem;">${teamAgents.map((a) => `<div class="rt-agent-item"><span>${escapeHtml(a.name)}</span><span class="muted" style="font-size:0.72rem;">${escapeHtml(a.id)}</span></div>`).join("")}</div>`}
    </div>
    <div>
      <div class="rt-sidebar-note">Task agents</div>
      ${individualAgents.length === 0
      ? `<p class="rt-sidebar-note">No individual agents selected</p>`
      : `<div style="display:flex;flex-direction:column;gap:0.35rem;margin-top:0.35rem;">${individualAgents.map((a) => `<div class="rt-agent-item"><span>${escapeHtml(a.name)}</span><span class="muted" style="font-size:0.72rem;">${escapeHtml(a.id)}</span></div>`).join("")}</div>`}
    </div>
  </div>`;
}

function parseTaskConfig(task: RealtimeTaskData): RealtimeTaskConfig {
  try {
    return JSON.parse(task.task_config || "{}") as RealtimeTaskConfig;
  } catch {
    return {};
  }
}

function agentAssignmentFormHtml(
  taskId: string,
  selectableAgents: AvailableAgent[],
  assignedIds: string[],
  summarizerId: string,
): string {
  return `<style>
      .rt-assign-form label.rt-field-label { display:block; margin-bottom:0.2rem; font-weight:600; font-size:0.75rem; letter-spacing:0.01em; color:var(--muted); }
      .rt-assign-form label.rt-agent-check {
        display:flex !important; align-items:center; gap:0.4rem;
        margin-bottom:0 !important; padding:0.35rem 0.5rem;
        border:1px solid var(--outline-variant); border-radius:0;
        font-size:0.82rem; cursor:pointer; transition:border-color 0.15s, background 0.15s;
      }
      .rt-assign-form label.rt-agent-check:hover { border-color:rgba(0,251,251,0.2); }
      .rt-assign-form label.rt-agent-check.checked { border-color:rgba(0,251,251,0.3); background:rgba(0,251,251,0.04); }
      .rt-assign-form label.rt-agent-check input[type="checkbox"] {
        display:inline-block !important; width:auto !important; margin:0 !important;
        flex-shrink:0; accent-color:var(--secondary);
      }
    </style>
    <form class="rt-assign-form" hx-post="/api/realtime-tasks/${escapeHtml(taskId)}/config"
               hx-target="#rt-agent-assignment" hx-swap="innerHTML"
               style="display:flex;flex-direction:column;gap:0.6rem;">
      <div>
        <label class="rt-field-label">Summarizer Agent</label>
        <select name="summarizer_agent_id">
          <option value="">None (basic concatenation)</option>
          ${selectableAgents.map(a =>
    `<option value="${escapeHtml(a.id)}"${a.id === summarizerId ? " selected" : ""}>${escapeHtml(a.name)} (${escapeHtml(a.type)})</option>`
  ).join("\n")}
        </select>
        <p class="muted" style="font-size:0.72rem;margin-top:0.15rem;">Processes and summarizes incoming segments.</p>
      </div>
      <div>
        <label class="rt-field-label">Delegation Agents</label>
        <div style="display:flex;flex-direction:column;gap:0.25rem;max-height:220px;overflow-y:auto;">
          ${selectableAgents.length === 0
      ? `<p class="muted" style="font-size:0.8rem;">No agents available. Create agents first.</p>`
      : selectableAgents.map(a => {
        const checked = assignedIds.includes(a.id);
        let caps: string[] = [];
        try { caps = JSON.parse(a.capabilities); } catch { }
        const capStr = caps.length > 0 ? caps.join(", ") : "";
        return `<label class="rt-agent-check${checked ? " checked" : ""}">
                <input type="checkbox" name="assigned_agent_ids" value="${escapeHtml(a.id)}"${checked ? " checked" : ""} />
                <strong>${escapeHtml(a.name)}</strong>${capStr ? `<span class="muted" style="font-size:0.75rem;">${escapeHtml(capStr)}</span>` : ""}
              </label>`;
      }).join("\n")}
        </div>
        <p class="muted" style="font-size:0.72rem;margin-top:0.15rem;">Skipper can delegate work to checked agents.</p>
      </div>
      <button type="submit" class="btn-sm" style="align-self:flex-end;">Save</button>
    </form>`;
}

export function agentAssignmentFragment(
  taskId: string,
  selectableAgents: AvailableAgent[],
  assignedIds: string[],
  summarizerId: string,
): string {
  return agentAssignmentFormHtml(taskId, selectableAgents, assignedIds, summarizerId);
}

function agentsListHtml(agents: RunningAgentInstance[]): string {
  if (agents.length === 0) {
    return `<div style="padding:0.75rem 0;text-align:center;">
      <p class="muted" style="font-size:0.85rem;">No agent activity yet</p>
    </div>`;
  }
  return `<div style="display:flex;flex-direction:column;gap:0.4rem;">
    ${agents.map((a) => {
    const isActive = a.status === "running" || a.status === "pending";
    const badgeClass = a.status === "running" ? "running" : a.status === "completed" ? "completed" : a.status === "pending" ? "paused" : "default";
    return `<div class="rt-agent-item ${isActive ? "rt-agent-item-running" : ""}">
        <div style="min-width:0;">
          <div style="display:flex;align-items:center;">
            ${isActive ? '<span class="rt-agent-running-dot"></span>' : ""}
            <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(a.agent_name)}</strong>
          </div>
          <span class="muted" style="font-size:0.75rem;">${escapeHtml(a.template_agent_id)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:0.4rem;flex-shrink:0;">
          <span class="badge badge-${badgeClass}" style="font-size:0.7rem;">${escapeHtml(a.status)}</span>
          <span class="muted" style="font-size:0.7rem;">${formatTimestamp(a.created_at)}</span>
        </div>
      </div>`;
  }).join("\n")}
  </div>`;
}

export function runningAgentsFragment(agents: RunningAgentInstance[]): string {
  return agentsListHtml(agents);
}

function notesFragmentHtml(notes: TaskNote[]): string {
  if (notes.length === 0) {
    return `<p class="muted" style="font-size:0.9rem;">No notes yet</p>`;
  }
  return `<div style="display:flex;flex-direction:column;gap:0.6rem;">
    ${notes.map((n) => `<div class="note-item">
      <div class="note-header">
        <span class="note-agent">${escapeHtml(n.agent_name ?? n.agent_id)}</span>
        <span class="note-time">${formatTimestamp(n.created_at)}</span>
      </div>
      <div class="note-body">${escapeHtml(n.content)}</div>
    </div>`).join("\n")}
  </div>`;
}

export function notesFragment(notes: TaskNote[]): string {
  return notesFragmentHtml(notes);
}

function configSummaryContent(config: RealtimeConfig): string {
  const providerLabel = config.transcription_provider === "openai" ? "OpenAI API" : "Local whisper";
  const providerDetail = config.transcription_provider === "openai"
    ? config.openai_transcription_model
    : (config.transcription_endpoint || "Not configured");
  return `<div style="display:flex;flex-direction:column;gap:0.5rem;">
    <div class="rt-pipeline-row"><span>Transcription</span><span class="muted">${providerLabel}</span></div>
    <div class="rt-pipeline-row"><span>${config.transcription_provider === "openai" ? "Model" : "Endpoint"}</span><span class="muted" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(providerDetail)}</span></div>
    <div class="rt-pipeline-row"><span>Cadence</span><span class="muted">${config.cadence_seconds}s</span></div>
    <div class="rt-pipeline-row"><span>Overlap</span><span class="muted">${config.overlap_seconds}s</span></div>
  </div>`;
}
