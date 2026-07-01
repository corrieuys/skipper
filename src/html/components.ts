// Server-rendered HTML components for HTMX UI
import type { RealtimeConfig } from "../realtime/config";
import { taskDetailSummaryContent } from "./taskDetailSummaryContent";
import { taskForensicsContent } from "./taskForensicsContent";
import { phaseStepper } from "./phaseStepper";
import { terminalJsonSummary } from "./terminalJsonSummary";
import { teamMembersContent } from "./teamMembersContent";
import { agentDetailSummaryContent } from "./agentDetailSummaryContent";
import { taskDelegationsContent } from "./taskDelegationsContent";
import { taskListFragment } from "./taskListFragment";
import { formatTimestamp } from "./formatTimestamp";

export const navItems: { href: string; label: string }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/tasks", label: "Tasks" },
  { href: "/config", label: "Configuration" },
  { href: "/templates", label: "Templates" },
  { href: "/logs", label: "Logs" },
  { href: "/help", label: "Help" },
];

export interface DaemonStatus {
  state: "running" | "pausing" | "paused" | "stopped";
  uptime: number;
}

export function daemonBadgeClass(state: DaemonStatus["state"]): string {
  if (state === "running") return "running";
  if (state === "pausing" || state === "paused") return "stopped";
  return "error";
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
  tasks: {
    id: string;
    title: string;
    status: string;
    task_type?: string;
    description?: string | null;
    created_at?: string;
  }[];
  teams?: { id: string; name: string }[];
  phaseIndicatorTask?: {
    id: string;
    title: string;
    status: string;
    current_phase: number;
    needs_review?: boolean | number;
    task_type?: string;
    phases?: { name: string; prompt: string; review?: boolean }[] | null;
  } | null;
  pollIntervalSeconds?: PollIntervalSeconds;
  realtimeConfig?: RealtimeConfig;
  realtimeTimeline?: {
    taskId: string;
    taskTitle: string;
    entries: {
      id: string;
      entry_type: string;
      content: string;
      priority?: string;
      created_at: string;
    }[];
  } | null;
  agents: {
    id: string;
    name: string;
    status: string;
    current_task_id: string | null;
  }[];
  daemon: DaemonStatus;
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
  activeTeamAgents?: {
    id: string;
    name: string;
    template_agent_id: string;
    is_active: number;
  }[];
  activeTeamName?: string | null;
  activeDelegationGroups?: {
    id: string;
    task_id: string;
    parent_instance_id: string;
    settled_count: number;
    expected_count: number;
    failed_count: number;
    status: string;
    created_at: string;
    completed_at?: string | null;
  }[];
  recentLogs?: RecentLogEntry[];
  dashboardSteeringOptions?: {
    template_agent_id: string;
    agent_name: string;
    runtime_id: string;
    task_id: string;
    task_title: string | null;
    session_id: string | null;
    process_pid: number | null;
    can_steer: boolean;
    disabled_reason: string | null;
    latest_message?: string | null;
  }[];
  openEscalations?: {
    id: string;
    agent_id: string;
    task_id: string;
    question: string;
    created_at: string;
  }[];
}

// --- Dashboard: Focus Task ---

export function parseDashboardTaskTime(input?: string): number {
  if (!input) return 0;
  const value = Date.parse(input);
  return Number.isFinite(value) ? value : 0;
}

export function dashboardArtifactsFragment(
  task: { id: string } | null,
  pollIntervalSeconds: PollIntervalSeconds,
): string {
  if (!task) {
    return `<div class="cmd-panel-body"><p class="muted">No active task selected.</p></div>`;
  }
  return `<div id="dashboard-artifact-list"
      class="cmd-panel-body cmd-scroll-compact"
      hx-get="/fragments/dashboard/tasks/${escapeHtml(task.id)}/artifacts"
      hx-trigger="load"
      hx-target="this"
      hx-swap="innerHTML">
    <p class="muted">Loading artifacts...</p>
  </div>`;
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
  current_phase: number;
  team_id?: string;
  team_name?: string;
  created_at: string;
  result?: unknown;
  task_type?: string;
  task_config?: Record<string, unknown>;
  needs_review?: boolean | number;
  phases?: { name: string; prompt: string; review?: boolean }[];
  healthSummary?: TaskHealthSummary;
}

export interface TaskNoteData {
  id: string;
  task_id: string;
  agent_id: string;
  agent_name?: string;
  content: string;
  source?: string;
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

export interface TeamOptionData {
  id: string;
  name: string;
}

// --- Forensics ---

export interface ForensicsTimelineEntry {
  source: "checkpoint" | "escalation" | "remediation" | "delegation";
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
  // Aggregated from terminal_outputs result/turn.completed/step_finish events
  input_tokens: number | null;
  cache_read_input_tokens: number | null; // claude: cache_read, codex: cached_input
  cache_creation_input_tokens: number | null; // claude only
  output_tokens: number | null;
  num_turns: number | null; // claude: from result, codex: count of turn.completed
  duration_ms: number | null; // claude only
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

export function fragmentRoot(id: string, content: string): string {
  return `<div id="${escapeHtml(id)}">${content}</div>`;
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

export function taskListPollingFragment(
  tasks: TaskData[],
  _pollIntervalSeconds?: PollIntervalSeconds,
): string {
  return fragmentRoot("task-list", taskListFragment(tasks));
}

export function taskDetailSummaryFragment(
  task: TaskData | null,
  _pollIntervalSeconds?: PollIntervalSeconds,
): string {
  const content = task
    ? taskDetailSummaryContent(task)
    : `<div class="card"><p class="muted">Task not found.</p></div>`;
  return fragmentRoot("task-summary-fragment", content);
}

export function taskPhasesContent(task: TaskData): string {
  return phaseStepper(task.current_phase, task.phases, task.status, task.needs_review);
}

export function taskPhaseStepperFragment(
  task: TaskData | null,
  _pollIntervalSeconds?: PollIntervalSeconds,
): string {
  const content = task
    ? taskPhasesContent(task)
    : `<div class="card"><p class="muted">Task not found.</p></div>`;
  return fragmentRoot("task-phases-fragment", content);
}

export function taskDelegationsFragment(
  _taskId: string,
  delegations: DelegationData[],
  _pollIntervalSeconds?: PollIntervalSeconds,
  taskExists: boolean = true,
): string {
  const content = taskExists
    ? taskDelegationsContent(delegations)
    : `<div class="card"><p class="muted">Task not found.</p></div>`;
  return `<div id="task-delegations-fragment">${content}</div>`;
}

export function taskForensicsFragment(
  _taskId: string,
  forensics: ForensicsData,
  _pollIntervalSeconds?: PollIntervalSeconds,
): string {
  return fragmentRoot(
    "task-forensics-fragment",
    taskForensicsContent(forensics),
  );
}

export function artifactPanelStandalone(task: TaskData): string {
  const taskId = escapeHtml(task.id);
  return `
    <div class="card">
      <div class="section-heading"><div><h2>Artifacts</h2><p class="muted">Versioned outputs from agent signals.</p></div></div>
      <div hx-get="/fragments/tasks/${taskId}/artifacts" hx-trigger="load" hx-target="#artifact-list" hx-swap="innerHTML">
        <div id="artifact-list" class="muted">Loading artifacts...</div>
      </div>
    </div>`;
}

export function taskTableRow(task: TaskData): string {
  const eid = escapeHtml(task.id);
  const menuItems: string[] = [];
  const isRealtime = task.task_type === "real_time";

  if (task.status === "draft") {
    menuItems.push(
      `<a href="/tasks/${eid}" hx-get="/tasks/${eid}" hx-target="body" hx-push-url="true">Edit</a>`,
    );
    menuItems.push(`<div class="action-divider"></div>`);
    if (task.team_id || isRealtime) {
      menuItems.push(
        `<button hx-post="/api/tasks/${eid}/approve" hx-target="body" hx-swap="innerHTML">Approve</button>`,
      );
    } else {
      menuItems.push(
        `<button disabled title="Assign a team before approving standard tasks">Approve</button>`,
      );
    }
    menuItems.push(
      `<button hx-post="/api/tasks/${eid}/cancel" hx-target="body" hx-swap="innerHTML" class="action-danger">Cancel</button>`,
    );
  }
  if (task.status === "approved") {
    menuItems.push(
      `<button hx-post="/api/tasks/${eid}/unapprove" hx-target="body" hx-swap="innerHTML">Unapprove</button>`,
    );
    menuItems.push(
      `<button hx-post="/api/tasks/${eid}/cancel" hx-target="body" hx-swap="innerHTML" class="action-danger">Cancel</button>`,
    );
  }
  if (task.status === "running") {
    menuItems.push(
      `<button hx-post="/api/tasks/${eid}/cancel" hx-target="body" hx-swap="innerHTML" class="action-danger">Cancel</button>`,
    );
  }
  if (task.status === "failed") {
    menuItems.push(
      `<button hx-post="/api/tasks/${eid}/resume" hx-target="body" hx-swap="innerHTML">Resume</button>`,
    );
    menuItems.push(
      `<button hx-post="/api/tasks/${eid}/retry" hx-target="body" hx-swap="innerHTML">Retry (Reset)</button>`,
    );
  }
  if (task.status === "completed") {
    menuItems.push(
      `<a href="/tasks/${eid}" hx-get="/tasks/${eid}" hx-target="body" hx-push-url="true">Iterate</a>`,
    );
  }
  if (task.status !== "running") {
    if (menuItems.length > 0)
      menuItems.push(`<div class="action-divider"></div>`);
    menuItems.push(
      `<button hx-post="/api/tasks/${eid}/delete" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this task?" class="action-danger">Delete</button>`,
    );
  }

  const actionsHtml =
    menuItems.length > 0
      ? `<div class="action-dropdown" tabindex="0"><button type="button" class="action-dropdown-toggle">Actions</button><div class="action-dropdown-menu">${menuItems.join("")}</div></div>`
      : "";

  return `<tr class="task-row">
    <td><span class="badge badge-${task.status}">${task.status}</span>${isRealtime ? ' <span class="badge badge-info" title="Real-time task">RT</span>' : ""}</td>
    <td>
      <div class="task-row-title">
        <a href="/tasks/${eid}" hx-get="/tasks/${eid}" hx-target="body" hx-push-url="true">${escapeHtml(task.title)}</a>
        ${task.description
      ? `<p class="muted task-row-description">${escapeHtml(
        (() => {
          const flat = task.description.replace(/\n+/g, " ").trim();
          return flat.length > 88 ? flat.slice(0, 88) + "..." : flat;
        })(),
      )}</p>`
      : ""
    }
      </div>
    </td>
    <td>${task.team_name ? escapeHtml(task.team_name) : "<span class='muted'>Unassigned</span>"}</td>
    <td>${task.phases ? `Phase ${task.current_phase + 1}/${task.phases.length}` : `Phase ${task.current_phase + 1}`}</td>
    <td>${formatTimestamp(task.created_at)}</td>
    <td><div class="table-actions">${actionsHtml}</div></td>
  </tr>`;
}

export function delegationTableRow(d: DelegationData): string {
  const preview = d.prompt.length > 80 ? d.prompt.slice(0, 80) + "…" : d.prompt;
  return `<tr>
    <td><span class="badge badge-${d.status}">${d.status}</span></td>
    <td>${d.parent_agent_name ? escapeHtml(d.parent_agent_name) : escapeHtml(d.parent_agent_id.slice(0, 8))}</td>
    <td>${d.child_agent_name ? escapeHtml(d.child_agent_name) : escapeHtml(d.child_agent_id.slice(0, 8))}</td>
    <td>
      <details class="delegation-prompt">
        <summary class="muted">${escapeHtml(preview)}</summary>
        <pre>${escapeHtml(d.prompt)}</pre>
      </details>
    </td>
    <td>${formatTimestamp(d.created_at)}</td>
    <td>${d.completed_at ? formatTimestamp(d.completed_at) : "-"}</td>
  </tr>`;
}

// --- Agents ---

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

export interface AgentTypeOption {
  name: string;
  available_models: string;
}

export interface AgentInstanceSummary {
  id: string;
  status: string;
  task_id: string;
  task_title: string | null;
  created_at: string;
  can_steer?: boolean;
  disabled_reason?: string | null;
  session_id?: string | null;
}

export interface RuntimeSteeringOptionView {
  id: string;
  task_id: string;
  task_title: string | null;
  created_at: string;
  session_id: string | null;
}

export interface RuntimeSteeringViewModel {
  enabled: boolean;
  reason: string | null;
  options: RuntimeSteeringOptionView[];
}

export function parseAvailableModels(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((m) => typeof m === "string")
      : [];
  } catch {
    return [];
  }
}

export function buildAgentTypeModelMap(
  agentTypes: AgentTypeOption[],
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const t of agentTypes) {
    map[t.name] = parseAvailableModels(t.available_models);
  }
  return map;
}

export function filterVisibleAgentTypes(
  agentTypes: AgentTypeOption[],
): AgentTypeOption[] {
  return agentTypes;
}

export function renderAgentTypeOptions(
  agentTypes: AgentTypeOption[],
  selectedType: string,
): string {
  const visibleTypes = filterVisibleAgentTypes(agentTypes);
  if (visibleTypes.length === 0) {
    return `<option value="claude-code"${selectedType === "claude-code" ? " selected" : ""}>claude-code</option>`;
  }
  return visibleTypes
    .map(
      (t) =>
        `<option value="${escapeHtml(t.name)}"${t.name === selectedType ? " selected" : ""}>${escapeHtml(t.name)}</option>`,
    )
    .join("");
}

export function agentTableRow(agent: AgentData): string {
  const link = `/agents/${escapeHtml(agent.id)}`;
  const nameHtml = `<a href="${link}" hx-get="${link}" hx-target="body" hx-push-url="true">${escapeHtml(agent.name)}</a>`;

  return `<tr>
    <td><span class="badge badge-${agent.status}">${agent.status}</span></td>
    <td>${nameHtml}</td>
    <td>${escapeHtml(agent.model)}</td>
    <td>${agent.current_task_id ? escapeHtml(agent.current_task_id.slice(0, 8)) : "-"}</td>
  </tr>`;
}

export interface AgentSessionData {
  id: string;
  created_at: string;
}

export function agentDetailSummaryFragment(
  agent: AgentData | null,
  _pollIntervalSeconds?: PollIntervalSeconds,
): string {
  const content = agent
    ? agentDetailSummaryContent(agent)
    : `<div class="card"><p class="muted">Agent not found.</p></div>`;
  return fragmentRoot("agent-summary-fragment", content);
}

export function renderTerminalOutputChunk(
  stream: string,
  data: string,
): string {
  const lines = data.split(/\r?\n/);
  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => renderTerminalLine(stream, line))
    .join("");
}

export function terminalOutputFragment(
  outputs: { stream: string; data: string; sequence: number }[],
): string {
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

export function parseJsonLine(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// --- Teams ---

export interface TeamData {
  id: string;
  name: string;
  entrypoint_agent_id: string | null;
  entrypoint_agent_name?: string;
  goal?: string;
  phases: { name: string; prompt: string; review?: boolean }[];
}

export interface TeamAgentData {
  agent_id: string;
  agent_name: string;
  role: string | null;
  level: number;
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
        <thead><tr><th>Name</th><th>Goal</th><th>Phases</th></tr></thead>
        <tbody>${teams.map(teamTableRow).join("")}</tbody>
      </table>`;
}

export function teamListPollingFragment(
  teams: TeamData[],
  _pollIntervalSeconds?: PollIntervalSeconds,
): string {
  return fragmentRoot("team-list", teamListFragment(teams));
}

function teamTableRow(team: TeamData): string {
  return `<tr>
    <td><a href="/teams/${escapeHtml(team.id)}" hx-get="/teams/${escapeHtml(team.id)}" hx-target="body" hx-push-url="true">${escapeHtml(team.name)}</a></td>
    <td>${team.goal ? escapeHtml(team.goal) : "-"}</td>
    <td>${team.phases.length}</td>
  </tr>`;
}

export function teamDetailSummaryContent(
  team: TeamData,
  _agents: TeamAgentData[],
): string {
  return `<div class="team-hero">
      <h1>${escapeHtml(team.name)}</h1>
      <div class="team-hero-meta">
        <span class="badge badge-phase-index">${team.phases.length} phase${team.phases.length === 1 ? "" : "s"}</span>
      </div>
    </div>`;
}

export function teamDetailSummaryFragment(
  team: TeamData | null,
  agents: TeamAgentData[],
  _pollIntervalSeconds?: PollIntervalSeconds,
): string {
  const content = team
    ? teamDetailSummaryContent(team, agents)
    : `<div class="card"><p class="muted">Team not found.</p></div>`;
  return fragmentRoot("team-summary-fragment", content);
}

export function teamMembersFragment(
  team: TeamData | null,
  agents: TeamAgentData[],
  availableAgents: AgentOptionData[],
  _pollIntervalSeconds?: PollIntervalSeconds,
): string {
  const content = team
    ? teamMembersContent(team, agents, availableAgents)
    : `<section class="card team-section"><p class="muted">Team not found.</p></section>`;
  return fragmentRoot("team-members-fragment", content);
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

export function auditEventsTableFragment(events: AuditEventData[]): string {
  if (events.length === 0)
    return `<div class="empty-state"><div class="empty-state-icon">&#128240;</div><p>No events found</p></div>`;
  return `<table class="data-table">
    <thead><tr><th>ID</th><th>Type</th><th>Source Agent</th><th>Task</th><th>Payload</th><th>Timestamp</th></tr></thead>
    <tbody>${events.map(auditEventRow).join("")}</tbody>
  </table>`;
}

function auditEventRow(e: AuditEventData): string {
  const payload =
    e.payload.length > 120 ? e.payload.slice(0, 120) + "…" : e.payload;
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

export function logsTableFragment(entries: LogEntryData[]): string {
  if (entries.length === 0) {
    return `<div class="empty-state"><div class="empty-state-icon">&#128196;</div><p>No log entries found</p><p class="muted">Logs appear here when agents produce output</p></div>`;
  }
  return `<table class="data-table logs-table">
    <thead><tr><th>Agent</th><th>Stream</th><th>Output</th><th>Timestamp</th></tr></thead>
    <tbody>${entries.map(logEntryRow).join("")}</tbody>
  </table>`;
}

function logEntryRow(e: LogEntryData): string {
  return `<tr>
    <td><a href="/agents/${escapeHtml(e.agent_id)}" hx-get="/agents/${escapeHtml(e.agent_id)}" hx-target="body" hx-push-url="true">${escapeHtml(e.agent_name)}</a></td>
    <td><span class="badge badge-${e.stream === "stderr" ? "error" : "running"}">${escapeHtml(e.stream)}</span></td>
    <td>${logPayloadHtml(e)}</td>
    <td>${formatTimestamp(e.created_at)}</td>
  </tr>`;
}

function parseLogPayloadEvents(data: string): {
  events: Record<string, unknown>[];
  remainder: string;
} {
  const lines = data.split(/\r?\n/);
  const events: Record<string, unknown>[] = [];
  const remainder: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseJsonLine(trimmed);
    if (parsed) events.push(parsed);
    else remainder.push(line);
  }

  if (events.length === 0) {
    const parsedWhole = parseJsonLine(data.trim());
    if (parsedWhole) return { events: [parsedWhole], remainder: "" };
  }

  return { events, remainder: remainder.join("\n").trim() };
}

function extractLogEventMessages(event: Record<string, unknown>): string[] {
  const out: string[] = [];
  const pushIfText = (value: unknown): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    out.push(trimmed);
  };

  if (event.type === "assistant") {
    const message = event.message;
    if (message && typeof message === "object") {
      const msg = message as Record<string, unknown>;
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "text") pushIfText(b.text);
        }
      } else {
        pushIfText(content);
      }
    }
  }

  const item = event.item;
  if (item && typeof item === "object") {
    const it = item as Record<string, unknown>;
    if (it.type === "agent_message") pushIfText(it.text);
    if (it.type === "command_execution") pushIfText(it.aggregated_output);
    if (it.type === "reasoning") pushIfText(it.text);
  }

  pushIfText(event.result);

  const deduped = Array.from(new Set(out.map((x) => x.trim()))).filter(
    (x) => x.length > 0,
  );
  return deduped;
}

function logPayloadHtml(entry: LogEntryData): string {
  const { events, remainder } = parseLogPayloadEvents(entry.data);
  if (events.length === 0) {
    return `<pre class="log-payload-plain terminal-${escapeHtml(entry.stream)}">${escapeHtml(entry.data)}</pre>`;
  }

  const eventsHtml = events
    .map((event) => {
      const type = typeof event.type === "string" ? event.type : "";
      const summary = terminalJsonSummary(event);
      const messages = extractLogEventMessages(event);
      const messageHtml =
        messages.length > 0
          ? messages
            .map(
              (message) =>
                `<pre class="log-message-text terminal-${escapeHtml(entry.stream)}">${escapeHtml(message)}</pre>`,
            )
            .join("")
          : `<pre class="log-message-text muted">No message text extracted.</pre>`;
      return `<div class="log-json-event">
      <div class="log-json-head">
        <span class="badge badge-stream-${escapeHtml(entry.stream)}">${escapeHtml(entry.stream)}</span>
        ${type ? `<span class="badge badge-json-type">${escapeHtml(type)}</span>` : ""}
        ${summary ? `<span class="terminal-json-summary">${escapeHtml(summary)}</span>` : ""}
      </div>
      ${messageHtml}
      <details class="log-json-raw">
        <summary>raw json</summary>
        <pre class="log-json-body">${escapeHtml(JSON.stringify(event, null, 2))}</pre>
      </details>
    </div>`;
    })
    .join("");

  const remainderHtml = remainder
    ? `<pre class="log-payload-plain terminal-${escapeHtml(entry.stream)}">${escapeHtml(remainder)}</pre>`
    : "";

  return `<div class="log-json-list">${eventsHtml}${remainderHtml}</div>`;
}

// --- MCP Servers ---

export function mcpToggleId(
  provider: string,
  scope: string,
  serverName: string,
): string {
  return `mcp-toggle-${provider}-${scope}-${serverName}`.replace(
    /[^a-zA-Z0-9-_]/g,
    "_",
  );
}

export function mcpScopeBadge(scope: string): string {
  if (scope === "cloud")
    return `<span class="badge badge-stopped">cloud</span>`;
  if (scope === "user") return `<span class="badge badge-info">user</span>`;
  return `<span class="badge badge-running">project</span>`;
}

// --- Agent-level MCP/Skills toggle helpers ---

export function agentMcpToggleId(
  agentId: string,
  provider: string,
  scope: string,
  serverName: string,
): string {
  return `agent-mcp-${agentId.slice(0, 8)}-${provider}-${scope}-${serverName}`.replace(
    /[^a-zA-Z0-9-]/g,
    "_",
  );
}

export function agentSkillToggleId(
  agentId: string,
  provider: string,
  skillName: string,
): string {
  return `agent-skill-${agentId.slice(0, 8)}-${provider}-${skillName}`.replace(
    /[^a-zA-Z0-9-]/g,
    "_",
  );
}

// --- Utility ---

export function escapeHtml(str: string): string {
  const value = str == null ? "" : String(str);
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
