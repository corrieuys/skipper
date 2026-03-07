// Server-rendered HTML components for HTMX UI
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSkipperAgent, SKIPPER_AGENT_ID } from "../agents/skipper";
import type { SkipperConfig } from "../agents/skipper";

const SKIPPER_PROMPT_PATH = join(import.meta.dir, "../../prompts/skipper.md");

export function formatTimestamp(isoString: string): string {
  const date = parseTimestamp(isoString);
  if (isNaN(date.getTime())) return escapeHtml(isoString);

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const absDiffMs = Math.abs(diffMs);
  const diffSec = Math.floor(diffMs / 1000);
  const absDiffSec = Math.floor(absDiffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const absDiffMin = Math.floor(absDiffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const absDiffHr = Math.floor(absDiffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  const absDiffDay = Math.floor(absDiffHr / 24);

  let relative: string;
  if (Math.abs(diffSec) < 60) {
    relative = "just now";
  } else if (diffMs >= 0) {
    if (diffMin < 60) relative = `${diffMin}m ago`;
    else if (diffHr < 10) {
      const hours = diffHr;
      const minutes = diffMin % 60;
      relative = `${hours}h ${minutes}m ago`;
    } else if (diffHr < 24) relative = `${diffHr}h ago`;
    else if (diffDay < 30) relative = `${diffDay}d ago`;
    else relative = date.toLocaleDateString();
  } else {
    if (absDiffMin < 60) relative = `in ${absDiffMin}m`;
    else if (absDiffHr < 10) {
      const hours = absDiffHr;
      const minutes = absDiffMin % 60;
      relative = `in ${hours}h ${minutes}m`;
    } else if (absDiffHr < 24) relative = `in ${absDiffHr}h`;
    else if (absDiffDay < 30) relative = `in ${absDiffDay}d`;
    else relative = date.toLocaleDateString();
  }

  return `<span title="${escapeHtml(date.toLocaleString())}">${relative}</span>`;
}

function parseTimestamp(input: string): Date {
  // SQLite datetime('now') format is UTC but lacks timezone, e.g. "2026-02-20 17:04:16".
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(input)) {
    return new Date(input.replace(" ", "T") + "Z");
  }
  // Handle ISO-like values missing timezone as UTC for consistent server-generated timestamps.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(input)) {
    return new Date(input + "Z");
  }
  return new Date(input);
}

const navItems: { href: string; label: string }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/tasks", label: "Tasks" },
  { href: "/skipper", label: "Skipper" },
  { href: "/agents", label: "Agents" },
  { href: "/teams", label: "Teams" },
  { href: "/escalations", label: "Escalations" },
  { href: "/logs", label: "Logs" },
  { href: "/audit-events", label: "Events" },
  { href: "/help", label: "Help" },
];

export function layout(title: string, content: string, currentPath: string = "/"): string {
  const navLinksHtml = navItems
    .map((item) => {
      const isActive = item.href === "/" ? currentPath === "/" : currentPath.startsWith(item.href);
      return `<a href="${item.href}" hx-get="${item.href}" hx-target="body" hx-push-url="true"${isActive ? ' class="active"' : ""}>${item.label}</a>`;
    })
    .join("\n      ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Skipper</title>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <script src="https://unpkg.com/htmx-ext-sse@2.2.2/sse.js"></script>
  <style>${baseStyles()}</style>
</head>
<body>
  <nav class="navbar">
    <a href="/" class="brand">Skipper</a>
    <div class="nav-links">
      ${navLinksHtml}
    </div>
  </nav>
  <div class="htmx-indicator loading-bar"></div>
  <main class="container">${content}</main>
</body>
</html>`;
}

// --- Dashboard ---

export interface RecentLogEntry {
  agent_id: string;
  agent_name: string;
  stream: string;
  data: string;
  created_at: string;
}

export interface DashboardData {
  tasks: { id: string; title: string; status: string; priority: number }[];
  agents: { id: string; name: string; status: string; type: string; current_task_id: string | null }[];
  daemon: { state: "running" | "pausing" | "paused" | "stopped"; uptime: number };
  runningInstances?: {
    id: string;
    template_agent_id: string;
    template_agent_name: string;
    task_id: string;
    task_title: string | null;
    status: string;
    parent_instance_id: string | null;
    root_instance_id: string | null;
    created_at: string;
    updated_at: string;
  }[];
  activeDelegationGroups?: {
    id: string;
    task_id: string;
    parent_instance_id: string;
    settled_count: number;
    expected_count: number;
    failed_count: number;
    status: string;
    created_at: string;
  }[];
  recentLogs?: RecentLogEntry[];
}

export function dashboardActiveTaskFragment(tasks: { id: string; title: string; status: string; priority: number }[]): string {
  if (tasks.length === 0) {
    return `<div class="empty-state"><div class="empty-state-icon">&#9745;</div><p>No active tasks</p><p class="muted">Approve a draft task to get started</p></div>`;
  }

  const [current, ...queued] = tasks;
  return `<div class="active-task-card">
    <div class="active-task-head">
      <span class="badge badge-${current.status}">${current.status}</span>
      <span class="priority">P${current.priority}</span>
    </div>
    <a href="/tasks/${escapeHtml(current.id)}" hx-get="/tasks/${escapeHtml(current.id)}" hx-target="body" hx-push-url="true" class="active-task-title">${escapeHtml(current.title)}</a>
    <p class="muted">${queued.length} queued behind current task</p>
  </div>`;
}

export function dashboardAgentStatusFragment(
  agents: { id: string; name: string; status: string; type: string; current_task_id?: string | null }[],
): string {
  if (agents.length === 0) {
    return `<div class="empty-state"><div class="empty-state-icon">&#9881;</div><p>No agents configured</p><p class="muted">Create an agent to begin orchestrating</p></div>`;
  }

  return agents.map((agent) => `<div class="status-row">
      <span class="badge badge-${agent.status}">${agent.status}</span>
      <a href="/agents/${escapeHtml(agent.id)}" hx-get="/agents/${escapeHtml(agent.id)}" hx-target="body" hx-push-url="true" class="status-agent">${escapeHtml(agent.name)}</a>
      <span class="muted">${escapeHtml(agent.type)}</span>
      <span class="muted">${agent.current_task_id ? escapeHtml(agent.current_task_id.slice(0, 8)) : "-"}</span>
    </div>`).join("");
}

export function dashboardRunningInstancesFragment(
  instances: NonNullable<DashboardData["runningInstances"]>,
): string {
  if (instances.length === 0) {
    return `<div class="empty-state"><div class="empty-state-icon">&#9199;</div><p>No running instances</p><p class="muted">Workers will appear here when tasks execute</p></div>`;
  }
  return `<div class="status-list">
    ${instances.map((instance) => `<div class="status-row">
      <span class="badge badge-${escapeHtml(instance.status)}">${escapeHtml(instance.status)}</span>
      <span>${escapeHtml(instance.template_agent_name)}</span>
      <span class="muted">${escapeHtml(instance.id.slice(0, 8))}</span>
      <span class="muted">${instance.task_title ? escapeHtml(instance.task_title) : escapeHtml(instance.task_id.slice(0, 8))}</span>
      <span class="muted">${formatTimestamp(instance.updated_at)}</span>
    </div>`).join("")}
  </div>`;
}

export function dashboardDelegationGroupsFragment(
  groups: NonNullable<DashboardData["activeDelegationGroups"]>,
): string {
  if (groups.length === 0) {
    return `<div class="empty-state"><div class="empty-state-icon">&#128257;</div><p>No active delegation groups</p></div>`;
  }
  return `<div class="status-list">
    ${groups.map((group) => `<div class="status-row">
      <span class="badge badge-${escapeHtml(group.status)}">${escapeHtml(group.status)}</span>
      <span>${escapeHtml(group.id.slice(0, 8))}</span>
      <span class="muted">${group.settled_count}/${group.expected_count}</span>
      <span class="muted">failed ${group.failed_count}</span>
      <span class="muted">${formatTimestamp(group.created_at)}</span>
    </div>`).join("")}
  </div>`;
}

export function dashboardPage(data: DashboardData): string {
  const activeTasks = data.tasks.filter((t) => t.status === "running" || t.status === "approved");
  const daemonBadge = data.daemon.state === "running"
    ? "running"
    : data.daemon.state === "pausing" || data.daemon.state === "paused"
      ? "stopped"
      : "error";

  return layout(
    "Dashboard",
    `<h1>Dashboard</h1>
    <div class="dashboard-toolbar">
      <div class="card daemon-card daemon-killswitch">
        <div class="daemon-meta">
          <div class="daemon-title">Daemon Kill Switch</div>
          <div class="muted">Orchestration Control</div>
        </div>
        <span class="badge badge-${daemonBadge}">${data.daemon.state}</span>
        ${data.daemon.state === "running" ? `<button hx-post="/api/daemon/pause" hx-target="body" hx-swap="innerHTML" class="btn-danger daemon-kill-btn">Pause Daemon</button>` : ""}
        ${data.daemon.state === "paused" ? `<button hx-post="/api/daemon/resume" hx-target="body" hx-swap="innerHTML" class="daemon-kill-btn">Resume Daemon</button>` : ""}
        ${data.daemon.state === "pausing" ? `<span class="muted daemon-pausing">Pausing...</span>` : ""}
      </div>
    </div>

    <div class="dashboard-grid">
      <section class="card dashboard-panel">
        <div class="dashboard-panel-head">
          <h2>Current Active Task</h2>
        </div>
        <div id="active-tasks" hx-ext="sse" sse-connect="/events/tasks" sse-swap="task:state_changed" hx-swap="innerHTML">
          ${dashboardActiveTaskFragment(activeTasks)}
        </div>
      </section>


      <section class="card dashboard-panel">
        <div class="dashboard-panel-head">
          <h2>Running Instances</h2>
          <span class="muted">${(data.runningInstances ?? []).length} active</span>
        </div>
        <div id="running-instances" hx-ext="sse" sse-connect="/events/instances" sse-swap="instance:state_changed" hx-swap="innerHTML">
          ${dashboardRunningInstancesFragment(data.runningInstances ?? [])}
        </div>
      </section>

      <section class="card dashboard-panel">
        <div class="dashboard-panel-head">
          <h2>Delegation Groups</h2>
          <span class="muted">${(data.activeDelegationGroups ?? []).length} active</span>
        </div>
        <div id="delegation-groups" hx-ext="sse" sse-connect="/events/instances" sse-swap="delegation_group:progress" hx-swap="innerHTML">
          ${dashboardDelegationGroupsFragment(data.activeDelegationGroups ?? [])}
        </div>
      </section>
    </div>

    <section class="card dashboard-panel">
      <div class="dashboard-panel-head">
        <h2>Recent Agent Activity</h2>
      </div>
      <div id="recent-activity" class="activity-feed activity-feed-rich" hx-ext="sse" sse-connect="/events/logs" sse-swap="logs:activity" hx-swap="innerHTML">
        ${recentActivityFragment(data.recentLogs ?? [])}
      </div>
    </section>`,
    "/",
  );
}

export function recentActivityFragment(logs: RecentLogEntry[]): string {
  if (logs.length === 0) {
    return `<div class="empty-state"><div class="empty-state-icon">&#128240;</div><p>No recent activity</p><p class="muted">Agent output will appear here</p></div>`;
  }
  return logs.map((entry) => {
    const parsed = parseJsonLine(entry.data.trim());
    const summary = parsed ? terminalJsonSummary(parsed) : "";
    const type = parsed && typeof parsed.type === "string" ? parsed.type : null;
    const display = summary || (entry.data.length > 120 ? entry.data.slice(0, 120) + "…" : entry.data);
    return `<div class="activity-entry activity-entry-rich">
      <a href="/agents/${escapeHtml(entry.agent_id)}" hx-get="/agents/${escapeHtml(entry.agent_id)}" hx-target="body" hx-push-url="true" class="activity-agent">${escapeHtml(entry.agent_name)}</a>
      <span class="badge badge-stream-${escapeHtml(entry.stream)}">${escapeHtml(entry.stream)}</span>
      ${type ? `<span class="badge badge-json-type">${escapeHtml(type)}</span>` : ""}
      <code class="activity-data">${escapeHtml(display)}</code>
      <span class="muted activity-time">${formatTimestamp(entry.created_at)}</span>
    </div>`;
  }).join("");
}

// --- Tasks ---

export interface TaskHealthSummary {
  liveRuntimeCount: number;
  activeDelegationCount: number;
  openEscalationCount: number;
  lastProgressAt: string | null;
  remediationEventCount: number;
}

export interface TaskData {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: number;
  current_phase: number;
  team_id?: string;
  team_name?: string;
  created_at: string;
  result?: unknown;
  phases?: { name: string; prompt: string }[];
  healthSummary?: TaskHealthSummary;
}

export interface TaskNoteData {
  id: string;
  task_id: string;
  agent_id: string;
  agent_name?: string;
  content: string;
  created_at: string;
}

export interface DelegationData {
  id: string;
  parent_agent_id: string;
  child_agent_id: string;
  parent_agent_name?: string;
  child_agent_name?: string;
  task_id: string;
  prompt: string;
  result: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
}

export interface ArtifactData {
  id: string;
  task_id: string;
  agent_id: string;
  agent_name?: string;
  name: string;
  type: string;
  content: string | null;
  path: string | null;
  created_at: string;
}

export interface TeamOptionData {
  id: string;
  name: string;
}

// --- Forensics ---

export interface ForensicsTimelineEntry {
  source: "checkpoint" | "escalation" | "regression" | "remediation" | "delegation";
  created_at: string;
  // checkpoint fields
  checkpoint_type?: string;
  context_snapshot?: string;
  sequence?: number;
  // escalation fields
  escalation_type?: string;
  severity?: string;
  escalation_status?: string;
  question?: string;
  // regression fields
  from_phase?: number;
  to_phase?: number;
  reason?: string;
  agent_name?: string;
  // remediation/event fields
  event_type?: string;
  event_payload?: string;
}

export interface ForensicsAgentInstance {
  id: string;
  task_id: string;
  template_agent_id: string;
  agent_name: string | null;
  parent_instance_id: string | null;
  root_instance_id: string | null;
  status: string;
  process_pid: number | null;
  session_id: string | null;
  exit_code: number | null;
  attempt: number;
  created_at: string;
  updated_at: string;
}

export interface ForensicsTerminalTail {
  instance_id: string;
  lines: { stream: string; data: string }[];
}

export interface ForensicsDelegation {
  id: string;
  parent_agent_name: string | null;
  child_agent_name: string | null;
  prompt: string;
  result: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
}

export interface ForensicsDelegationGroup {
  id: string;
  task_id: string;
  parent_instance_id: string;
  policy: string;
  expected_count: number;
  settled_count: number;
  failed_count: number;
  status: string;
  created_at: string;
  completed_at: string | null;
  delegations: ForensicsDelegation[];
}

export interface ForensicsEscalation {
  id: string;
  agent_id: string;
  agent_name: string | null;
  type: string;
  severity: string;
  question: string;
  response: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

export interface ForensicsTokenUsage {
  instance_id: string;
  agent_name: string | null;
  status: string;
  // Aggregated from terminal_outputs result/turn.completed events
  input_tokens: number | null;
  cache_read_input_tokens: number | null;   // claude: cache_read, codex: cached_input
  cache_creation_input_tokens: number | null; // claude only
  output_tokens: number | null;
  num_turns: number | null;                 // claude: from result, codex: count of turn.completed
  duration_ms: number | null;              // claude only
  // From agent_states (ephemeral, may be null for completed instances)
  context_compact_needed: boolean;
  nudge_count: number;
}

export interface ForensicsData {
  timeline: ForensicsTimelineEntry[];
  instances: ForensicsAgentInstance[];
  delegationGroups: ForensicsDelegationGroup[];
  escalations: ForensicsEscalation[];
  tokenUsage: ForensicsTokenUsage[];
  terminalTails: ForensicsTerminalTail[];
}

export type PollIntervalSeconds = 3 | 8;

function pollingRoot(id: string, endpoint: string, pollIntervalSeconds: PollIntervalSeconds, content: string): string {
  return `<div id="${escapeHtml(id)}" class="poll-fragment" hx-get="${escapeHtml(endpoint)}" hx-trigger="every ${pollIntervalSeconds}s" hx-swap="outerHTML">${content}</div>`;
}

export interface AuditEventData {
  id: number;
  type: string;
  payload: string;
  source_agent_id: string | null;
  task_id: string | null;
  created_at: string;
}

export interface AuditEventFilters {
  type?: string;
  task_id?: string;
  agent_id?: string;
}

export function taskListFragment(tasks: TaskData[]): string {
  return tasks.length === 0
    ? `<div class="empty-state"><div class="empty-state-icon">&#128203;</div><p>No tasks yet</p><p class="muted">Create your first task to get started</p></div>`
    : `<table class="data-table">
        <thead><tr><th>Status</th><th>Title</th><th>Team</th><th>Priority</th><th>Phase</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>${tasks.map(taskTableRow).join("")}</tbody>
      </table>`;
}

export function taskListPollingFragment(tasks: TaskData[], pollIntervalSeconds: PollIntervalSeconds): string {
  return pollingRoot("task-list", "/fragments/tasks/list", pollIntervalSeconds, taskListFragment(tasks));
}

function taskDetailSummaryContent(task: TaskData): string {
  return `<div class="card">
      <div class="detail-grid">
        <div><strong>Status:</strong> <span class="badge badge-${task.status}">${task.status}</span></div>
        <div><strong>Priority:</strong> P${task.priority}</div>
        <div><strong>Team:</strong> ${task.team_name ? escapeHtml(task.team_name) : "None"}</div>
        <div><strong>Created:</strong> ${formatTimestamp(task.created_at)}</div>
      </div>
      ${task.description ? `<div class="detail-desc"><strong>Description:</strong><p>${escapeHtml(task.description)}</p></div>` : ""}
      ${task.result ? `<div class="detail-desc"><strong>Result:</strong><pre>${escapeHtml(JSON.stringify(task.result, null, 2))}</pre></div>` : ""}
    </div>`;
}

export function taskDetailSummaryFragment(task: TaskData | null, pollIntervalSeconds: PollIntervalSeconds): string {
  const content = task
    ? taskDetailSummaryContent(task)
    : `<div class="card"><p class="muted">Task not found.</p></div>`;
  const interval = task ? pollIntervalSeconds : 8;
  const endpoint = task ? `/fragments/tasks/${escapeHtml(task.id)}/summary` : "/fragments/tasks/missing/summary";
  return pollingRoot("task-summary-fragment", endpoint, interval, content);
}

function taskPhasesContent(task: TaskData): string {
  return phaseStepper(task.current_phase, task.phases, task.status);
}

export function taskPhaseStepperFragment(task: TaskData | null, pollIntervalSeconds: PollIntervalSeconds): string {
  const content = task
    ? taskPhasesContent(task)
    : `<div class="card"><p class="muted">Task not found.</p></div>`;
  const interval = task ? pollIntervalSeconds : 8;
  const endpoint = task ? `/fragments/tasks/${escapeHtml(task.id)}/phases` : "/fragments/tasks/missing/phases";
  return pollingRoot("task-phases-fragment", endpoint, interval, content);
}

function taskDelegationsContent(delegations: DelegationData[]): string {
  return `<h2>Delegations</h2>
    ${delegations.length === 0 ? `<div class="empty-state"><div class="empty-state-icon">&#128257;</div><p>No delegations</p></div>` : `<table class="data-table">
      <thead><tr><th>Status</th><th>Parent Agent</th><th>Child Agent</th><th>Prompt</th><th>Created</th><th>Completed</th></tr></thead>
      <tbody>${delegations.map(delegationTableRow).join("")}</tbody>
    </table>`}`;
}

export function taskDelegationsFragment(
  taskId: string,
  delegations: DelegationData[],
  pollIntervalSeconds: PollIntervalSeconds,
  taskExists: boolean = true,
): string {
  const content = taskExists
    ? taskDelegationsContent(delegations)
    : `<div class="card"><p class="muted">Task not found.</p></div>`;
  return pollingRoot("task-delegations-fragment", `/fragments/tasks/${escapeHtml(taskId)}/delegations`, pollIntervalSeconds, content);
}

// --- Forensics Render Functions ---

export function computeDisplayStatus(instance: ForensicsAgentInstance): { processOutcome: string; workflowState: string } {
  let processOutcome: string;
  if (instance.exit_code != null) {
    processOutcome = instance.exit_code === 0 ? "exited:0" : `killed:${instance.exit_code}`;
  } else if (instance.process_pid != null) {
    processOutcome = "alive";
  } else {
    processOutcome = "no-process";
  }

  let workflowState: string;
  if (instance.status === "running" && instance.exit_code != null) {
    workflowState = "stale-running";
  } else if (instance.status === "waiting_delegation") {
    workflowState = "blocked";
  } else if (instance.status === "completed" && instance.exit_code != null && instance.exit_code !== 0) {
    workflowState = "force-completed";
  } else {
    workflowState = instance.status;
  }

  return { processOutcome, workflowState };
}

export function staleBadge(updatedAt: string): string {
  const updated = new Date(updatedAt.includes("T") ? updatedAt : updatedAt.replace(" ", "T") + "Z");
  const ageMs = Date.now() - updated.getTime();
  const ageMin = ageMs / 60_000;

  if (ageMin > 10) {
    return `<span class="badge badge-error" title="Last updated ${Math.round(ageMin)}m ago">STALE</span>`;
  }
  if (ageMin > 5) {
    return `<span class="badge badge-stopped" title="Last updated ${Math.round(ageMin)}m ago">aging</span>`;
  }
  return "";
}

export function taskHealthSummaryFragment(health: TaskHealthSummary): string {
  return `<div class="health-summary">
    <div class="health-metric"><span class="health-value">${health.liveRuntimeCount}</span><span class="health-label">Live Runtimes</span></div>
    <div class="health-metric"><span class="health-value">${health.activeDelegationCount}</span><span class="health-label">Active Delegations</span></div>
    <div class="health-metric"><span class="health-value${health.openEscalationCount > 0 ? " health-alert" : ""}">${health.openEscalationCount}</span><span class="health-label">Open Escalations</span></div>
    <div class="health-metric"><span class="health-value">${health.remediationEventCount}</span><span class="health-label">Remediations</span></div>
    ${health.lastProgressAt ? `<div class="health-metric"><span class="health-value">${formatTimestamp(health.lastProgressAt)}</span><span class="health-label">Last Progress</span></div>` : ""}
  </div>`;
}

export function metricsFragment(metrics: {
  mttrMinutes: number | null;
  stuckTaskCount: number;
  totalRunningTasks: number;
  delegationSuccessRate: number | null;
  remediationEventCount: number;
}): string {
  function fmtPct(n: number | null): string {
    if (n == null) return "-";
    return `${Math.round(n * 100)}%`;
  }
  function fmtMin(n: number | null): string {
    if (n == null) return "-";
    if (n >= 60) return `${(n / 60).toFixed(1)}h`;
    return `${Math.round(n)}m`;
  }

  return `<div class="metrics-grid">
    <div class="metric-card"><div class="metric-value">${fmtMin(metrics.mttrMinutes)}</div><div class="metric-label">MTTR (7d avg)</div></div>
    <div class="metric-card"><div class="metric-value${metrics.stuckTaskCount > 0 ? " health-alert" : ""}">${metrics.stuckTaskCount}/${metrics.totalRunningTasks}</div><div class="metric-label">Stuck Tasks</div></div>
    <div class="metric-card"><div class="metric-value">${fmtPct(metrics.delegationSuccessRate)}</div><div class="metric-label">Delegation Success</div></div>
    <div class="metric-card"><div class="metric-value">${metrics.remediationEventCount}</div><div class="metric-label">Remediations (24h)</div></div>
  </div>`;
}

export function operatorActionsFragment(task: TaskData): string {
  if (task.status !== "running" && task.status !== "failed") return "";

  const buttons: string[] = [];
  if (task.status === "running") {
    buttons.push(`<button class="btn btn-danger" hx-post="/api/tasks/${escapeHtml(task.id)}/cancel" hx-confirm="This will fail the task. Continue?" hx-target="body">Fail Task Safely</button>`);
    buttons.push(`<button class="btn btn-warning" hx-post="/api/tasks/${escapeHtml(task.id)}/clear-stale" hx-target="body">Clear Stale Assignments</button>`);
    buttons.push(`<button class="btn btn-secondary" hx-get="/api/tasks/${escapeHtml(task.id)}/diagnostic" hx-target="#diagnostic-output" hx-swap="innerHTML">Why Stuck?</button>`);
  }
  if (task.status === "failed") {
    buttons.push(`<button class="btn btn-primary" hx-post="/api/tasks/${escapeHtml(task.id)}/retry" hx-target="body">Retry Task</button>`);
  }

  return `<div class="operator-actions">
    <h3>Operator Actions</h3>
    <div class="action-buttons">${buttons.join("")}</div>
    <div id="diagnostic-output"></div>
  </div>`;
}

export function diagnosticCard(diagnostic: {
  taskId: string;
  taskStatus: string;
  orchestrationStep: string | null;
  assignedAgent: { id: string; pid: number | null; status: string } | null;
  liveInstances: Array<{ id: string; status: string; pid: number | null }>;
  activeDelegations: Array<{ id: string; status: string; child_instance_id: string | null }>;
  openEscalations: Array<{ id: string; question: string }>;
  recentErrors: Array<{ category: string; message: string; created_at: string }>;
  likely_reasons: string[];
}): string {
  return `<div class="card diagnostic-card">
    <h3>Task Diagnostic</h3>
    <div class="detail-grid">
      <div><strong>Status:</strong> <span class="badge badge-${diagnostic.taskStatus}">${diagnostic.taskStatus}</span></div>
      <div><strong>Orchestration Step:</strong> ${diagnostic.orchestrationStep ?? "unknown"}</div>
      <div><strong>Assigned Agent:</strong> ${diagnostic.assignedAgent ? `${escapeHtml(diagnostic.assignedAgent.id.slice(0, 8))} (PID: ${diagnostic.assignedAgent.pid ?? "none"})` : "none"}</div>
      <div><strong>Live Instances:</strong> ${diagnostic.liveInstances.length}</div>
      <div><strong>Active Delegations:</strong> ${diagnostic.activeDelegations.length}</div>
      <div><strong>Open Escalations:</strong> ${diagnostic.openEscalations.length}</div>
    </div>
    <h4>Likely Reasons</h4>
    <ul>${diagnostic.likely_reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
    ${diagnostic.recentErrors.length > 0 ? `<h4>Recent Errors</h4><ul>${diagnostic.recentErrors.map((e) => `<li><strong>${escapeHtml(e.category)}:</strong> ${escapeHtml(e.message)} (${formatTimestamp(e.created_at)})</li>`).join("")}</ul>` : ""}
  </div>`;
}

export function taskForensicsFragment(
  taskId: string,
  forensics: ForensicsData,
  pollIntervalSeconds: PollIntervalSeconds,
): string {
  return pollingRoot(
    "task-forensics-fragment",
    `/fragments/tasks/${escapeHtml(taskId)}/forensics`,
    pollIntervalSeconds,
    taskForensicsContent(forensics),
  );
}

function taskForensicsContent(forensics: ForensicsData): string {
  const hasData = forensics.timeline.length > 0 ||
    forensics.instances.length > 0 ||
    forensics.delegationGroups.length > 0 ||
    forensics.escalations.length > 0 ||
    forensics.tokenUsage.length > 0;

  const inconsistencies: string[] = [];
  const instanceById = new Map(forensics.instances.map((i) => [i.id, i]));
  for (const group of forensics.delegationGroups) {
    if (group.status === "completed") {
      const dangling = group.delegations.filter((d) => d.status === "running" || d.status === "pending");
      if (dangling.length > 0) {
        inconsistencies.push(`Delegation group ${group.id.slice(0, 8)} is completed but has ${dangling.length} delegation(s) still marked running/pending.`);
      }
    }
  }
  for (const inst of forensics.instances) {
    if (inst.status === "running" && inst.process_pid == null && inst.exit_code != null) {
      inconsistencies.push(`Instance ${inst.id.slice(0, 8)} is marked running but has exit code ${inst.exit_code}.`);
    }
    if (inst.parent_instance_id && !instanceById.has(inst.parent_instance_id)) {
      inconsistencies.push(`Instance ${inst.id.slice(0, 8)} references missing parent instance ${inst.parent_instance_id.slice(0, 8)}.`);
    }
  }

  return `<details class="forensics-panel">
    <summary class="forensics-summary">
      <span class="forensics-toggle-icon">&#9654;</span>
      <h2 style="display:inline;margin:0">Forensics</h2>
      <span class="muted">${hasData ? `${forensics.timeline.length} events, ${forensics.instances.length} instances` : "no data"}</span>
    </summary>
    <div class="forensics-body">
      ${inconsistencies.length > 0 ? `<div class="card" style="border-color:#8b3a3a;background:linear-gradient(180deg,#2a1319,#1a0e13)"><h3 style="margin-top:0">Consistency Warnings</h3><ul>${inconsistencies.map((msg) => `<li>${escapeHtml(msg)}</li>`).join("")}</ul><p class="muted" style="margin-bottom:0">These warnings indicate state drift across task, instance, and delegation records.</p></div>` : ""}
      <details open><summary><h3 style="display:inline">Timeline</h3></summary>${forensicsTimeline(forensics.timeline)}</details>
      <details open><summary><h3 style="display:inline">Agent Instances</h3></summary>${forensicsInstanceTree(forensics.instances)}</details>
      <details><summary><h3 style="display:inline">Delegation Groups</h3> <span class="muted">(${forensics.delegationGroups.length})</span></summary>${forensicsDelegationGroups(forensics.delegationGroups)}</details>
      <details><summary><h3 style="display:inline">Escalations</h3> <span class="muted">(${forensics.escalations.length})</span></summary>${forensicsEscalations(forensics.escalations)}</details>
      <details><summary><h3 style="display:inline">Token Usage</h3></summary>${forensicsTokenUsage(forensics.tokenUsage)}</details>
      <details><summary><h3 style="display:inline">Terminal Output</h3></summary>${forensicsTerminalTails(forensics.terminalTails)}</details>
    </div>
  </details>`;
}

function forensicsTimeline(entries: ForensicsTimelineEntry[]): string {
  if (entries.length === 0) return "";
  const items = entries.map((e) => {
    let icon: string;
    let label: string;
    let detail = "";

    if (e.source === "checkpoint") {
      icon = "&#9679;";
      label = `Checkpoint: ${escapeHtml(e.checkpoint_type ?? "unknown")}`;
      if (e.context_snapshot && e.context_snapshot !== "{}") {
        detail = `<details class="forensics-snapshot"><summary class="muted">context snapshot</summary><pre>${escapeHtml(e.context_snapshot)}</pre></details>`;
      }
    } else if (e.source === "escalation") {
      icon = "&#9888;";
      label = `Escalation [${escapeHtml(e.escalation_type ?? "")}] ${escapeHtml(e.severity ?? "")} — ${escapeHtml(e.escalation_status ?? "")}`;
      if (e.question) {
        detail = `<div class="muted" style="margin-top:0.2rem">${escapeHtml(e.question.length > 120 ? e.question.slice(0, 120) + "…" : e.question)}</div>`;
      }
    } else if (e.source === "remediation") {
      icon = "&#9881;";
      label = `Remediation: ${escapeHtml(e.event_type ?? "unknown")}`;
      if (e.event_payload) {
        detail = `<details class="forensics-snapshot"><summary class="muted">details</summary><pre>${escapeHtml(e.event_payload)}</pre></details>`;
      }
    } else if (e.source === "delegation") {
      icon = "&#128257;";
      label = `Delegation: ${escapeHtml(e.event_type ?? "state change")}`;
      if (e.event_payload) {
        detail = `<details class="forensics-snapshot"><summary class="muted">details</summary><pre>${escapeHtml(e.event_payload)}</pre></details>`;
      }
    } else {
      icon = "&#8634;";
      label = `Phase regression ${e.from_phase} → ${e.to_phase}`;
      if (e.reason) {
        detail = `<div class="muted" style="margin-top:0.2rem">${escapeHtml(e.reason.length > 120 ? e.reason.slice(0, 120) + "…" : e.reason)}</div>`;
      }
      if (e.agent_name) {
        label += ` (${escapeHtml(e.agent_name)})`;
      }
    }

    return `<div class="forensics-timeline-entry">
      <span class="forensics-time">${formatTimestamp(e.created_at)}</span>
      <span class="forensics-icon">${icon}</span>
      <div class="forensics-label">${label}${detail}</div>
    </div>`;
  }).join("");

  return `<div class="forensics-section">
    <h3>Timeline</h3>
    <div class="forensics-timeline">${items}</div>
  </div>`;
}

function forensicsInstanceTree(instances: ForensicsAgentInstance[]): string {
  if (instances.length === 0) return "";

  const instanceMap = new Map(instances.map((i) => [i.id, i]));

  function getDepth(inst: ForensicsAgentInstance): number {
    let depth = 0;
    let current = inst;
    while (current.parent_instance_id && instanceMap.has(current.parent_instance_id)) {
      depth++;
      current = instanceMap.get(current.parent_instance_id)!;
    }
    return depth;
  }

  const rows = instances.map((inst) => {
    const depth = getDepth(inst);
    const name = inst.agent_name ?? inst.template_agent_id.slice(0, 8);
    const shortId = inst.id.slice(0, 8);
    const exitCodeBadge = inst.exit_code != null
      ? inst.exit_code === 0
        ? `<span class="badge badge-completed">exit 0</span>`
        : `<span class="badge badge-error">exit ${inst.exit_code}</span>`
      : "";
    const display = computeDisplayStatus(inst);
    const stale = staleBadge(inst.updated_at);
    return `<div class="forensics-instance-node" style="margin-left:${depth * 1.5}rem">
      <span class="badge badge-${inst.status}">${display.workflowState}</span>
      ${exitCodeBadge}
      ${stale}
      <strong>${escapeHtml(name)}</strong>
      <span class="muted">${escapeHtml(shortId)}</span>
      <span class="muted">attempt #${inst.attempt}</span>
      ${inst.session_id ? `<span class="muted">session ${escapeHtml(inst.session_id.slice(0, 8))}</span>` : ""}
      ${inst.process_pid ? `<span class="muted">PID ${inst.process_pid}</span>` : ""}
      <span class="muted">${formatTimestamp(inst.created_at)}</span>
    </div>`;
  }).join("");

  return `<div class="forensics-section">
    <h3>Agent Instances</h3>
    ${rows}
  </div>`;
}

function forensicsDelegationGroups(groups: ForensicsDelegationGroup[]): string {
  if (groups.length === 0) return "";

  const cards = groups.map((g) => {
    const delegationRows = g.delegations.map((d) => {
      const prompt = d.prompt.length > 80 ? d.prompt.slice(0, 80) + "…" : d.prompt;
      const statusLabel = g.status === "completed" && (d.status === "running" || d.status === "pending")
        ? "stale-running"
        : d.status;
      const statusClass = g.status === "completed" && (d.status === "running" || d.status === "pending")
        ? "error"
        : d.status;
      return `<tr>
        <td><span class="badge badge-${statusClass}">${statusLabel}</span></td>
        <td>${d.parent_agent_name ? escapeHtml(d.parent_agent_name) : "-"}</td>
        <td>${d.child_agent_name ? escapeHtml(d.child_agent_name) : "-"}</td>
        <td><details><summary class="muted">${escapeHtml(prompt)}</summary><pre style="white-space:pre-wrap;margin-top:0.3rem">${escapeHtml(d.prompt)}</pre>${d.result ? `<div style="margin-top:0.3rem"><strong>Result:</strong><pre style="white-space:pre-wrap">${escapeHtml(d.result)}</pre></div>` : ""}</details></td>
        <td>${formatTimestamp(d.created_at)}</td>
        <td>${d.completed_at ? formatTimestamp(d.completed_at) : "-"}</td>
      </tr>`;
    }).join("");

    const danglingCount = g.delegations.filter((d) => d.status === "running" || d.status === "pending").length;
    const statusExplanation = g.status === "completed"
      ? danglingCount > 0
        ? `<span class="muted">Completed group, but ${danglingCount} child record(s) still marked running/pending.</span>`
        : `<span class="muted">All child delegations settled.</span>`
      : `<span class="muted">Waiting for ${Math.max(g.expected_count - g.settled_count, 0)} unsettled child result(s).</span>`;

    return `<div class="card" style="margin-bottom:0.5rem">
      <div class="detail-grid">
        <div><strong>Group:</strong> ${escapeHtml(g.id.slice(0, 8))}</div>
        <div><strong>Policy:</strong> ${escapeHtml(g.policy)}</div>
        <div><strong>Progress:</strong> ${g.settled_count}/${g.expected_count} (${g.failed_count} failed)</div>
        <div><strong>Status:</strong> <span class="badge badge-${g.status}">${g.status}</span></div>
        <div><strong>Created:</strong> ${formatTimestamp(g.created_at)}</div>
        <div><strong>Completed:</strong> ${g.completed_at ? formatTimestamp(g.completed_at) : "-"}</div>
      </div>
      <div style="margin-top:0.25rem">${statusExplanation}</div>
      ${g.delegations.length > 0 ? `<table class="data-table" style="margin-top:0.5rem">
        <thead><tr><th>Status</th><th>Parent</th><th>Child</th><th>Prompt</th><th>Created</th><th>Completed</th></tr></thead>
        <tbody>${delegationRows}</tbody>
      </table>` : `<p class="muted" style="margin-top:0.4rem">No delegations in this group.</p>`}
    </div>`;
  }).join("");

  return `<div class="forensics-section">
    <h3>Delegation Groups</h3>
    ${cards}
  </div>`;
}

function forensicsEscalations(escalations: ForensicsEscalation[]): string {
  if (escalations.length === 0) return "";

  const rows = escalations.map((e) => `<tr>
    <td><span class="badge badge-${e.status}">${e.status}</span></td>
    <td>${escapeHtml(e.type)}</td>
    <td>${escapeHtml(e.severity)}</td>
    <td>${e.agent_name ? escapeHtml(e.agent_name) : escapeHtml(e.agent_id.slice(0, 8))}</td>
    <td>${escapeHtml(e.question.length > 80 ? e.question.slice(0, 80) + "…" : e.question)}</td>
    <td>${e.response ? escapeHtml(e.response.length > 60 ? e.response.slice(0, 60) + "…" : e.response) : "-"}</td>
    <td>${formatTimestamp(e.created_at)}</td>
    <td>${e.resolved_at ? formatTimestamp(e.resolved_at) : "-"}</td>
  </tr>`).join("");

  return `<div class="forensics-section">
    <h3>Escalations</h3>
    <table class="data-table">
      <thead><tr><th>Status</th><th>Type</th><th>Severity</th><th>Agent</th><th>Question</th><th>Response</th><th>Created</th><th>Resolved</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function forensicsTokenUsage(usage: ForensicsTokenUsage[]): string {
  if (usage.length === 0) return "";

  function fmt(n: number | null): string {
    if (n == null) return "-";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  function fmtMs(n: number | null): string {
    if (n == null) return "-";
    if (n >= 60_000) return `${(n / 60_000).toFixed(1)}m`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}s`;
    return `${n}ms`;
  }

  const rows = usage.map((u) => `<tr>
    <td>${u.agent_name ? escapeHtml(u.agent_name) : "-"}</td>
    <td class="muted">${escapeHtml(u.instance_id.slice(0, 8))}</td>
    <td><span class="badge badge-${u.status}">${u.status}</span></td>
    <td>${fmt(u.input_tokens)}</td>
    <td>${fmt(u.cache_read_input_tokens)}</td>
    <td>${fmt(u.cache_creation_input_tokens)}</td>
    <td>${fmt(u.output_tokens)}</td>
    <td>${u.num_turns ?? "-"}</td>
    <td>${fmtMs(u.duration_ms)}</td>
    <td>${u.context_compact_needed ? `<span class="badge badge-stopped">yes</span>` : "-"}</td>
    <td>${u.nudge_count > 0 ? u.nudge_count : "-"}</td>
  </tr>`).join("");

  return `<div class="forensics-section">
    <h3>Token Usage</h3>
    <table class="data-table">
      <thead><tr><th>Agent</th><th>Instance</th><th>State</th><th>Input</th><th>Cache Read</th><th>Cache Write</th><th>Output</th><th>Turns</th><th>Duration</th><th>Compact</th><th>Nudges</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function forensicsTerminalTails(tails: ForensicsTerminalTail[]): string {
  if (tails.length === 0) return "";

  const sections = tails.map((t) => {
    const lineHtml = t.lines.map((l) => {
      const trimmed = l.data.trim();
      if (!trimmed) return "";
      return `<div class="terminal-line terminal-${escapeHtml(l.stream)}">${escapeHtml(trimmed)}</div>`;
    }).filter(Boolean).join("");

    return `<div style="margin-bottom:0.5rem">
      <div class="muted" style="font-size:0.78rem;margin-bottom:0.2rem">Instance ${escapeHtml(t.instance_id.slice(0, 8))}</div>
      <div class="terminal forensics-tail">${lineHtml || '<span class="muted">no output</span>'}</div>
    </div>`;
  }).join("");

  return `<div class="forensics-section">
    <h3>Terminal Tail (last 20 lines per instance)</h3>
    ${sections}
  </div>`;
}

export function tasksPage(
  tasks: TaskData[],
  teams: TeamOptionData[] = [],
  pollIntervalSeconds: PollIntervalSeconds = 8,
  errorMessage?: string,
): string {
  return layout(
    "Tasks",
    `<div class="page-header">
      <h1>Tasks</h1>
      <button onclick="document.getElementById('create-task-form').style.display='block'">New Task</button>
    </div>
    ${errorMessage ? `<div class="card card-error"><p class="error">${escapeHtml(errorMessage)}</p></div>` : ""}

    <div id="create-task-form" style="display:none" class="card">
      <h3>Create Task</h3>
      <form hx-post="/api/tasks" hx-target="#task-list" hx-swap="innerHTML" hx-on::after-request="if(event.detail.successful) this.reset()">
        <label>Title <input type="text" name="title" required></label>
        <label>Description <textarea name="description" rows="3"></textarea></label>
        <label>Priority <input type="number" name="priority" min="1" max="10" value="5"></label>
        <label>Team
          <select name="teamId">
            <option value="">Unassigned</option>
            ${teams.map((team) => `<option value="${escapeHtml(team.id)}">${escapeHtml(team.name)}</option>`).join("")}
          </select>
        </label>
        <button type="submit">Create</button>
      </form>
    </div>

    ${taskListPollingFragment(tasks, pollIntervalSeconds)}`,
    "/tasks",
  );
}

function taskTableRow(task: TaskData): string {
  const actions = [];
  if (task.status === "draft") {
    if (task.team_id) {
      actions.push(`<button hx-post="/api/tasks/${escapeHtml(task.id)}/approve" hx-target="body" hx-swap="innerHTML" class="btn-sm">Approve</button>`);
    } else {
      actions.push(`<button class="btn-sm btn-disabled" disabled title="Assign a team before approving">Approve</button>`);
    }
    actions.push(`<button hx-post="/api/tasks/${escapeHtml(task.id)}/cancel" hx-target="body" hx-swap="innerHTML" class="btn-sm btn-danger">Cancel</button>`);
  }
  if (task.status === "running") {
    actions.push(`<button hx-post="/api/tasks/${escapeHtml(task.id)}/cancel" hx-target="body" hx-swap="innerHTML" class="btn-sm btn-danger">Cancel</button>`);
  }
  if (task.status === "failed") {
    actions.push(`<button hx-post="/api/tasks/${escapeHtml(task.id)}/retry" hx-target="body" hx-swap="innerHTML" class="btn-sm">Retry</button>`);
  }
  if (task.status !== "running") {
    actions.push(`<button hx-post="/api/tasks/${escapeHtml(task.id)}/delete" hx-target="body" hx-swap="innerHTML" class="btn-sm btn-danger">Delete</button>`);
  }

  return `<tr>
    <td><span class="badge badge-${task.status}">${task.status}</span></td>
    <td><a href="/tasks/${escapeHtml(task.id)}" hx-get="/tasks/${escapeHtml(task.id)}" hx-target="body" hx-push-url="true">${escapeHtml(task.title)}</a></td>
    <td>${task.team_name ? escapeHtml(task.team_name) : "<span class='muted'>Unassigned</span>"}</td>
    <td>P${task.priority}</td>
    <td>${task.current_phase}</td>
    <td>${formatTimestamp(task.created_at)}</td>
    <td>${actions.join(" ")}</td>
  </tr>`;
}

export function taskDetailPage(
  task: TaskData,
  notes: TaskNoteData[] = [],
  delegations: DelegationData[] = [],
  artifacts: ArtifactData[] = [],
  teams: TeamOptionData[] = [],
  _pollIntervalSeconds: PollIntervalSeconds = 8,
  forensics: ForensicsData = { timeline: [], instances: [], delegationGroups: [], escalations: [], tokenUsage: [], terminalTails: [] },
): string {
  return layout(
    task.title,
    `<a href="/tasks" hx-get="/tasks" hx-target="body" hx-push-url="true">&larr; Back to Tasks</a>
    <h1>${escapeHtml(task.title)}</h1>
    ${taskDetailSummaryContent(task)}

    <div class="card">
      <h2>Edit Task</h2>
      ${task.status === "draft" ? `<form hx-post="/api/tasks/${escapeHtml(task.id)}" hx-target="body" hx-swap="innerHTML">
        <label>Title <input type="text" name="title" value="${escapeHtml(task.title)}" required></label>
        <label>Description <textarea name="description" rows="3">${task.description ? escapeHtml(task.description) : ""}</textarea></label>
        <label>Priority <input type="number" name="priority" min="1" max="10" value="${task.priority}"></label>
        <label>Team
          <select name="teamId">
            <option value="">Unassigned</option>
            ${teams.map((team) => `<option value="${escapeHtml(team.id)}"${task.team_id === team.id ? " selected" : ""}>${escapeHtml(team.name)}</option>`).join("")}
          </select>
        </label>
        <button type="submit">Save Changes</button>
      </form>` : `<p class="muted">Only draft tasks can be edited.</p>`}
    </div>

    ${task.healthSummary && task.status === "running" ? taskHealthSummaryFragment(task.healthSummary) : ""}

    ${operatorActionsFragment(task)}

    ${taskPhasesContent(task)}

    <h2>Notes</h2>
    ${notes.length === 0 ? `<div class="empty-state"><div class="empty-state-icon">&#128221;</div><p>No notes yet</p></div>` : notes.map((n) => `<div class="card">
      <div class="muted">Agent: ${n.agent_name ? escapeHtml(n.agent_name) : escapeHtml(n.agent_id.slice(0, 8))} | ${formatTimestamp(n.created_at)}</div>
      <p>${escapeHtml(n.content)}</p>
    </div>`).join("")}

    ${taskDelegationsContent(delegations)}

    ${taskForensicsContent(forensics)}

    <h2>Artifacts</h2>
    ${artifacts.length === 0 ? `<div class="empty-state"><div class="empty-state-icon">&#128230;</div><p>No artifacts</p></div>` : artifacts.map(artifactCard).join("")}`,
    "/tasks",
  );
}

function phaseStepper(
  currentPhase: number,
  phases?: { name: string; prompt: string }[],
  taskStatus?: string,
): string {
  if (!phases || phases.length === 0) {
    return `<div class="card"><strong>Phase:</strong> ${currentPhase}</div>`;
  }

  const total = phases.length;
  const completedCount = taskStatus === "completed"
    ? total
    : Math.max(0, Math.min(currentPhase, total));
  const progressPct = Math.round((completedCount / total) * 100);

  const steps = phases.map((p, i) => {
    let state: "done" | "active" | "pending" | "failed";

    if (taskStatus === "completed") {
      state = "done";
    } else if (taskStatus === "failed" && i === currentPhase) {
      state = "failed";
    } else if (i < currentPhase) {
      state = "done";
    } else if (i === currentPhase) {
      state = "active";
    } else {
      state = "pending";
    }

    const icon = state === "done"
      ? "&#10003;"
      : state === "failed"
        ? "!"
        : `${i + 1}`;

    return `<div class="phase-step phase-step-${state}">
      <div class="phase-circle">${icon}</div>
      <div class="phase-name">${escapeHtml(p.name)}</div>
    </div>`;
  });

  return `<div class="phase-stepper">
    <div class="phase-summary">
      <span>${completedCount}/${total} phases complete</span>
      <span>${progressPct}%</span>
    </div>
    <div class="phase-progress">
      <div class="phase-progress-fill" style="width:${progressPct}%"></div>
    </div>
    <div class="phase-grid" style="--phase-cols:${Math.min(total, 6)}">
      ${steps.join("")}
    </div>
  </div>`;
}

function delegationTableRow(d: DelegationData): string {
  return `<tr>
    <td><span class="badge badge-${d.status}">${d.status}</span></td>
    <td>${d.parent_agent_name ? escapeHtml(d.parent_agent_name) : escapeHtml(d.parent_agent_id.slice(0, 8))}</td>
    <td>${d.child_agent_name ? escapeHtml(d.child_agent_name) : escapeHtml(d.child_agent_id.slice(0, 8))}</td>
    <td class="muted">${escapeHtml(d.prompt.length > 80 ? d.prompt.slice(0, 80) + "…" : d.prompt)}</td>
    <td>${formatTimestamp(d.created_at)}</td>
    <td>${d.completed_at ? formatTimestamp(d.completed_at) : "-"}</td>
  </tr>`;
}

function artifactCard(a: ArtifactData): string {
  return `<div class="card artifact-card">
    <div class="artifact-header">
      <span class="badge badge-artifact-${a.type}">${escapeHtml(a.type)}</span>
      <strong>${escapeHtml(a.name)}</strong>
      <span class="muted">Agent: ${a.agent_name ? escapeHtml(a.agent_name) : escapeHtml(a.agent_id.slice(0, 8))} | ${formatTimestamp(a.created_at)}</span>
    </div>
    ${a.path ? `<div class="artifact-path"><code>${escapeHtml(a.path)}</code></div>` : ""}
    ${a.content ? `<details class="artifact-content"><summary>View content</summary><pre>${escapeHtml(a.content)}</pre></details>` : ""}
  </div>`;
}

// --- Agents ---

const AGENT_TYPE_MODELS: Record<string, string[]> = {
  "claude-code": ["claude-sonnet-4-6", "claude-opus-4-6"],
  "codex": ["gpt-5.3-codex"],
  "custom": [],
};

function agentTypeAndModelFields(selectedType: string, selectedModel: string, suffix: string): string {
  const models = AGENT_TYPE_MODELS[selectedType] ?? [];
  const effectiveModel = selectedModel === "default" || !selectedModel ? (models[0] ?? "default") : selectedModel;
  const modelOptions = models.length > 0
    ? models.map((m) => `<option value="${escapeHtml(m)}"${m === effectiveModel ? " selected" : ""}>${escapeHtml(m)}</option>`).join("")
    : `<option value="default">default</option>`;

  return `<label>Type
          <select name="type" id="agent-type-${suffix}" onchange="skipperUpdateModels('${suffix}', this.value)">
            <option value="claude-code"${selectedType === "claude-code" ? " selected" : ""}>claude-code</option>
            <option value="codex"${selectedType === "codex" ? " selected" : ""}>codex</option>
            <option value="custom"${selectedType === "custom" ? " selected" : ""}>custom</option>
          </select>
        </label>
        <label>Model
          <select name="model" id="agent-model-${suffix}">
            ${modelOptions}
          </select>
        </label>
        <script>
          window.__skipperAgentModels = ${JSON.stringify(AGENT_TYPE_MODELS)};
          function skipperUpdateModels(suffix, type) {
            var sel = document.getElementById('agent-model-' + suffix);
            var models = (window.__skipperAgentModels || {})[type] || [];
            if (models.length === 0) {
              sel.innerHTML = '<option value="default">default</option>';
            } else {
              sel.innerHTML = models.map(function(m) { return '<option value="' + m + '">' + m + '</option>'; }).join('');
            }
          }
        </script>`;
}

export interface AgentData {
  id: string;
  name: string;
  type: string;
  model: string;
  status: string;
  capabilities: string[];
  config: Record<string, unknown>;
  process_pid: number | null;
  current_task_id: string | null;
  running_instance_count?: number;
}

export interface AgentInstanceSummary {
  id: string;
  status: string;
  task_id: string;
  task_title: string | null;
  created_at: string;
}

export function agentsPage(agents: AgentData[], pollIntervalSeconds: PollIntervalSeconds = 8): string {
  return layout(
    "Agents",
    `<div class="page-header">
      <h1>Agents</h1>
      <button onclick="document.getElementById('create-agent-form').style.display='block'">New Agent</button>
    </div>

    <div id="create-agent-form" style="display:none" class="card">
      <h3>Create Agent</h3>
      <form hx-post="/api/agents" hx-target="#agent-list" hx-swap="innerHTML" hx-on::after-request="if(event.detail.successful) this.reset()">
        <label>Name <input type="text" name="name" required></label>
        ${agentTypeAndModelFields("claude-code", "", "create")}
        <label>Instruction <input type="text" name="instruction"></label>
        <button type="submit">Create</button>
      </form>
    </div>

    ${agentListPollingFragment(agents, pollIntervalSeconds)}`,
    "/agents",
  );
}

export function agentListFragment(agents: AgentData[]): string {
  return agents.length === 0
    ? `<div class="empty-state"><div class="empty-state-icon">&#129302;</div><p>No agents configured</p><p class="muted">Create an agent to begin orchestrating</p></div>`
    : `<table class="data-table">
        <thead><tr><th>Name</th><th>Type</th><th>Model</th><th>Instances</th><th>Actions</th></tr></thead>
        <tbody>${agents.map(agentTableRow).join("")}</tbody>
      </table>`;
}

export function agentListPollingFragment(agents: AgentData[], pollIntervalSeconds: PollIntervalSeconds): string {
  return pollingRoot("agent-list", "/fragments/agents/list", pollIntervalSeconds, agentListFragment(agents));
}

function agentTableRow(agent: AgentData): string {
  const isSystem = isSkipperAgent(agent.id);
  const link = isSystem ? "/skipper" : `/agents/${escapeHtml(agent.id)}`;
  const nameHtml = isSystem
    ? `<a href="${link}" hx-get="${link}" hx-target="body" hx-push-url="true">${escapeHtml(agent.name)}</a> <span class="badge badge-system">System</span>`
    : `<a href="${link}" hx-get="${link}" hx-target="body" hx-push-url="true">${escapeHtml(agent.name)}</a>`;
  const instanceCount = agent.running_instance_count ?? 0;
  const actionsHtml = isSystem
    ? ""
    : instanceCount === 0 ? `<button hx-delete="/api/agents/${escapeHtml(agent.id)}" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this agent?" class="btn-sm btn-danger">Delete</button>` : "";
  const instancesHtml = instanceCount > 0
    ? `<span class="badge badge-running">${instanceCount} running</span>`
    : `<span class="muted">-</span>`;

  return `<tr>
    <td>${nameHtml}</td>
    <td>${escapeHtml(agent.type)}</td>
    <td>${escapeHtml(agent.model)}</td>
    <td>${instancesHtml}</td>
    <td>${actionsHtml}</td>
  </tr>`;
}

export interface AgentSessionData {
  id: string;
  created_at: string;
}

function agentDetailSummaryContent(agent: AgentData): string {
  const instanceCount = agent.running_instance_count ?? 0;
  const instancesHtml = instanceCount > 0
    ? `<span class="badge badge-running">${instanceCount} running</span>`
    : `<span class="muted">None</span>`;
  return `<div class="card">
      <div class="detail-grid">
        <div><strong>Type:</strong> ${escapeHtml(agent.type)}</div>
        <div><strong>Model:</strong> ${escapeHtml(agent.model)}</div>
        <div><strong>Active Instances:</strong> ${instancesHtml}</div>
        <div><strong>Capabilities:</strong> ${agent.capabilities.length > 0 ? agent.capabilities.map(escapeHtml).join(", ") : "None"}</div>
      </div>
      ${agent.config.instruction ? `<div class="detail-desc"><strong>Instruction:</strong><p>${escapeHtml(String(agent.config.instruction))}</p></div>` : ""}
    </div>`;
}

export function agentDetailSummaryFragment(agent: AgentData | null, pollIntervalSeconds: PollIntervalSeconds): string {
  const content = agent
    ? agentDetailSummaryContent(agent)
    : `<div class="card"><p class="muted">Agent not found.</p></div>`;
  const interval = agent ? pollIntervalSeconds : 8;
  const endpoint = agent ? `/fragments/agents/${escapeHtml(agent.id)}/summary` : "/fragments/agents/missing/summary";
  return pollingRoot("agent-summary-fragment", endpoint, interval, content);
}

export function agentDetailPage(
  agent: AgentData,
  sessions: AgentSessionData[] = [],
  selectedSessionId?: string,
  pollIntervalSeconds: PollIntervalSeconds = 8,
  activeInstances: AgentInstanceSummary[] = [],
): string {
  const isViewingHistory = !!selectedSessionId;
  const latestSessionId = sessions.length > 0 ? sessions[0].id : null;
  const activeSessionId = selectedSessionId ?? latestSessionId;
  const instanceCount = agent.running_instance_count ?? 0;

  const sessionSelector = sessions.length > 1 ? `<div class="session-selector">
      <label>Session:
        <select onchange="window.location.href='/agents/${escapeHtml(agent.id)}?session=' + this.value">
          ${sessions.map((s, i) => `<option value="${escapeHtml(s.id)}"${s.id === activeSessionId ? " selected" : ""}>${i === 0 ? "Latest" : formatTimestamp(s.created_at)} (${escapeHtml(s.id.slice(0, 8))})</option>`).join("")}
        </select>
      </label>
      <span class="muted">${sessions.length} session${sessions.length !== 1 ? "s" : ""}</span>
    </div>` : sessions.length === 1 ? `<div class="session-selector"><span class="muted">1 session</span></div>` : "";

  const outputUrl = activeSessionId
    ? `/agents/${escapeHtml(agent.id)}/output?session=${escapeHtml(activeSessionId)}`
    : `/agents/${escapeHtml(agent.id)}/output`;

  const instancesSection = activeInstances.length > 0
    ? `<div class="card">
        <h2>Active Instances</h2>
        <table class="data-table">
          <thead><tr><th>Instance</th><th>Status</th><th>Task</th><th>Started</th></tr></thead>
          <tbody>${activeInstances.map((inst) => `<tr>
            <td>${escapeHtml(inst.id.slice(0, 8))}</td>
            <td><span class="badge badge-${inst.status}">${escapeHtml(inst.status)}</span></td>
            <td>${inst.task_title ? escapeHtml(inst.task_title) : escapeHtml(inst.task_id.slice(0, 8))}</td>
            <td>${formatTimestamp(inst.created_at)}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>`
    : "";

  return layout(
    agent.name,
    `<a href="/agents" hx-get="/agents" hx-target="body" hx-push-url="true">&larr; Back to Agents</a>
    <h1>${escapeHtml(agent.name)}</h1>
    ${agentDetailSummaryContent(agent)}
    ${instancesSection}

    <div class="terminal-section-header">
      <h2>Terminal Output</h2>
      <span id="terminal-line-count" class="muted terminal-line-count">Loading...</span>
    </div>
    ${sessionSelector}
    <div id="terminal" class="terminal"${!isViewingHistory ? ` hx-ext="sse" sse-connect="/events/agent/${escapeHtml(agent.id)}/output" sse-swap="agent:output" hx-swap="beforeend scroll:bottom"` : ""}>
      <div hx-get="${outputUrl}" hx-trigger="load" hx-swap="innerHTML" hx-on::after-settle="(function(){var el=document.getElementById('terminal-line-count');if(el)el.textContent=document.querySelectorAll('#terminal .terminal-line').length+' lines';})()"></div>
    </div>

    <div class="card">
      <h2>Edit Agent</h2>
      ${instanceCount > 0 ? `<p class="muted">Agents with running instances cannot be edited.</p>` : `<form hx-post="/api/agents/${escapeHtml(agent.id)}" hx-target="body" hx-swap="innerHTML">
        <label>Name <input type="text" name="name" value="${escapeHtml(agent.name)}" required></label>
        ${agentTypeAndModelFields(agent.type, agent.model, "edit")}
        <label>Instruction <input type="text" name="instruction" value="${agent.config.instruction ? escapeHtml(String(agent.config.instruction)) : ""}"></label>
        <button type="submit">Save Changes</button>
      </form>`}
    </div>`,
    "/agents",
  );
}

export function renderTerminalOutputChunk(stream: string, data: string): string {
  const lines = data.split(/\r?\n/);
  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => renderTerminalLine(stream, line))
    .join("");
}

export function terminalOutputFragment(outputs: { stream: string; data: string; sequence: number }[]): string {
  return outputs
    .map((o) => renderTerminalOutputChunk(o.stream, o.data))
    .join("");
}

function renderTerminalLine(stream: string, line: string): string {
  const trimmed = line.trim();
  const parsed = parseJsonLine(trimmed);
  if (!parsed) {
    return `<div class="terminal-line terminal-${stream}">${escapeHtml(line)}</div>`;
  }

  const type = typeof parsed.type === "string" ? parsed.type : null;
  const summary = terminalJsonSummary(parsed);

  return `<div class="terminal-line terminal-${stream} terminal-json"><div class="terminal-json-header"><span class="badge badge-stream-${escapeHtml(stream)}">${escapeHtml(stream)}</span>${type ? `<span class="badge badge-json-type">${escapeHtml(type)}</span>` : ""}${summary ? `<span class="terminal-json-summary">${escapeHtml(summary)}</span>` : ""}</div><details class="terminal-json-details"><summary>raw json</summary><pre class="terminal-json-body">${escapeHtml(JSON.stringify(parsed, null, 2))}</pre></details></div>`;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function terminalJsonSummary(event: Record<string, unknown>): string {
  const trunc = (s: string, n = 160) => s.length > n ? s.slice(0, n) + "…" : s;

  // Claude Code: assistant / user message events
  const message = event.message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    if (Array.isArray(content) && content.length > 0) {
      // Collect text across all content blocks (up to 3) for assistant messages
      const type = (event as Record<string, unknown>).type;
      if (type === "assistant") {
        const parts: string[] = [];
        for (const block of content.slice(0, 3)) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            parts.push(b.text.trim());
          } else if (b.type === "thinking" && typeof b.thinking === "string") {
            parts.push(`<thinking> ${b.thinking.slice(0, 60)}…`);
          } else if (b.type === "tool_use" && typeof b.name === "string") {
            const inp = b.input && typeof b.input === "object" ? b.input as Record<string, unknown> : {};
            const detail = Object.entries(inp).slice(0, 2).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
            parts.push(`${b.name}(${detail})`);
          }
        }
        if (parts.length > 0) return trunc(parts.join(" | "));
      }

      // user messages: tool_result content
      if (type === "user") {
        const first = content[0] as Record<string, unknown>;
        if (first?.type === "tool_result") {
          const inner = first.content;
          if (typeof inner === "string") return trunc(inner);
          if (Array.isArray(inner) && inner.length > 0) {
            const t = (inner[0] as Record<string, unknown>).text;
            if (typeof t === "string") return trunc(t);
          }
        }
      }
    }
    // Plain string content
    if (typeof content === "string") return trunc(content);
  }

  // Codex: event.item with text / command
  const item = event.item;
  if (item && typeof item === "object") {
    const b = item as Record<string, unknown>;
    const itemType = typeof b.type === "string" ? b.type : "";
    if (itemType === "command_execution" && typeof b.command === "string") {
      return trunc(b.command);
    }
    if (typeof b.text === "string" && b.text) return trunc(b.text);
    if (itemType) return itemType;
  }

  // result string (claude-code "result" event, codex summary)
  if (typeof event.result === "string") return trunc(event.result);

  // error
  const error = event.error;
  if (error && typeof error === "object") {
    const msg = (error as Record<string, unknown>).message;
    if (typeof msg === "string") return trunc(msg);
  }

  return "";
}

// --- Teams ---

export interface TeamData {
  id: string;
  name: string;
  entrypoint_agent_id: string | null;
  entrypoint_agent_name?: string;
  goal?: string;
  phases: { name: string; prompt: string }[];
}

export interface TeamAgentData {
  agent_id: string;
  agent_name: string;
  role: string | null;
  level: number;
  max_complexity: number | null;
  capabilities: string[];
}

export interface AgentOptionData {
  id: string;
  name: string;
}

export function teamListFragment(teams: TeamData[]): string {
  return teams.length === 0
    ? `<div class="empty-state"><div class="empty-state-icon">&#128101;</div><p>No teams configured</p><p class="muted">Create a team to organize your agents</p></div>`
    : `<table class="data-table">
        <thead><tr><th>Name</th><th>Goal</th><th>Entrypoint</th><th>Phases</th></tr></thead>
        <tbody>${teams.map(teamTableRow).join("")}</tbody>
      </table>`;
}

export function teamListPollingFragment(teams: TeamData[], pollIntervalSeconds: PollIntervalSeconds): string {
  return pollingRoot("team-list", "/fragments/teams/list", pollIntervalSeconds, teamListFragment(teams));
}

export function teamsPage(teams: TeamData[], pollIntervalSeconds: PollIntervalSeconds = 8): string {
  void pollIntervalSeconds;
  return layout(
    "Teams",
    `<div class="page-header">
      <h1>Teams</h1>
      <button onclick="document.getElementById('create-team-form').style.display='block'">New Team</button>
    </div>

    <div id="create-team-form" style="display:none" class="card">
      <h3>Create Team</h3>
      <form hx-post="/api/teams" hx-target="#team-list" hx-swap="innerHTML" hx-on::after-request="if(event.detail.successful) this.reset()">
        <label>Name <input type="text" name="name" required></label>
        <label>Goal <input type="text" name="goal"></label>
        <button type="submit">Create</button>
      </form>
    </div>

    <div id="team-list">${teamListFragment(teams)}</div>`,
    "/teams",
  );
}

function teamTableRow(team: TeamData): string {
  return `<tr>
    <td><a href="/teams/${escapeHtml(team.id)}" hx-get="/teams/${escapeHtml(team.id)}" hx-target="body" hx-push-url="true">${escapeHtml(team.name)}</a></td>
    <td>${team.goal ? escapeHtml(team.goal) : "-"}</td>
    <td>${team.entrypoint_agent_name ? escapeHtml(team.entrypoint_agent_name) : "None"}</td>
    <td>${team.phases.length}</td>
  </tr>`;
}

export function teamDetailPage(
  team: TeamData,
  agents: TeamAgentData[],
  availableAgents: AgentOptionData[] = [],
  pollIntervalSeconds: PollIntervalSeconds = 8,
): string {
  void pollIntervalSeconds;
  const phaseCards = team.phases.map((p, i) => `<div class="phase-card">
      <div class="phase-card-header">
        <span class="badge badge-phase-index">Phase ${i + 1}</span>
      </div>
      <form hx-post="/api/teams/${escapeHtml(team.id)}/phases/${i}" hx-target="body" hx-swap="innerHTML" class="phase-edit-form">
        <label>Name <input type="text" name="name" value="${escapeHtml(p.name)}" required></label>
        <label>Prompt <textarea name="prompt" rows="3" required>${escapeHtml(p.prompt)}</textarea></label>
        <div class="phase-card-actions">
          <button type="submit" class="btn-sm">Save Phase</button>
          <button type="button" hx-delete="/api/teams/${escapeHtml(team.id)}/phases/${i}" hx-target="body" hx-swap="innerHTML" hx-confirm="Remove this phase?" class="btn-sm btn-danger">Remove</button>
        </div>
      </form>
    </div>`).join("");

  return layout(
    team.name,
    `<a href="/teams" hx-get="/teams" hx-target="body" hx-push-url="true">&larr; Back to Teams</a>
    <div id="team-summary-fragment">${teamDetailSummaryContent(team, agents)}</div>

    <div class="team-layout">
      <section class="card team-section">
        <h2>Team Settings</h2>
        <form hx-post="/api/teams/${escapeHtml(team.id)}" hx-target="body" hx-swap="innerHTML">
          <label>Name <input type="text" name="name" value="${escapeHtml(team.name)}" required></label>
          <label>Goal <input type="text" name="goal" value="${team.goal ? escapeHtml(team.goal) : ""}" placeholder="What this team is optimizing for"></label>
          <button type="submit">Save Team</button>
        </form>
      </section>
    </div>

    <section class="card team-section">
      <div class="team-section-header">
        <h2>Phases</h2>
        <span class="muted">${team.phases.length} configured</span>
      </div>
      ${team.phases.length === 0 ? `<div class="empty-state"><div class="empty-state-icon">&#9654;</div><p>No phases defined</p><p class="muted">Add at least one phase to guide execution.</p></div>` : `<div class="phase-card-list">${phaseCards}</div>`}

      <div class="phase-add">
        <h3>Add Phase</h3>
        <form hx-post="/api/teams/${escapeHtml(team.id)}/phases" hx-target="body" hx-swap="innerHTML" hx-on::after-request="if(event.detail.successful) this.reset()">
          <label>Name <input type="text" name="name" required></label>
          <label>Prompt <textarea name="prompt" rows="3" required></textarea></label>
          <button type="submit">Add Phase</button>
        </form>
      </div>
    </section>

    ${teamMembersContent(team, agents, availableAgents)}`,
    "/teams",
  );
}

function teamDetailSummaryContent(team: TeamData, _agents: TeamAgentData[]): string {
  return `<div class="team-hero">
      <h1>${escapeHtml(team.name)}</h1>
      <div class="team-hero-meta">
        <span class="badge badge-phase-index">${team.phases.length} phase${team.phases.length === 1 ? "" : "s"}</span>
        <span class="muted">Lead: <a href="/skipper" hx-get="/skipper" hx-target="body" hx-push-url="true">Skipper</a></span>
      </div>
    </div>`;
}

export function teamDetailSummaryFragment(
  team: TeamData | null,
  agents: TeamAgentData[],
  pollIntervalSeconds: PollIntervalSeconds,
): string {
  const content = team
    ? teamDetailSummaryContent(team, agents)
    : `<div class="card"><p class="muted">Team not found.</p></div>`;
  const interval = team ? pollIntervalSeconds : 8;
  const endpoint = team ? `/fragments/teams/${escapeHtml(team.id)}/summary` : "/fragments/teams/missing/summary";
  return pollingRoot("team-summary-fragment", endpoint, interval, content);
}

function teamMemberCard(team: TeamData, a: TeamAgentData): string {
  if (isSkipperAgent(a.agent_id)) {
    return `<div class="member-card">
      <div class="member-card-head">
        <strong><a href="/skipper" hx-get="/skipper" hx-target="body" hx-push-url="true">${escapeHtml(a.agent_name)}</a></strong>
        <span class="badge badge-system">System</span>
      </div>
      <div class="member-grid">
        <label>Role <input type="text" value="lead" disabled></label>
        <label>Level <input type="number" value="0" disabled></label>
      </div>
    </div>`;
  }

  return `<form hx-post="/api/teams/${escapeHtml(team.id)}/agents/${escapeHtml(a.agent_id)}" hx-target="body" hx-swap="innerHTML" class="member-card">
      <div class="member-card-head">
        <strong>${escapeHtml(a.agent_name)}</strong>
        <span class="muted">${escapeHtml(a.agent_id.slice(0, 8))}</span>
      </div>
      <div class="member-grid">
        <label>Role <input type="text" name="role" value="${a.role ? escapeHtml(a.role) : ""}" placeholder="Role"></label>
        <label>Level <input type="number" name="level" min="1" value="${a.level}"></label>
        <label>Max Complexity <input type="number" name="max_complexity" min="1" max="10" value="${a.max_complexity ?? 10}"></label>
      </div>
      <label>Skills (agent-level)
        <input type="text" name="skills" value="${escapeHtml(a.capabilities.join(", "))}" placeholder="e.g. testing, backend, review">
      </label>
      <div class="member-actions">
        <button type="submit" class="btn-sm">Save Member</button>
        <button type="button" class="btn-sm btn-danger" hx-delete="/api/teams/${escapeHtml(team.id)}/agents/${escapeHtml(a.agent_id)}" hx-target="body" hx-swap="innerHTML" hx-confirm="Remove this member from the team?">Remove</button>
      </div>
    </form>`;
}

function teamMembersContent(team: TeamData, agents: TeamAgentData[], availableAgents: AgentOptionData[]): string {
  // Filter Skipper out of available agents (it's auto-added)
  const filteredAvailable = availableAgents.filter((a) => !isSkipperAgent(a.id));

  return `<section class="card team-section">
      <div class="team-section-header">
        <h2>Members</h2>
        <span class="muted">${agents.length} total</span>
      </div>
      ${agents.length === 0 ? `<div class="empty-state"><div class="empty-state-icon">&#128101;</div><p>No agents in this team</p></div>` : `<div class="member-card-list">
        ${agents.map((a) => teamMemberCard(team, a)).join("")}
      </div>`}

      <h3>Add Agent</h3>
      <form hx-post="/api/teams/${escapeHtml(team.id)}/agents" hx-target="body" hx-swap="innerHTML" class="inline-form">
        <select name="agent_id" required>
          <option value="">Select an agent</option>
          ${filteredAvailable.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</option>`).join("")}
        </select>
        <input type="text" name="role" placeholder="Role">
        <button type="submit">Add</button>
      </form>
    </section>`;
}

export function teamMembersFragment(
  team: TeamData | null,
  agents: TeamAgentData[],
  availableAgents: AgentOptionData[],
  pollIntervalSeconds: PollIntervalSeconds,
): string {
  const content = team
    ? teamMembersContent(team, agents, availableAgents)
    : `<section class="card team-section"><p class="muted">Team not found.</p></section>`;
  const interval = team ? pollIntervalSeconds : 8;
  const endpoint = team ? `/fragments/teams/${escapeHtml(team.id)}/members` : "/fragments/teams/missing/members";
  return pollingRoot("team-members-fragment", endpoint, interval, content);
}

// --- Escalations ---

export interface EscalationData {
  id: string;
  agent_id: string;
  task_id: string;
  type: string;
  question: string;
  response: string | null;
  status: string;
  created_at: string;
  task_status?: string;
}

export function escalationsPage(escalations: EscalationData[]): string {
  const open = escalations.filter((e) => e.status === "open");
  const resolved = escalations.filter((e) => e.status === "resolved");

  return layout(
    "Escalations",
    `<h1>Escalations</h1>

    <h2>Open (${open.length})</h2>
    <div id="escalation-list" hx-ext="sse" sse-connect="/events/escalations" sse-swap="escalation:created" hx-swap="afterbegin">
      ${open.length === 0 ? `<div class="empty-state"><div class="empty-state-icon">&#9989;</div><p>No open escalations</p><p class="muted">All clear — no agents need help right now</p></div>` : open.map(escalationCard).join("")}
    </div>

    <h2>Resolved (${resolved.length})</h2>
    ${resolved.length === 0 ? `<div class="empty-state"><div class="empty-state-icon">&#128172;</div><p>No resolved escalations</p></div>` : resolved.map(escalationCard).join("")}`,
    "/escalations",
  );
}

function escalationCard(esc: EscalationData): string {
  const taskStatus = esc.task_status ? ` (${escapeHtml(esc.task_status)})` : "";
  return `<div class="card escalation-card">
    <div class="escalation-header">
      <span class="badge badge-${esc.status}">${esc.status}</span>
      <span class="badge">${escapeHtml(esc.type)}</span>
      <span class="muted">${formatTimestamp(esc.created_at)}</span>
    </div>
    <div class="escalation-question"><strong>Question:</strong> ${escapeHtml(esc.question)}</div>
    <div class="muted">Agent: ${escapeHtml(esc.agent_id.slice(0, 8))} | Task: ${escapeHtml(esc.task_id.slice(0, 8))}${taskStatus}</div>
    ${esc.status === "open" ? `<form hx-post="/api/escalations/${escapeHtml(esc.id)}/resolve" hx-target="body" hx-swap="innerHTML" class="escalation-form">
      <textarea name="response" placeholder="Type your response..." rows="3" required></textarea>
      <button type="submit">Respond</button>
    </form>` : `<div class="escalation-response"><strong>Response:</strong> ${esc.response ? escapeHtml(esc.response) : "-"}</div>`}
  </div>`;
}

// --- Events Audit Log ---

export function auditEventsPage(events: AuditEventData[], filters: AuditEventFilters = {}): string {
  return layout(
    "Events Audit Log",
    `<h1>Events Audit Log</h1>

    <div class="card">
      <form hx-get="/audit-events" hx-target="body" hx-push-url="true" class="inline-form" style="flex-wrap:wrap">
        <label>Type <input type="text" name="type" value="${filters.type ? escapeHtml(filters.type) : ""}" placeholder="e.g. task:state_changed"></label>
        <label>Task ID <input type="text" name="task_id" value="${filters.task_id ? escapeHtml(filters.task_id) : ""}" placeholder="Task ID"></label>
        <label>Agent ID <input type="text" name="agent_id" value="${filters.agent_id ? escapeHtml(filters.agent_id) : ""}" placeholder="Agent ID"></label>
        <button type="submit">Filter</button>
        <a href="/audit-events" hx-get="/audit-events" hx-target="body" hx-push-url="true" style="margin-left:0.5rem">Clear</a>
      </form>
    </div>

    <div id="event-list">
      ${auditEventsTableFragment(events)}
    </div>`,
    "/audit-events",
  );
}

export function auditEventsTableFragment(events: AuditEventData[]): string {
  if (events.length === 0) return `<div class="empty-state"><div class="empty-state-icon">&#128240;</div><p>No events found</p></div>`;
  return `<table class="data-table">
    <thead><tr><th>ID</th><th>Type</th><th>Source Agent</th><th>Task</th><th>Payload</th><th>Timestamp</th></tr></thead>
    <tbody>${events.map(auditEventRow).join("")}</tbody>
  </table>`;
}

function auditEventRow(e: AuditEventData): string {
  const payload = e.payload.length > 120 ? e.payload.slice(0, 120) + "…" : e.payload;
  return `<tr>
    <td>${e.id}</td>
    <td><code>${escapeHtml(e.type)}</code></td>
    <td>${e.source_agent_id ? escapeHtml(e.source_agent_id.slice(0, 8)) : "-"}</td>
    <td>${e.task_id ? escapeHtml(e.task_id.slice(0, 8)) : "-"}</td>
    <td class="muted"><code>${escapeHtml(payload)}</code></td>
    <td>${formatTimestamp(e.created_at)}</td>
  </tr>`;
}

// --- Logs ---

export interface LogEntryData {
  id: number;
  agent_id: string;
  agent_name: string;
  session_id: string | null;
  stream: string;
  data: string;
  sequence: number;
  created_at: string;
}

export interface LogFilters {
  agent_id?: string;
  stream?: string;
}

export function logsPage(entries: LogEntryData[], filters: LogFilters = {}, agents: { id: string; name: string }[] = []): string {
  return layout(
    "Agent Logs",
    `<h1>Agent Logs</h1>

    <div class="card">
      <form hx-get="/logs" hx-target="body" hx-push-url="true" class="inline-form" style="flex-wrap:wrap">
        <label>Agent
          <select name="agent_id">
            <option value="">All agents</option>
            ${agents.map((a) => `<option value="${escapeHtml(a.id)}"${filters.agent_id === a.id ? " selected" : ""}>${escapeHtml(a.name)}</option>`).join("")}
          </select>
        </label>
        <label>Stream
          <select name="stream">
            <option value="">All streams</option>
            <option value="stdout"${filters.stream === "stdout" ? " selected" : ""}>stdout</option>
            <option value="stderr"${filters.stream === "stderr" ? " selected" : ""}>stderr</option>
          </select>
        </label>
        <button type="submit">Filter</button>
        <a href="/logs" hx-get="/logs" hx-target="body" hx-push-url="true" style="margin-left:0.5rem">Clear</a>
      </form>
    </div>

    <div id="log-entries">
      ${logsTableFragment(entries)}
    </div>`,
    "/logs",
  );
}

export function logsTableFragment(entries: LogEntryData[]): string {
  if (entries.length === 0) {
    return `<div class="empty-state"><div class="empty-state-icon">&#128196;</div><p>No log entries found</p><p class="muted">Logs appear here when agents produce output</p></div>`;
  }
  return `<table class="data-table">
    <thead><tr><th>Agent</th><th>Stream</th><th>Output</th><th>Timestamp</th></tr></thead>
    <tbody>${entries.map(logEntryRow).join("")}</tbody>
  </table>`;
}

function logEntryRow(e: LogEntryData): string {
  const truncated = e.data.length > 200 ? e.data.slice(0, 200) + "…" : e.data;
  return `<tr>
    <td><a href="/agents/${escapeHtml(e.agent_id)}" hx-get="/agents/${escapeHtml(e.agent_id)}" hx-target="body" hx-push-url="true">${escapeHtml(e.agent_name)}</a></td>
    <td><span class="badge badge-${e.stream === "stderr" ? "error" : "running"}">${escapeHtml(e.stream)}</span></td>
    <td><code class="terminal-${escapeHtml(e.stream)}">${escapeHtml(truncated)}</code></td>
    <td>${formatTimestamp(e.created_at)}</td>
  </tr>`;
}

// --- Skipper Config ---

export function skipperConfigPage(
  config: SkipperConfig,
  agentTypes: { name: string; available_models: string }[],
): string {
  const typeOptions = agentTypes
    .map((t) => `<option value="${escapeHtml(t.name)}"${t.name === config.agent_type ? " selected" : ""}>${escapeHtml(t.name)}</option>`)
    .join("");

  const currentType = agentTypes.find((t) => t.name === config.agent_type);
  const models: string[] = currentType ? JSON.parse(currentType.available_models) : [];
  const modelOptions = models.length > 0
    ? models.map((m) => `<option value="${escapeHtml(m)}"${m === config.model ? " selected" : ""}>${escapeHtml(m)}</option>`).join("")
      + `<option value="default"${config.model === "default" ? " selected" : ""}>default</option>`
    : `<option value="default" selected>default</option>`;

  const typeModelsMap: Record<string, string[]> = {};
  for (const t of agentTypes) {
    typeModelsMap[t.name] = JSON.parse(t.available_models);
  }

  // Read the Skipper prompt for display
  let skipperPrompt = "";
  try {
    skipperPrompt = readFileSync(SKIPPER_PROMPT_PATH, "utf-8");
  } catch {
    skipperPrompt = "(Could not load prompt)";
  }

  return layout(
    "Skipper",
    `<h1>Skipper</h1>
    <p class="muted">Skipper is the lead orchestration agent. It receives all tasks and coordinates your team.</p>

    <div class="card">
      <h2>Configuration</h2>
      <form hx-put="/api/skipper/config" hx-target="body" hx-swap="innerHTML">
        <label>CLI Type
          <select name="agent_type" id="skipper-type" onchange="skipperUpdateModels('skipper', this.value)">
            ${typeOptions}
          </select>
        </label>
        <label>Model
          <select name="model" id="agent-model-skipper">
            ${modelOptions}
          </select>
        </label>
        <script>
          window.__skipperAgentModels = ${JSON.stringify(typeModelsMap)};
          function skipperUpdateModels(suffix, type) {
            var sel = document.getElementById('agent-model-' + suffix);
            var models = (window.__skipperAgentModels || {})[type] || [];
            if (models.length === 0) {
              sel.innerHTML = '<option value="default">default</option>';
            } else {
              sel.innerHTML = models.map(function(m) { return '<option value="' + m + '">' + m + '</option>'; }).join('') + '<option value="default">default</option>';
            }
          }
        </script>
        <button type="submit">Save</button>
      </form>
    </div>

    <div class="card">
      <h2>System Prompt</h2>
      <p class="muted">This prompt is sent to Skipper at the start of every task. It is not user-editable.</p>
      <pre style="white-space:pre-wrap;background:var(--bg-secondary);padding:1rem;border-radius:6px;font-size:0.85rem;">${escapeHtml(skipperPrompt)}</pre>
    </div>`,
    "/skipper",
  );
}

// --- Help ---

export function helpPage(): string {
  return layout(
    "Help",
    `<h1>Skipper Help</h1>

    <div class="card">
      <h2>Platform Overview</h2>
      <p>Skipper is an AI agent orchestrator that coordinates teams of agents to complete structured work.
      It manages task lifecycles, delegates work between agents (including parallel fan-out), handles multi-phase execution, and escalates to humans when needed.</p>
    </div>

    <h2>Core Concepts</h2>

    <div class="card">
      <h3>Task Lifecycle</h3>
      <p>Every task progresses through a series of states:</p>
      <pre class="help-diagram">
  draft ──&gt; approved ──&gt; running ──&gt; completed
                         │
                         └──&gt; failed ──&gt; (retry) ──&gt; draft ──&gt; approved
      </pre>
      <p>Tasks start as <strong>draft</strong>, must be <strong>approved</strong> before the daemon picks them up,
      run until <strong>completed</strong> or <strong>failed</strong>, and failed tasks can be retried (retry returns them to <strong>draft</strong>).</p>
      <p>Canceling a task marks it <strong>failed</strong> with a cancellation reason.</p>
    </div>

    <div class="card">
      <h3>Team Hierarchy</h3>
      <p>Teams organize agents into a hierarchy with an entrypoint agent that receives tasks first:</p>
      <pre class="help-diagram">
              ┌─────────────┐
              │    Team      │
              └──────┬───────┘
                     │
          ┌──────────┴──────────┐
          │  Entrypoint Agent   │  (level 0, receives tasks)
          └──────────┬──────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ Agent A  │ │ Agent B  │ │ Agent C  │  (can be delegated to)
   │ senior   │ │ mid-level│ │ junior   │
   └─────────┘ └─────────┘ └─────────┘
      </pre>
    </div>

    <div class="card">
      <h3>Phase Execution</h3>
      <p>Tasks can have multiple phases that execute sequentially. Each phase has its own prompt and is assigned to the team's entrypoint agent:</p>
      <pre class="help-diagram">
  Phase 0        Phase 1        Phase 2
  ┌──────┐      ┌──────┐      ┌──────┐
  │Discover│ ──&gt; │Execute│ ──&gt; │Validate│ ──&gt; Complete
  └──────┘      └──────┘      └──────┘
     │             │             │
  agent runs    agent runs    agent runs
  &amp; signals     &amp; signals     &amp; exits 0
  PHASE_COMPLETE PHASE_COMPLETE
      </pre>
    </div>

    <div class="card">
      <h3>Delegation Flow</h3>
      <p>A parent agent can delegate subtasks to child agents on the same team. Delegation pauses the parent
      (state: <strong>waiting_delegation</strong>) until results return:</p>
      <pre class="help-diagram">
  Parent Agent                    Child Agent
  ┌───────────┐                  ┌───────────┐
  │ Working   │                  │           │
  │ on task   │  [DELEGATE]      │           │
  │           │ ───────────────&gt; │  Spawned  │
  │ (paused)  │                  │  with     │
  │           │                  │  prompt   │
  │           │  [DELEGATE_COMPLETE] result
  │ Resumed   │ &lt;─────────────── │  Exits    │
  │ with      │                  │           │
  │ context   │                  └───────────┘
  └───────────┘
      </pre>
      <p>For parallel fan-out, a parent can delegate multiple workers in a single barrier:</p>
      <pre class="help-diagram">
  Parent Agent                          Child Agents (parallel)
  ┌───────────┐                         ┌───────────┐
  │ Working   │  [DELEGATE_BATCH] ────&gt; │ Child A   │
  │ on task   │                         │ Child B   │
  │ (paused)  │                         │ Child C   │
  └───────────┘                         └───────────┘
        ▲                                     │
        └────── [DELEGATION_BATCH_RESULT] ────┘
      </pre>
      <ul style="margin:0.5rem 0 0 1.5rem">
        <li>Max delegation depth: 3</li>
        <li>Max delegations per parent per task: 20</li>
        <li>Batch size limit: 8</li>
        <li>Only one active delegation group per parent at a time</li>
        <li>Delegations time out after 10 minutes and may retry once</li>
      </ul>
      <p>Parent agents are resumed with <code>[DELEGATION_RESULT]</code> (single) or <code>[DELEGATION_BATCH_RESULT]</code> (parallel).</p>
    </div>

    <div class="card">
      <h3>Escalation Flow</h3>
      <p>When an agent needs human input, it escalates via a signal:</p>
      <pre class="help-diagram">
  Agent                Human (UI)
  ┌───────────┐       ┌───────────┐
  │ Working   │       │           │
  │           │       │           │
  │ [ESCALATE]│ ────&gt; │ Question  │
  │           │       │ appears   │
  │ (paused)  │       │           │
  │           │       │ Types     │
  │ Resumed   │ &lt;──── │ response  │
  │ with      │       │           │
  │ answer    │       └───────────┘
  └───────────┘
      </pre>
    </div>

    <h2>Signal System</h2>

    <div class="card">
      <p>Agents communicate with Skipper by printing signals to stdout (or embedding them in JSON output). The daemon parses these in real time:</p>
      <table class="data-table">
        <thead><tr><th>Signal</th><th>Format</th><th>Description</th></tr></thead>
        <tbody>
          <tr>
            <td><code>[PHASE_COMPLETE]</code></td>
            <td><code>[PHASE_COMPLETE]</code></td>
            <td>Current phase finished successfully; advance to next phase</td>
          </tr>
          <tr>
            <td><code>[PHASE_REGRESSION]</code></td>
            <td><code>[PHASE_REGRESSION N] reason text</code></td>
            <td>Regress to an earlier phase index with a reason</td>
          </tr>
          <tr>
            <td><code>[DELEGATE]</code></td>
            <td><code>[DELEGATE to:agent-id] prompt text</code></td>
            <td>Delegate a subtask to another agent on the team</td>
          </tr>
          <tr>
            <td><code>[DELEGATE_BATCH]</code></td>
            <td><code>[DELEGATE_BATCH] [{"to":"agent-id","work":"...","label":"optional"}]</code></td>
            <td>Delegate parallel work items in a single barrier</td>
          </tr>
          <tr>
            <td><code>[DELEGATE_COMPLETE]</code></td>
            <td><code>[DELEGATE_COMPLETE] result text</code></td>
            <td>Finish a delegated assignment and return result to parent</td>
          </tr>
          <tr>
            <td><code>[ESCALATE]</code></td>
            <td><code>[ESCALATE] question text</code></td>
            <td>Ask a human for help; agent pauses until response</td>
          </tr>
          <tr>
            <td><code>[NOTE]</code></td>
            <td><code>[NOTE] content text</code></td>
            <td>Attach a note to the current task for logging/context</td>
          </tr>
          <tr>
            <td><code>[ARTIFACT]</code></td>
            <td><code>[ARTIFACT] name|type|content_or_path</code></td>
            <td>Register a file, log, or report as a task artifact</td>
          </tr>
          <tr>
            <td><code>[TASK_COMPLETE]</code></td>
            <td><code>[TASK_COMPLETE task:task-id] result text</code></td>
            <td>Explicitly complete a task immediately</td>
          </tr>
          <tr>
            <td><code>[MSG]</code></td>
            <td><code>[MSG:type to:agent] content</code></td>
            <td>Send an agent-to-agent message (logged for audit)</td>
          </tr>
        </tbody>
      </table>
      <p style="margin-top:0.6rem">Parents are resumed with <code>[DELEGATION_RESULT]</code> or <code>[DELEGATION_BATCH_RESULT]</code> payloads; these are system messages, not signals to emit.</p>
    </div>

    <h2>Features Guide</h2>

    <div class="card">
      <h3>Dashboard</h3>
      <p>The <a href="/">Dashboard</a> is centered on live orchestration control and awareness:
      daemon kill switch, current active task, runtime/delegation activity, and recent activity feed.</p>
    </div>

    <div class="card">
      <h3>Tasks</h3>
      <p>The <a href="/tasks">Tasks</a> page lets you create, approve, cancel, and retry tasks. Click a task to see its
      detail view with notes, delegations, artifacts, and a phase stepper showing execution progress.</p>
    </div>

    <div class="card">
      <h3>Agents</h3>
      <p>The <a href="/agents">Agents</a> page lets you create agents with clear instructions and capabilities.
      Each agent detail page shows live terminal output and current runtime status.</p>
    </div>

    <div class="card">
      <h3>Teams</h3>
      <p>The <a href="/teams">Teams</a> page lets you create teams, add agents with roles and skill levels,
      and define execution phases. Each phase has a name and prompt that the entrypoint agent receives.</p>
    </div>

    <div class="card">
      <h3>Escalations</h3>
      <p>The <a href="/escalations">Escalations</a> page shows open agent questions that need human responses.
      Type a response and submit to resume the paused agent with your answer.</p>
    </div>

    <div class="card">
      <h3>Audit Events</h3>
      <p>The <a href="/audit-events">Events</a> page provides a filterable log of all system events.
      Filter by event type, task ID, or agent ID to trace what happened and when.</p>
    </div>

    <h2>Daemon Controls</h2>

    <div class="card">
      <p>The daemon is the orchestration engine that runs the tick loop (every 30 seconds). Control it from the Dashboard:</p>
      <ul style="margin:0.5rem 0 0 1.5rem">
        <li><strong>Running</strong> &mdash; actively picking up approved tasks and executing them</li>
        <li><strong>Paused</strong> &mdash; stops picking up new tasks; in-flight work continues until current agent exits</li>
        <li><strong>Stopped</strong> &mdash; daemon is not running</li>
      </ul>
      <p style="margin-top:0.5rem">Only one task runs at a time. The daemon assigns the highest-priority approved task to the team's entrypoint agent.</p>
    </div>

    <h2>Workflow Example</h2>

    <div class="card">
      <p>End-to-end walkthrough of using Skipper:</p>
      <ol style="margin:0.5rem 0 0 1.5rem;line-height:2">
        <li>Go to <a href="/agents">Agents</a> and create one or more agents with clear instructions</li>
        <li>Go to <a href="/teams">Teams</a> and create a team, then add your agents to it</li>
        <li>Set the entrypoint agent and add phases (e.g. "Discovery", "Execution", "Validation")</li>
        <li>Go to <a href="/tasks">Tasks</a> and create a new task, assigning it to your team</li>
        <li>Approve the task &mdash; the daemon will pick it up on the next tick</li>
        <li>Watch the entrypoint agent's terminal output on its <a href="/agents">detail page</a></li>
        <li>If the agent escalates, respond on the <a href="/escalations">Escalations</a> page</li>
        <li>Track progress via the phase stepper on the task detail page</li>
        <li>View the completed task's notes, artifacts, and delegation history</li>
      </ol>
    </div>`,
    "/help",
  );
}

// --- Utility ---

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function baseStyles(): string {
  return `
    :root {
      --bg-0: #090814;
      --bg-1: #120a24;
      --panel: rgba(14, 14, 30, 0.88);
      --panel-alt: rgba(9, 16, 37, 0.9);
      --text: #e8ecff;
      --muted: #9ca7c8;
      --accent-cyan: #35f4ff;
      --accent-magenta: #ff4fd8;
      --accent-yellow: #ffd86e;
      --danger: #ff6a8e;
      --success: #3df59c;
      --border: rgba(92, 119, 191, 0.42);
      --glow: 0 0 0.6rem rgba(53, 244, 255, 0.45), 0 0 1.2rem rgba(255, 79, 216, 0.2);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: "Verdana", "Tahoma", "Geneva", sans-serif;
      background:
        radial-gradient(circle at 12% 14%, rgba(255, 79, 216, 0.12), transparent 40%),
        radial-gradient(circle at 82% 10%, rgba(53, 244, 255, 0.14), transparent 36%),
        linear-gradient(165deg, var(--bg-0) 0%, var(--bg-1) 48%, #170f2d 100%);
      color: var(--text);
      line-height: 1.55;
      min-height: 100vh;
      position: relative;
      overflow-x: hidden;
    }
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background: repeating-linear-gradient(
        to bottom,
        rgba(255, 255, 255, 0.02) 0px,
        rgba(255, 255, 255, 0.02) 1px,
        transparent 1px,
        transparent 3px
      );
      opacity: 0.18;
      mix-blend-mode: soft-light;
      z-index: -1;
    }
    a { color: var(--accent-cyan); text-decoration: none; }
    a:hover { color: #94fbff; text-decoration: none; }

    .navbar {
      display: flex;
      align-items: center;
      gap: 2rem;
      padding: 0.8rem 1.5rem;
      background: linear-gradient(180deg, rgba(21, 17, 43, 0.92), rgba(10, 10, 24, 0.92));
      border-bottom: 1px solid var(--border);
      box-shadow: inset 0 -1px 0 rgba(255, 79, 216, 0.2), 0 0.2rem 1.2rem rgba(0, 0, 0, 0.35);
      position: sticky;
      top: 0;
      backdrop-filter: blur(5px);
      z-index: 20;
    }
    .brand {
      font-family: "Arial Black", "Impact", "Trebuchet MS", sans-serif;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 1.08rem;
      color: #fff;
      text-shadow: 0 0 0.45rem rgba(255, 79, 216, 0.72), 0 0 0.9rem rgba(53, 244, 255, 0.38);
    }
    .nav-links { display: flex; gap: 0.95rem; flex-wrap: wrap; }
    .nav-links a {
      color: var(--muted);
      padding: 0.24rem 0;
      border-bottom: 2px solid transparent;
      transition: color 0.18s, border-color 0.18s, text-shadow 0.18s;
    }
    .nav-links a:hover { color: var(--text); }
    .nav-links a.active {
      color: var(--accent-cyan);
      border-bottom-color: var(--accent-magenta);
      text-shadow: var(--glow);
    }

    .container { max-width: 1200px; margin: 0 auto; padding: 1.5rem; }
    h1, h2, h3 {
      font-family: "Arial Black", "Trebuchet MS", "Tahoma", sans-serif;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      text-shadow: 0 0 0.3rem rgba(53, 244, 255, 0.24);
    }
    h1 { margin-bottom: 1rem; color: #f7f9ff; font-size: clamp(1.9rem, 2.5vw, 2.4rem); }
    h2 { margin: 1.3rem 0 0.7rem; color: #edf2ff; font-size: clamp(1.2rem, 1.9vw, 1.45rem); }
    h3 { margin: 1rem 0 0.45rem; color: #dce7ff; }

    .card, .stat-card, .active-task-card, .phase-stepper, .team-hero, .phase-card, .member-card, .activity-feed {
      background: linear-gradient(180deg, var(--panel) 0%, var(--panel-alt) 100%);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: inset 0 0 0 1px rgba(255, 79, 216, 0.08), 0 0.55rem 1.6rem rgba(0, 0, 0, 0.24);
    }
    .card { padding: 0.95rem; margin-bottom: 1rem; }

    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .stat-card { padding: 1rem; text-align: center; }
    .stat-value { font-size: 2rem; font-weight: 800; color: var(--accent-cyan); text-shadow: var(--glow); }
    .stat-label { color: var(--muted); font-size: 0.86rem; }
    .dashboard-toolbar { display: flex; justify-content: center; margin-bottom: 1rem; }
    .daemon-card { display: flex; align-items: center; gap: 0.5rem; padding: 0.62rem 0.82rem; }
    .daemon-killswitch { width: 100%; justify-content: center; gap: 0.8rem; flex-wrap: wrap; }
    .daemon-meta { min-width: 180px; }
    .daemon-title { font-family: "Arial Black", "Trebuchet MS", "Tahoma", sans-serif; letter-spacing: 0.03em; text-transform: uppercase; font-size: 0.9rem; color: #f3f6ff; }
    .daemon-kill-btn { min-width: 170px; font-size: 0.84rem; padding: 0.42rem 0.85rem; }
    .daemon-pausing { font-weight: 700; letter-spacing: 0.02em; }
    .dashboard-grid { display: grid; grid-template-columns: 0.95fr 1.05fr; gap: 1rem; margin-bottom: 1rem; }
    .dashboard-panel { margin-bottom: 0; }
    .dashboard-panel-head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem; margin-bottom: 0.6rem; }
    .dashboard-panel-head h2 { margin: 0; }
    .active-task-card { padding: 0.85rem 0.95rem; }
    .status-list { padding: 0.2rem 0.15rem; }
    .active-task-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem; }
    .active-task-title { display: block; font-size: 1.02rem; font-weight: 700; margin-bottom: 0.28rem; color: #b4fbff; }
    .status-row { display: grid; grid-template-columns: auto minmax(120px, 1fr) auto auto; align-items: center; gap: 0.5rem; padding: 0.5rem 0.35rem; border-bottom: 1px solid rgba(109, 128, 190, 0.28); }
    .status-row:last-child { border-bottom: none; }
    .status-agent { font-weight: 700; color: var(--accent-cyan); }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    .list-item { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid rgba(109, 128, 190, 0.26); }
    .list-item:last-child { border-bottom: none; }

    .badge {
      display: inline-block;
      padding: 0.14rem 0.5rem;
      border-radius: 999px;
      font-size: 0.74rem;
      font-weight: 700;
      text-transform: lowercase;
      border: 1px solid rgba(166, 182, 230, 0.24);
      background: rgba(44, 52, 84, 0.56);
      color: var(--muted);
    }
    .badge-idle { background: rgba(64, 72, 108, 0.34); color: #b3b8cd; }
    .badge-busy, .badge-running { background: rgba(53, 244, 255, 0.14); color: var(--accent-cyan); border-color: rgba(53, 244, 255, 0.42); box-shadow: 0 0 0.7rem rgba(53, 244, 255, 0.24); }
    .badge-error, .badge-failed { background: rgba(255, 106, 142, 0.16); color: #ff88a6; border-color: rgba(255, 106, 142, 0.42); }
    .badge-stopped { background: rgba(255, 216, 110, 0.16); color: var(--accent-yellow); border-color: rgba(255, 216, 110, 0.38); }
    .badge-draft, .badge-pending { background: rgba(172, 139, 255, 0.12); color: #c7b7ff; }
    .badge-approved, .badge-completed, .badge-resolved { background: rgba(61, 245, 156, 0.14); color: var(--success); border-color: rgba(61, 245, 156, 0.35); }
    .badge-open { background: rgba(255, 106, 142, 0.16); color: #ff88a6; }
    .badge-system { background: rgba(172, 139, 255, 0.18); color: #c7b7ff; border-color: rgba(172, 139, 255, 0.4); }

    .priority { color: var(--accent-yellow); font-size: 0.86rem; margin-left: auto; }
    .muted { color: var(--muted); font-size: 0.86rem; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }

    .data-table { width: 100%; border-collapse: collapse; }
    .data-table th { text-align: left; padding: 0.54rem; border-bottom: 2px solid rgba(109, 128, 190, 0.45); color: #c4d0f3; font-size: 0.86rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .data-table td { padding: 0.54rem; border-bottom: 1px solid rgba(109, 128, 190, 0.24); }
    .data-table tbody tr { transition: background-color 0.15s; }
    .data-table tbody tr:hover { background-color: rgba(53, 244, 255, 0.06); }

    .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
    .detail-desc { margin-top: 1rem; }
    .detail-desc pre, details.artifact-content pre, .help-diagram {
      background: rgba(7, 10, 22, 0.92);
      border: 1px solid rgba(109, 128, 190, 0.38);
      border-radius: 8px;
      overflow-x: auto;
      color: #d9e7ff;
      font-family: "Lucida Console", "Consolas", "Courier New", monospace;
    }
    .detail-desc pre { padding: 0.75rem; font-size: 0.875rem; margin-top: 0.25rem; }

    button, .btn-sm {
      background: linear-gradient(90deg, #2f7aff 0%, #4a78e8 52%, #5a68c9 100%);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.18);
      padding: 0.48rem 1rem;
      border-radius: 9px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 700;
      letter-spacing: 0.02em;
      transition: filter 0.15s, transform 0.1s, box-shadow 0.15s;
      box-shadow: 0 0 0.55rem rgba(74, 120, 232, 0.32);
    }
    button:hover { filter: brightness(1.06); box-shadow: 0 0 0.85rem rgba(90, 104, 201, 0.34); }
    button:active { transform: translateY(1px); }
    .btn-sm { padding: 0.24rem 0.55rem; font-size: 0.75rem; }
    .btn-danger { background: linear-gradient(90deg, #b94a74 0%, #cf5b7f 100%); }
    .btn-disabled, button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      box-shadow: none;
      filter: none;
    }
    .card-error {
      border-color: rgba(255, 106, 142, 0.45);
      background: linear-gradient(180deg, rgba(52, 17, 35, 0.92) 0%, rgba(40, 12, 28, 0.92) 100%);
    }
    .error { color: #ff9ab2; font-weight: 700; }

    form label { display: block; margin-bottom: 0.75rem; color: #d5ddf5; font-size: 0.875rem; }
    form input, form textarea, form select {
      display: block;
      width: 100%;
      margin-top: 0.25rem;
      padding: 0.5rem;
      background: rgba(8, 12, 26, 0.96);
      border: 1px solid rgba(109, 128, 190, 0.42);
      border-radius: 8px;
      color: var(--text);
      font-size: 0.875rem;
      transition: border-color 0.18s, box-shadow 0.18s;
      outline: none;
    }
    form input:focus, form textarea:focus, form select:focus {
      border-color: var(--accent-cyan);
      box-shadow: 0 0 0 2px rgba(53, 244, 255, 0.25), var(--glow);
    }
    .inline-form { display: flex; gap: 0.5rem; align-items: flex-end; }
    .inline-form input, .inline-form select { width: auto; min-width: 220px; }

    .terminal {
      background: rgba(5, 7, 18, 0.95);
      border: 1px solid rgba(109, 128, 190, 0.4);
      border-radius: 10px;
      padding: 0.42rem;
      max-height: 500px;
      overflow-y: auto;
      font-family: "Lucida Console", "Consolas", "Courier New", monospace;
      font-size: 0.8rem;
      line-height: 1.25;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .terminal-line { padding: 0; margin: 0; }
    .terminal-stdout { color: #d9e7ff; }
    .terminal-stderr { color: #ff8aac; }
    .terminal-json {
      margin: 0.04rem 0;
      padding: 0.16rem 0.24rem;
      border: 1px solid rgba(109, 128, 190, 0.45);
      border-radius: 7px;
      background: rgba(8, 14, 30, 0.94);
      color: #d9e7ff;
      white-space: normal;
    }
    .terminal-json-header { display: flex; align-items: center; gap: 0.22rem; margin-bottom: 0.04rem; flex-wrap: wrap; }
    .badge-json-type { background: rgba(255, 79, 216, 0.16); color: #ff9ae7; border-color: rgba(255, 79, 216, 0.35); }
    .terminal-json-summary { color: #acb7da; font-size: 0.74rem; line-height: 1.2; }
    .terminal-json-details { margin: 0; line-height: 1; }
    .terminal-json-details > summary { cursor: pointer; color: #acb7da; font-size: 0.71rem; text-transform: uppercase; letter-spacing: 0.03em; list-style: none; }
    .terminal-json-details > summary::-webkit-details-marker { display: none; }
    .terminal-json-body {
      margin: 0.12rem 0 0;
      background: rgba(4, 8, 20, 0.98);
      border: 1px solid rgba(109, 128, 190, 0.36);
      border-radius: 6px;
      padding: 0.22rem 0.3rem;
      overflow-x: auto;
      white-space: pre;
      word-break: normal;
      font-size: 0.72rem;
      line-height: 1.18;
    }

    .escalation-card { margin-bottom: 0.75rem; }
    .escalation-header { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
    .escalation-question { margin-bottom: 0.5rem; }
    .escalation-response { margin-top: 0.5rem; padding: 0.5rem; background: rgba(61, 245, 156, 0.1); border: 1px solid rgba(61, 245, 156, 0.3); border-radius: 7px; }
    .escalation-form textarea { margin-bottom: 0.5rem; }

    .phase-stepper { margin: 1rem 0; padding: 0.95rem; }
    .phase-summary { display: flex; justify-content: space-between; align-items: center; color: var(--muted); font-size: 0.82rem; margin-bottom: 0.52rem; }
    .phase-progress { width: 100%; height: 8px; background: rgba(57, 67, 101, 0.7); border-radius: 999px; overflow: hidden; margin-bottom: 0.86rem; }
    .phase-progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent-cyan) 0%, var(--accent-magenta) 100%); border-radius: 999px; transition: width 0.25s ease; box-shadow: 0 0 0.9rem rgba(255, 79, 216, 0.4); }
    .phase-grid { display: grid; grid-template-columns: repeat(var(--phase-cols, 3), minmax(0, 1fr)); gap: 0.58rem; }
    .phase-step { display: flex; flex-direction: column; align-items: flex-start; gap: 0.46rem; padding: 0.62rem 0.68rem; border: 1px solid rgba(109, 128, 190, 0.35); border-radius: 10px; background: rgba(8, 14, 30, 0.9); min-width: 0; }
    .phase-circle { width: 30px; height: 30px; border-radius: 999px; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 800; }
    .phase-name { font-size: 0.82rem; line-height: 1.22; overflow-wrap: anywhere; }
    .phase-step-done { border-color: rgba(61, 245, 156, 0.45); background: rgba(61, 245, 156, 0.08); }
    .phase-step-done .phase-circle { background: rgba(61, 245, 156, 0.25); color: #d8ffec; }
    .phase-step-active { border-color: rgba(53, 244, 255, 0.62); background: rgba(53, 244, 255, 0.12); box-shadow: 0 0 0 1px rgba(53, 244, 255, 0.2) inset; }
    .phase-step-active .phase-circle { background: rgba(53, 244, 255, 0.2); color: #e9fdff; box-shadow: 0 0 0.75rem rgba(53, 244, 255, 0.44); }
    .phase-step-pending { border-color: rgba(109, 128, 190, 0.34); background: rgba(8, 14, 30, 0.9); }
    .phase-step-pending .phase-circle { background: rgba(86, 96, 132, 0.45); color: #bcc6e4; }
    .phase-step-failed { border-color: rgba(255, 106, 142, 0.5); background: rgba(255, 106, 142, 0.1); }
    .phase-step-failed .phase-circle { background: rgba(255, 106, 142, 0.2); color: #ffb9cb; }

    .artifact-card { margin-bottom: 0.75rem; }
    .artifact-header { display: flex; gap: 0.5rem; align-items: center; }
    .artifact-path { margin-top: 0.25rem; }
    .badge-artifact-file { background: rgba(53, 244, 255, 0.13); color: #8bf9ff; }
    .badge-artifact-log { background: rgba(255, 216, 110, 0.12); color: #ffe3a4; }
    .badge-artifact-report { background: rgba(61, 245, 156, 0.12); color: #a6ffd5; }
    details.artifact-content { margin-top: 0.5rem; }
    details.artifact-content pre { padding: 0.75rem; font-size: 0.8rem; max-height: 300px; overflow-y: auto; }

    .help-diagram { padding: 1rem; font-size: 0.85rem; line-height: 1.35; color: #8eedff; }

    .loading-bar {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 3px;
      background: transparent;
      z-index: 9999;
      pointer-events: none;
    }
    .htmx-request .loading-bar, .htmx-request.loading-bar {
      background: linear-gradient(90deg, var(--accent-cyan) 0%, var(--accent-magenta) 45%, var(--accent-yellow) 100%);
      background-size: 200% 100%;
      animation: loading-slide 1.3s linear infinite;
      box-shadow: 0 0 0.8rem rgba(255, 79, 216, 0.42);
    }
    @keyframes loading-slide { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

    .session-selector { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem; }
    .session-selector select { width: auto; display: inline-block; }
    .empty-state { text-align: center; padding: 1.6rem 1rem; color: var(--muted); }
    .empty-state-icon { font-size: 2rem; margin-bottom: 0.35rem; opacity: 0.7; }
    .empty-state p { margin: 0.2rem 0; }

    .activity-feed { padding: 0.5rem 0.75rem; min-height: 60px; }
    .activity-feed-rich { background: linear-gradient(180deg, rgba(12, 16, 34, 0.95), rgba(8, 14, 30, 0.96)); border-color: rgba(109, 128, 190, 0.5); }
    .activity-entry { display: flex; align-items: baseline; gap: 0.45rem; padding: 0.34rem 0; border-bottom: 1px solid rgba(109, 128, 190, 0.26); flex-wrap: wrap; }
    .activity-entry-rich { align-items: center; padding: 0.38rem 0.08rem; }
    .activity-entry:last-child { border-bottom: none; }
    .activity-agent { font-weight: 700; color: var(--accent-cyan); font-size: 0.84rem; flex-shrink: 0; }
    .activity-data { color: #e4edff; font-size: 0.77rem; font-family: "Lucida Console", "Consolas", "Courier New", monospace; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .activity-time { flex-shrink: 0; }
    .badge-stream-stdout { background: rgba(53, 244, 255, 0.14); color: #8ff9ff; border-color: rgba(53, 244, 255, 0.34); }
    .badge-stream-stderr { background: rgba(255, 106, 142, 0.16); color: #ff9eb8; border-color: rgba(255, 106, 142, 0.34); }

    .terminal-section-header { display: flex; align-items: center; gap: 1rem; margin: 1.2rem 0 0.45rem; }
    .terminal-section-header h2 { margin: 0; }
    .terminal-line-count { font-size: 0.8rem; }

    .team-hero { margin: 0.5rem 0 1rem; padding: 1rem; }
    .team-hero h1 { margin: 0 0 0.4rem; }
    .team-hero-meta { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
    .team-layout { display: grid; grid-template-columns: 1.25fr 1fr; gap: 1rem; margin-bottom: 1rem; }
    .team-section { margin-bottom: 1rem; }
    .team-section-header { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.55rem; }
    .team-section-header h2 { margin: 0; }
    .badge-phase-index { background: rgba(53, 244, 255, 0.14); color: #a4fbff; border-color: rgba(53, 244, 255, 0.34); }

    .phase-card-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 0.75rem; }
    .phase-card { padding: 0.7rem; }
    .phase-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.4rem; }
    .phase-edit-form label { margin-bottom: 0.55rem; }
    .phase-edit-form textarea { min-height: 86px; resize: vertical; }
    .phase-card-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
    .phase-add { margin-top: 0.95rem; padding-top: 0.8rem; border-top: 1px solid rgba(109, 128, 190, 0.28); }

    .member-card-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 0.75rem; margin-bottom: 0.8rem; }
    .member-card { padding: 0.7rem; }
    .member-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; }
    .member-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.55rem; }
    .member-grid label { margin-bottom: 0.4rem; }
    .member-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.5rem; }

    .forensics-panel { margin: 1rem 0; }
    .forensics-summary { cursor: pointer; display: flex; align-items: center; gap: 0.6rem; padding: 0.7rem 0.95rem; background: linear-gradient(180deg, var(--panel) 0%, var(--panel-alt) 100%); border: 1px solid var(--border); border-radius: 12px; list-style: none; }
    .forensics-summary::-webkit-details-marker { display: none; }
    .forensics-panel[open] .forensics-summary { border-radius: 12px 12px 0 0; border-bottom: 1px solid rgba(109, 128, 190, 0.28); }
    .forensics-panel[open] .forensics-toggle-icon { transform: rotate(90deg); }
    .forensics-toggle-icon { display: inline-block; font-size: 0.7rem; transition: transform 0.2s; color: var(--accent-cyan); }
    .forensics-body { padding: 0.75rem 0.95rem; background: linear-gradient(180deg, var(--panel) 0%, var(--panel-alt) 100%); border: 1px solid var(--border); border-top: none; border-radius: 0 0 12px 12px; }
    .forensics-section { margin-bottom: 1rem; }
    .forensics-section:last-child { margin-bottom: 0; }
    .forensics-section h3 { margin: 0 0 0.5rem; }
    .forensics-timeline { border-left: 2px solid var(--border); margin-left: 0.5rem; padding-left: 0.75rem; }
    .forensics-timeline-entry { display: flex; align-items: flex-start; gap: 0.5rem; padding: 0.35rem 0; border-bottom: 1px solid rgba(109, 128, 190, 0.15); }
    .forensics-timeline-entry:last-child { border-bottom: none; }
    .forensics-time { flex-shrink: 0; font-size: 0.78rem; color: var(--muted); min-width: 70px; }
    .forensics-icon { flex-shrink: 0; font-size: 0.85rem; }
    .forensics-label { font-size: 0.84rem; flex: 1; min-width: 0; }
    .forensics-snapshot pre { max-height: 200px; overflow-y: auto; font-size: 0.75rem; padding: 0.5rem; margin-top: 0.25rem; background: rgba(7, 10, 22, 0.92); border: 1px solid rgba(109, 128, 190, 0.38); border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
    .forensics-instance-node { display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0; border-bottom: 1px solid rgba(109, 128, 190, 0.15); flex-wrap: wrap; }
    .forensics-instance-node:last-child { border-bottom: none; }
    .forensics-tail { max-height: 200px; overflow-y: auto; margin: 0; }

    @media (max-width: 900px) {
      .dashboard-grid { grid-template-columns: 1fr; }
      .dashboard-toolbar { justify-content: center; }
      .team-layout { grid-template-columns: 1fr; }
      .phase-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .phase-card-list { grid-template-columns: 1fr; }
      .member-card-list { grid-template-columns: 1fr; }
      .member-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }
    @media (max-width: 560px) { .phase-grid { grid-template-columns: 1fr; } .navbar { padding: 0.75rem 1rem; gap: 1rem; } .container { padding: 1rem; } }
  `;
}
