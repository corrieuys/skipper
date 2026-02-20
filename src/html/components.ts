// Server-rendered HTML components for HTMX UI

export function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return escapeHtml(isoString);

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  let relative: string;
  if (diffSec < 60) relative = "just now";
  else if (diffMin < 60) relative = `${diffMin}m ago`;
  else if (diffHr < 24) relative = `${diffHr}h ago`;
  else if (diffDay < 30) relative = `${diffDay}d ago`;
  else relative = date.toLocaleDateString();

  return `<span title="${escapeHtml(isoString)}">${relative}</span>`;
}

const navItems: { href: string; label: string }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/tasks", label: "Tasks" },
  { href: "/agents", label: "Agents" },
  { href: "/teams", label: "Teams" },
  { href: "/escalations", label: "Escalations" },
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
  <title>${escapeHtml(title)} - PlayHive</title>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <script src="https://unpkg.com/htmx-ext-sse@2.2.2/sse.js"></script>
  <style>${baseStyles()}</style>
</head>
<body>
  <nav class="navbar">
    <a href="/" class="brand">PlayHive</a>
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
  recentLogs?: RecentLogEntry[];
}

export function dashboardPage(data: DashboardData): string {
  const activeTasks = data.tasks.filter((t) => t.status === "running" || t.status === "approved");
  const busyAgents = data.agents.filter((a) => a.status === "busy");

  return layout(
    "Dashboard",
    `<h1>Dashboard</h1>
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">${data.tasks.length}</div>
        <div class="stat-label">Total Tasks</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${activeTasks.length}</div>
        <div class="stat-label">Active Tasks</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${data.agents.length}</div>
        <div class="stat-label">Agents</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${busyAgents.length}</div>
        <div class="stat-label">Busy Agents</div>
      </div>
      <div class="stat-card">
        <span class="badge badge-${data.daemon.state === "running" ? "running" : data.daemon.state === "pausing" ? "stopped" : data.daemon.state === "paused" ? "stopped" : "error"}">${data.daemon.state}</span>
        <div class="stat-label">Daemon</div>
        ${data.daemon.state === "running" ? `<button hx-post="/api/daemon/pause" hx-target="body" hx-swap="innerHTML" class="btn-sm" style="margin-top:0.5rem">Pause</button>` : ""}
        ${data.daemon.state === "paused" ? `<button hx-post="/api/daemon/resume" hx-target="body" hx-swap="innerHTML" class="btn-sm" style="margin-top:0.5rem">Resume</button>` : ""}
        ${data.daemon.state === "pausing" ? `<span class="muted" style="margin-top:0.5rem;display:block">Pausing...</span>` : ""}
      </div>
    </div>

    <div class="grid-2">
      <section>
        <h2>Active Tasks</h2>
        <div id="active-tasks" hx-ext="sse" sse-connect="/events/tasks" sse-swap="task:state_changed" hx-swap="innerHTML">
          ${activeTasks.length === 0 ? `<div class="empty-state"><div class="empty-state-icon">&#9745;</div><p>No active tasks</p><p class="muted">Approve a draft task to get started</p></div>` : activeTasks.map(taskRow).join("")}
        </div>
      </section>

      <section>
        <h2>Agent Status</h2>
        <div id="agent-status" hx-ext="sse" sse-connect="/events/agents" sse-swap="agent:state_changed" hx-swap="innerHTML">
          ${data.agents.length === 0 ? `<div class="empty-state"><div class="empty-state-icon">&#9881;</div><p>No agents configured</p><p class="muted">Create an agent to begin orchestrating</p></div>` : data.agents.map(agentStatusRow).join("")}
        </div>
      </section>
    </div>

    <section>
      <h2>Recent Agent Activity</h2>
      <div id="recent-activity" class="activity-feed" hx-ext="sse" sse-connect="/events/logs" sse-swap="logs:activity" hx-swap="innerHTML">
        ${recentActivityFragment(data.recentLogs ?? [])}
      </div>
    </section>`,
    "/",
  );
}

function taskRow(task: { id: string; title: string; status: string; priority: number }): string {
  return `<div class="list-item">
    <span class="badge badge-${task.status}">${task.status}</span>
    <a href="/tasks/${escapeHtml(task.id)}" hx-get="/tasks/${escapeHtml(task.id)}" hx-target="body" hx-push-url="true">
      ${escapeHtml(task.title)}
    </a>
    <span class="priority">P${task.priority}</span>
  </div>`;
}

function agentStatusRow(agent: { id: string; name: string; status: string; type: string }): string {
  return `<div class="list-item">
    <span class="badge badge-${agent.status}">${agent.status}</span>
    <a href="/agents/${escapeHtml(agent.id)}" hx-get="/agents/${escapeHtml(agent.id)}" hx-target="body" hx-push-url="true">
      ${escapeHtml(agent.name)}
    </a>
    <span class="muted">${escapeHtml(agent.type)}</span>
  </div>`;
}

export function recentActivityFragment(logs: RecentLogEntry[]): string {
  if (logs.length === 0) {
    return `<div class="empty-state"><div class="empty-state-icon">&#128240;</div><p>No recent activity</p><p class="muted">Agent output will appear here</p></div>`;
  }
  return logs.map((entry) => {
    const truncated = entry.data.length > 120 ? entry.data.slice(0, 120) + "…" : entry.data;
    return `<div class="activity-entry">
      <a href="/agents/${escapeHtml(entry.agent_id)}" hx-get="/agents/${escapeHtml(entry.agent_id)}" hx-target="body" hx-push-url="true" class="activity-agent">${escapeHtml(entry.agent_name)}</a>
      <span class="badge badge-stream-${escapeHtml(entry.stream)}">${escapeHtml(entry.stream)}</span>
      <code class="activity-data">${escapeHtml(truncated)}</code>
      <span class="muted activity-time">${formatTimestamp(entry.created_at)}</span>
    </div>`;
  }).join("");
}

// --- Tasks ---

export interface TaskData {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: number;
  current_phase: number;
  team_id?: string;
  created_at: string;
  result?: unknown;
  phases?: { name: string; prompt: string }[];
}

export interface TaskNoteData {
  id: string;
  task_id: string;
  agent_id: string;
  content: string;
  created_at: string;
}

export interface DelegationData {
  id: string;
  parent_agent_id: string;
  child_agent_id: string;
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
  name: string;
  type: string;
  content: string | null;
  path: string | null;
  created_at: string;
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
        <thead><tr><th>Status</th><th>Title</th><th>Priority</th><th>Phase</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>${tasks.map(taskTableRow).join("")}</tbody>
      </table>`;
}

export function tasksPage(tasks: TaskData[]): string {
  return layout(
    "Tasks",
    `<div class="page-header">
      <h1>Tasks</h1>
      <button onclick="document.getElementById('create-task-form').style.display='block'">New Task</button>
    </div>

    <div id="create-task-form" style="display:none" class="card">
      <h3>Create Task</h3>
      <form hx-post="/api/tasks" hx-target="#task-list" hx-swap="innerHTML" hx-on::after-request="if(event.detail.successful) this.reset()">
        <label>Title <input type="text" name="title" required></label>
        <label>Description <textarea name="description" rows="3"></textarea></label>
        <label>Priority <input type="number" name="priority" min="1" max="10" value="5"></label>
        <label>Team ID <input type="text" name="teamId"></label>
        <button type="submit">Create</button>
      </form>
    </div>

    <div id="task-list">
      ${taskListFragment(tasks)}
    </div>`,
    "/tasks",
  );
}

function taskTableRow(task: TaskData): string {
  const actions = [];
  if (task.status === "draft") {
    actions.push(`<button hx-post="/api/tasks/${escapeHtml(task.id)}/approve" hx-target="body" hx-swap="innerHTML" class="btn-sm">Approve</button>`);
    actions.push(`<button hx-post="/api/tasks/${escapeHtml(task.id)}/cancel" hx-target="body" hx-swap="innerHTML" class="btn-sm btn-danger">Cancel</button>`);
  }
  if (task.status === "running") {
    actions.push(`<button hx-post="/api/tasks/${escapeHtml(task.id)}/cancel" hx-target="body" hx-swap="innerHTML" class="btn-sm btn-danger">Cancel</button>`);
  }
  if (task.status === "failed") {
    actions.push(`<button hx-post="/api/tasks/${escapeHtml(task.id)}/retry" hx-target="body" hx-swap="innerHTML" class="btn-sm">Retry</button>`);
  }

  return `<tr>
    <td><span class="badge badge-${task.status}">${task.status}</span></td>
    <td><a href="/tasks/${escapeHtml(task.id)}" hx-get="/tasks/${escapeHtml(task.id)}" hx-target="body" hx-push-url="true">${escapeHtml(task.title)}</a></td>
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
): string {
  return layout(
    task.title,
    `<a href="/tasks" hx-get="/tasks" hx-target="body" hx-push-url="true">&larr; Back to Tasks</a>
    <h1>${escapeHtml(task.title)}</h1>
    <div class="card">
      <div class="detail-grid">
        <div><strong>Status:</strong> <span class="badge badge-${task.status}">${task.status}</span></div>
        <div><strong>Priority:</strong> P${task.priority}</div>
        <div><strong>Team:</strong> ${task.team_id ? escapeHtml(task.team_id) : "None"}</div>
        <div><strong>Created:</strong> ${formatTimestamp(task.created_at)}</div>
      </div>
      ${task.description ? `<div class="detail-desc"><strong>Description:</strong><p>${escapeHtml(task.description)}</p></div>` : ""}
      ${task.result ? `<div class="detail-desc"><strong>Result:</strong><pre>${escapeHtml(JSON.stringify(task.result, null, 2))}</pre></div>` : ""}
    </div>

    <div class="card">
      <h2>Edit Task</h2>
      ${task.status === "draft" ? `<form hx-post="/api/tasks/${escapeHtml(task.id)}" hx-target="body" hx-swap="innerHTML">
        <label>Title <input type="text" name="title" value="${escapeHtml(task.title)}" required></label>
        <label>Description <textarea name="description" rows="3">${task.description ? escapeHtml(task.description) : ""}</textarea></label>
        <label>Priority <input type="number" name="priority" min="1" max="10" value="${task.priority}"></label>
        <label>Team ID <input type="text" name="teamId" value="${task.team_id ? escapeHtml(task.team_id) : ""}"></label>
        <button type="submit">Save Changes</button>
      </form>` : `<p class="muted">Only draft tasks can be edited.</p>`}
    </div>

    ${phaseStepper(task.current_phase, task.phases)}

    <h2>Notes</h2>
    ${notes.length === 0 ? `<div class="empty-state"><div class="empty-state-icon">&#128221;</div><p>No notes yet</p></div>` : notes.map((n) => `<div class="card">
      <div class="muted">Agent: ${escapeHtml(n.agent_id.slice(0, 8))} | ${formatTimestamp(n.created_at)}</div>
      <p>${escapeHtml(n.content)}</p>
    </div>`).join("")}

    <h2>Delegations</h2>
    ${delegations.length === 0 ? `<div class="empty-state"><div class="empty-state-icon">&#128257;</div><p>No delegations</p></div>` : `<table class="data-table">
      <thead><tr><th>Status</th><th>Parent Agent</th><th>Child Agent</th><th>Prompt</th><th>Created</th><th>Completed</th></tr></thead>
      <tbody>${delegations.map(delegationTableRow).join("")}</tbody>
    </table>`}

    <h2>Artifacts</h2>
    ${artifacts.length === 0 ? `<div class="empty-state"><div class="empty-state-icon">&#128230;</div><p>No artifacts</p></div>` : artifacts.map(artifactCard).join("")}`,
    "/tasks",
  );
}

function phaseStepper(currentPhase: number, phases?: { name: string; prompt: string }[]): string {
  if (!phases || phases.length === 0) {
    return `<div class="card"><strong>Phase:</strong> ${currentPhase}</div>`;
  }
  const steps = phases.map((p, i) => {
    const state = i < currentPhase ? "done" : i === currentPhase ? "active" : "pending";
    const icon = state === "done" ? "&#10003;" : `${i}`;
    return `<div class="phase-step phase-step-${state}">
      ${i > 0 ? `<div class="phase-connector${state === "pending" ? "" : " phase-connector-done"}"></div>` : ""}
      <div class="phase-circle">${icon}</div>
      <div class="phase-name">${escapeHtml(p.name)}</div>
    </div>`;
  });
  return `<div class="phase-stepper">${steps.join("")}</div>`;
}

function delegationTableRow(d: DelegationData): string {
  return `<tr>
    <td><span class="badge badge-${d.status}">${d.status}</span></td>
    <td>${escapeHtml(d.parent_agent_id.slice(0, 8))}</td>
    <td>${escapeHtml(d.child_agent_id.slice(0, 8))}</td>
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
      <span class="muted">Agent: ${escapeHtml(a.agent_id.slice(0, 8))} | ${formatTimestamp(a.created_at)}</span>
    </div>
    ${a.path ? `<div class="artifact-path"><code>${escapeHtml(a.path)}</code></div>` : ""}
    ${a.content ? `<details class="artifact-content"><summary>View content</summary><pre>${escapeHtml(a.content)}</pre></details>` : ""}
  </div>`;
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
  lastOutput?: { stream: string; data: string } | null;
}

export function agentsPage(agents: AgentData[]): string {
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
        <label>Type
          <select name="type">
            <option value="claude-code">claude-code</option>
            <option value="codex">codex</option>
            <option value="custom">custom</option>
          </select>
        </label>
        <label>Model <input type="text" name="model" placeholder="default"></label>
        <label>Goal <input type="text" name="goal"></label>
        <button type="submit">Create</button>
      </form>
    </div>

    <div id="agent-list">
      ${agents.length === 0 ? `<div class="empty-state"><div class="empty-state-icon">&#129302;</div><p>No agents configured</p><p class="muted">Create an agent to begin orchestrating</p></div>` : `<table class="data-table">
        <thead><tr><th>Status</th><th>Name</th><th>Type</th><th>Model</th><th>PID</th><th>Task</th><th>Last Output</th><th>Actions</th></tr></thead>
        <tbody>${agents.map(agentTableRow).join("")}</tbody>
      </table>`}
    </div>`,
    "/agents",
  );
}

export function agentListFragment(agents: AgentData[]): string {
  return agents.length === 0
    ? `<div class="empty-state"><div class="empty-state-icon">&#129302;</div><p>No agents configured</p><p class="muted">Create an agent to begin orchestrating</p></div>`
    : `<table class="data-table">
        <thead><tr><th>Status</th><th>Name</th><th>Type</th><th>Model</th><th>PID</th><th>Task</th><th>Last Output</th><th>Actions</th></tr></thead>
        <tbody>${agents.map(agentTableRow).join("")}</tbody>
      </table>`;
}

function agentTableRow(agent: AgentData): string {
  let lastOutputCell = `<span class="muted">—</span>`;
  if (agent.lastOutput) {
    const truncated = agent.lastOutput.data.length > 60 ? agent.lastOutput.data.slice(0, 60) + "…" : agent.lastOutput.data;
    lastOutputCell = `<span class="badge badge-stream-${escapeHtml(agent.lastOutput.stream)}">${escapeHtml(agent.lastOutput.stream)}</span> <code class="muted">${escapeHtml(truncated)}</code>`;
  }
  return `<tr>
    <td><span class="badge badge-${agent.status}">${agent.status}</span></td>
    <td><a href="/agents/${escapeHtml(agent.id)}" hx-get="/agents/${escapeHtml(agent.id)}" hx-target="body" hx-push-url="true">${escapeHtml(agent.name)}</a></td>
    <td>${escapeHtml(agent.type)}</td>
    <td>${escapeHtml(agent.model)}</td>
    <td>${agent.process_pid ?? "-"}</td>
    <td>${agent.current_task_id ? escapeHtml(agent.current_task_id.slice(0, 8)) : "-"}</td>
    <td class="last-output-cell">${lastOutputCell}</td>
    <td>${agent.status !== "busy" ? `<button hx-delete="/api/agents/${escapeHtml(agent.id)}" hx-target="body" hx-swap="innerHTML" hx-confirm="Delete this agent?" class="btn-sm btn-danger">Delete</button>` : ""}</td>
  </tr>`;
}

export function agentDetailPage(agent: AgentData): string {
  return layout(
    agent.name,
    `<a href="/agents" hx-get="/agents" hx-target="body" hx-push-url="true">&larr; Back to Agents</a>
    <h1>${escapeHtml(agent.name)}</h1>
    <div class="card">
      <div class="detail-grid">
        <div><strong>Status:</strong> <span class="badge badge-${agent.status}">${agent.status}</span></div>
        <div><strong>Type:</strong> ${escapeHtml(agent.type)}</div>
        <div><strong>Model:</strong> ${escapeHtml(agent.model)}</div>
        <div><strong>PID:</strong> ${agent.process_pid ?? "None"}</div>
        <div><strong>Task:</strong> ${agent.current_task_id ?? "None"}</div>
        <div><strong>Capabilities:</strong> ${agent.capabilities.length > 0 ? agent.capabilities.map(escapeHtml).join(", ") : "None"}</div>
      </div>
      ${agent.config.goal ? `<div class="detail-desc"><strong>Goal:</strong><p>${escapeHtml(String(agent.config.goal))}</p></div>` : ""}
    </div>

    <div class="terminal-section-header">
      <h2>Terminal Output</h2>
      <span id="terminal-line-count" class="muted terminal-line-count">Loading...</span>
    </div>
    <div id="terminal" class="terminal" hx-ext="sse" sse-connect="/events/agent/${escapeHtml(agent.id)}/output" sse-swap="agent:output" hx-swap="beforeend scroll:bottom">
      <div hx-get="/agents/${escapeHtml(agent.id)}/output" hx-trigger="load" hx-swap="innerHTML" hx-on::after-settle="(function(){var el=document.getElementById('terminal-line-count');if(el)el.textContent=document.querySelectorAll('#terminal .terminal-line').length+' lines';})()"></div>
    </div>

    <div class="card">
      <h2>Edit Agent</h2>
      ${agent.status === "busy" ? `<p class="muted">Busy agents cannot be edited.</p>` : `<form hx-post="/api/agents/${escapeHtml(agent.id)}" hx-target="body" hx-swap="innerHTML">
        <label>Name <input type="text" name="name" value="${escapeHtml(agent.name)}" required></label>
        <label>Type
          <select name="type">
            <option value="claude-code"${agent.type === "claude-code" ? " selected" : ""}>claude-code</option>
            <option value="codex"${agent.type === "codex" ? " selected" : ""}>codex</option>
            <option value="custom"${agent.type === "custom" ? " selected" : ""}>custom</option>
          </select>
        </label>
        <label>Model <input type="text" name="model" value="${escapeHtml(agent.model)}" placeholder="default"></label>
        <label>Goal <input type="text" name="goal" value="${agent.config.goal ? escapeHtml(String(agent.config.goal)) : ""}"></label>
        <button type="submit">Save Changes</button>
      </form>`}
    </div>`,
    "/agents",
  );
}

export function terminalOutputFragment(outputs: { stream: string; data: string; sequence: number }[]): string {
  return outputs
    .map((o) => `<div class="terminal-line terminal-${o.stream}">${escapeHtml(o.data)}</div>`)
    .join("");
}

// --- Teams ---

export interface TeamData {
  id: string;
  name: string;
  entrypoint_agent_id: string | null;
  goal?: string;
  phases: { name: string; prompt: string }[];
}

export interface TeamAgentData {
  agent_id: string;
  agent_name: string;
  role: string | null;
  level: number;
  skills: string[];
}

export function teamListFragment(teams: TeamData[]): string {
  return teams.length === 0
    ? `<div class="empty-state"><div class="empty-state-icon">&#128101;</div><p>No teams configured</p><p class="muted">Create a team to organize your agents</p></div>`
    : `<table class="data-table">
        <thead><tr><th>Name</th><th>Goal</th><th>Entrypoint</th><th>Phases</th></tr></thead>
        <tbody>${teams.map(teamTableRow).join("")}</tbody>
      </table>`;
}

export function teamsPage(teams: TeamData[]): string {
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

    <div id="team-list">
      ${teamListFragment(teams)}
    </div>`,
    "/teams",
  );
}

function teamTableRow(team: TeamData): string {
  return `<tr>
    <td><a href="/teams/${escapeHtml(team.id)}" hx-get="/teams/${escapeHtml(team.id)}" hx-target="body" hx-push-url="true">${escapeHtml(team.name)}</a></td>
    <td>${team.goal ? escapeHtml(team.goal) : "-"}</td>
    <td>${team.entrypoint_agent_id ? escapeHtml(team.entrypoint_agent_id.slice(0, 8)) : "None"}</td>
    <td>${team.phases.length}</td>
  </tr>`;
}

export function teamDetailPage(team: TeamData, agents: TeamAgentData[]): string {
  return layout(
    team.name,
    `<a href="/teams" hx-get="/teams" hx-target="body" hx-push-url="true">&larr; Back to Teams</a>
    <h1>${escapeHtml(team.name)}</h1>
    <div class="card">
      <div class="detail-grid">
        <div><strong>Goal:</strong> ${team.goal ? escapeHtml(team.goal) : "None"}</div>
        <div><strong>Entrypoint:</strong> ${team.entrypoint_agent_id ? escapeHtml(team.entrypoint_agent_id.slice(0, 8)) : "None"}</div>
      </div>
    </div>

    <div class="card">
      <h2>Edit Team</h2>
      <form hx-post="/api/teams/${escapeHtml(team.id)}" hx-target="body" hx-swap="innerHTML">
        <label>Name <input type="text" name="name" value="${escapeHtml(team.name)}" required></label>
        <label>Goal <input type="text" name="goal" value="${team.goal ? escapeHtml(team.goal) : ""}"></label>
        <button type="submit">Save Changes</button>
      </form>
    </div>

    <h2>Phases (${team.phases.length})</h2>
    ${team.phases.length === 0 ? `<div class="empty-state"><div class="empty-state-icon">&#9654;</div><p>No phases defined</p></div>` : `<table class="data-table">
      <thead><tr><th>#</th><th>Name</th><th>Prompt</th><th>Actions</th></tr></thead>
      <tbody>${team.phases.map((p, i) => `<tr>
        <td>${i}</td>
        <td>${escapeHtml(p.name)}</td>
        <td class="muted">${escapeHtml(p.prompt.length > 80 ? p.prompt.slice(0, 80) + "…" : p.prompt)}</td>
        <td><button hx-delete="/api/teams/${escapeHtml(team.id)}/phases/${i}" hx-target="body" hx-swap="innerHTML" hx-confirm="Remove this phase?" class="btn-sm btn-danger">Remove</button></td>
      </tr>`).join("")}</tbody>
    </table>`}

    <h3>Add Phase</h3>
    <form hx-post="/api/teams/${escapeHtml(team.id)}/phases" hx-target="body" hx-swap="innerHTML" hx-on::after-request="if(event.detail.successful) this.reset()">
      <label>Name <input type="text" name="name" required></label>
      <label>Prompt <textarea name="prompt" rows="2" required></textarea></label>
      <button type="submit">Add Phase</button>
    </form>

    <h2>Members</h2>
    ${agents.length === 0 ? `<div class="empty-state"><div class="empty-state-icon">&#128101;</div><p>No agents in this team</p></div>` : `<table class="data-table">
      <thead><tr><th>Name</th><th>Role</th><th>Level</th><th>Skills</th></tr></thead>
      <tbody>${agents.map((a) => `<tr>
        <td>${escapeHtml(a.agent_name)}</td>
        <td>${a.role ? escapeHtml(a.role) : "-"}</td>
        <td>${a.level}</td>
        <td>${a.skills.length > 0 ? a.skills.map(escapeHtml).join(", ") : "-"}</td>
      </tr>`).join("")}</tbody>
    </table>`}

    <h3>Add Agent</h3>
    <form hx-post="/api/teams/${escapeHtml(team.id)}/agents" hx-target="body" hx-swap="innerHTML" class="inline-form">
      <input type="text" name="agent_id" placeholder="Agent ID" required>
      <input type="text" name="role" placeholder="Role">
      <button type="submit">Add</button>
    </form>`,
    "/teams",
  );
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
  return `<div class="card escalation-card">
    <div class="escalation-header">
      <span class="badge badge-${esc.status}">${esc.status}</span>
      <span class="badge">${escapeHtml(esc.type)}</span>
      <span class="muted">${formatTimestamp(esc.created_at)}</span>
    </div>
    <div class="escalation-question"><strong>Question:</strong> ${escapeHtml(esc.question)}</div>
    <div class="muted">Agent: ${escapeHtml(esc.agent_id.slice(0, 8))} | Task: ${escapeHtml(esc.task_id.slice(0, 8))}</div>
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

// --- Help ---

export function helpPage(): string {
  return layout(
    "Help",
    `<h1>PlayHive Help</h1>

    <div class="card">
      <h2>Platform Overview</h2>
      <p>PlayHive is an AI agent orchestrator that coordinates teams of coding agents to complete software engineering tasks.
      It manages task lifecycles, delegates work between agents, handles multi-phase execution, and escalates to humans when needed.</p>
    </div>

    <h2>Core Concepts</h2>

    <div class="card">
      <h3>Task Lifecycle</h3>
      <p>Every task progresses through a series of states:</p>
      <pre class="help-diagram">
  draft ──&gt; approved ──&gt; running ──&gt; completed
    │                       │
    └──&gt; cancelled          └──&gt; failed ──&gt; (retry) ──&gt; approved
      </pre>
      <p>Tasks start as <strong>draft</strong>, must be <strong>approved</strong> before the daemon picks them up,
      run until <strong>completed</strong> or <strong>failed</strong>, and failed tasks can be retried.</p>
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
  │ Plan │ ──&gt; │ Code │ ──&gt; │Review│ ──&gt; Complete
  └──────┘      └──────┘      └──────┘
     │             │             │
  agent runs    agent runs    agent runs
  &amp; signals     &amp; signals     &amp; exits 0
  PHASE_COMPLETE PHASE_COMPLETE
      </pre>
    </div>

    <div class="card">
      <h3>Delegation Flow</h3>
      <p>A parent agent can delegate subtasks to child agents on the same team:</p>
      <pre class="help-diagram">
  Parent Agent                    Child Agent
  ┌───────────┐                  ┌───────────┐
  │ Working   │                  │           │
  │ on task   │  [DELEGATE]      │           │
  │           │ ───────────────&gt; │  Spawned  │
  │ (paused)  │                  │  with     │
  │           │                  │  prompt   │
  │           │  result          │           │
  │ Resumed   │ &lt;─────────────── │  Exits    │
  │ with      │                  │           │
  │ context   │                  └───────────┘
  └───────────┘
      </pre>
      <p>There is a maximum of 3 delegations per parent per task to prevent loops.</p>
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
      <p>Agents communicate with PlayHive by printing signals to stdout. The daemon parses these in real time:</p>
      <table class="data-table">
        <thead><tr><th>Signal</th><th>Format</th><th>Description</th></tr></thead>
        <tbody>
          <tr>
            <td><code>[PHASE_COMPLETE]</code></td>
            <td><code>[PHASE_COMPLETE]</code></td>
            <td>Current phase finished successfully; advance to next phase</td>
          </tr>
          <tr>
            <td><code>[DELEGATE]</code></td>
            <td><code>[DELEGATE] agent_name: prompt text</code></td>
            <td>Delegate a subtask to another agent on the team</td>
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
        </tbody>
      </table>
    </div>

    <h2>Features Guide</h2>

    <div class="card">
      <h3>Dashboard</h3>
      <p>The <a href="/">Dashboard</a> shows an overview of your orchestrator: total tasks, active tasks, agent count,
      busy agents, and daemon status. It updates in real time via SSE.</p>
    </div>

    <div class="card">
      <h3>Tasks</h3>
      <p>The <a href="/tasks">Tasks</a> page lets you create, approve, cancel, and retry tasks. Click a task to see its
      detail view with notes, delegations, artifacts, and a phase stepper showing execution progress.</p>
    </div>

    <div class="card">
      <h3>Agents</h3>
      <p>The <a href="/agents">Agents</a> page lets you create agents of type <strong>claude-code</strong>,
      <strong>codex</strong>, or <strong>custom</strong>. Each agent detail page shows a live terminal output viewer
      streaming stdout/stderr in real time.</p>
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
      <p>End-to-end walkthrough of using PlayHive:</p>
      <ol style="margin:0.5rem 0 0 1.5rem;line-height:2">
        <li>Go to <a href="/agents">Agents</a> and create one or more agents (e.g. a claude-code agent named "senior-dev")</li>
        <li>Go to <a href="/teams">Teams</a> and create a team, then add your agents to it</li>
        <li>Set the entrypoint agent and add phases (e.g. "Planning", "Implementation", "Review")</li>
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
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1117; color: #e1e4e8; line-height: 1.6; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .navbar { display: flex; align-items: center; gap: 2rem; padding: 0.75rem 1.5rem; background: #161b22; border-bottom: 1px solid #30363d; }
    .brand { font-weight: bold; font-size: 1.2rem; color: #f0f6fc; }
    .nav-links { display: flex; gap: 1rem; }
    .nav-links a { color: #8b949e; padding: 0.25rem 0; border-bottom: 2px solid transparent; transition: color 0.2s, border-color 0.2s; }
    .nav-links a:hover { color: #f0f6fc; text-decoration: none; }
    .nav-links a.active { color: #f0f6fc; border-bottom-color: #58a6ff; }
    .container { max-width: 1200px; margin: 0 auto; padding: 1.5rem; }
    h1 { margin-bottom: 1rem; color: #f0f6fc; }
    h2 { margin: 1.5rem 0 0.75rem; color: #c9d1d9; }
    h3 { margin: 1rem 0 0.5rem; color: #c9d1d9; }
    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; text-align: center; }
    .stat-value { font-size: 2rem; font-weight: bold; color: #58a6ff; }
    .stat-label { color: #8b949e; font-size: 0.875rem; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
    .list-item { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid #21262d; }
    .list-item:last-child { border-bottom: none; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; background: #30363d; color: #8b949e; }
    .badge-idle { background: #1f2937; color: #6b7280; }
    .badge-busy, .badge-running { background: #0d419d; color: #58a6ff; }
    .badge-error, .badge-failed { background: #5c1a1a; color: #f85149; }
    .badge-stopped { background: #3b2e00; color: #d29922; }
    .badge-draft { background: #1c2333; color: #8b949e; }
    .badge-approved { background: #1a3a2a; color: #3fb950; }
    .badge-completed { background: #1a3a2a; color: #3fb950; }
    .badge-open { background: #5c1a1a; color: #f85149; }
    .badge-resolved { background: #1a3a2a; color: #3fb950; }
    .priority { color: #d29922; font-size: 0.875rem; margin-left: auto; }
    .muted { color: #8b949e; font-size: 0.875rem; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
    .data-table { width: 100%; border-collapse: collapse; }
    .data-table th { text-align: left; padding: 0.5rem; border-bottom: 2px solid #30363d; color: #8b949e; font-size: 0.875rem; }
    .data-table td { padding: 0.5rem; border-bottom: 1px solid #21262d; }
    .data-table tbody tr { transition: background-color 0.15s; }
    .data-table tbody tr:hover { background-color: #1c2128; }
    .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
    .detail-desc { margin-top: 1rem; }
    .detail-desc pre { background: #0d1117; padding: 0.75rem; border-radius: 4px; overflow-x: auto; font-size: 0.875rem; margin-top: 0.25rem; }
    button, .btn-sm { background: #238636; color: #fff; border: none; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.875rem; transition: background-color 0.2s, transform 0.1s; }
    button:hover { background: #2ea043; }
    button:active { transform: scale(0.98); }
    .btn-sm { padding: 0.25rem 0.5rem; font-size: 0.75rem; }
    .btn-danger { background: #da3633; }
    .btn-danger:hover { background: #f85149; }
    form label { display: block; margin-bottom: 0.75rem; color: #c9d1d9; font-size: 0.875rem; }
    form input, form textarea, form select { display: block; width: 100%; margin-top: 0.25rem; padding: 0.5rem; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #e1e4e8; font-size: 0.875rem; transition: border-color 0.2s, box-shadow 0.2s; outline: none; }
    form input:focus, form textarea:focus, form select:focus { border-color: #58a6ff; box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.3); }
    .inline-form { display: flex; gap: 0.5rem; align-items: flex-end; }
    .inline-form input { width: auto; }
    .terminal { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 0.75rem; max-height: 500px; overflow-y: auto; font-family: "SF Mono", "Fira Code", monospace; font-size: 0.8rem; white-space: pre-wrap; word-break: break-all; }
    .terminal-line { padding: 1px 0; }
    .terminal-stdout { color: #e1e4e8; }
    .terminal-stderr { color: #f85149; }
    .escalation-card { margin-bottom: 0.75rem; }
    .escalation-header { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
    .escalation-question { margin-bottom: 0.5rem; }
    .escalation-response { margin-top: 0.5rem; padding: 0.5rem; background: #1a3a2a; border-radius: 4px; }
    .escalation-form textarea { margin-bottom: 0.5rem; }
    .badge-pending { background: #1c2333; color: #8b949e; }
    .phase-stepper { display: flex; align-items: flex-start; gap: 0; margin: 1rem 0; padding: 1rem; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow-x: auto; }
    .phase-step { display: flex; flex-direction: column; align-items: center; position: relative; min-width: 80px; }
    .phase-circle { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 600; z-index: 1; }
    .phase-name { font-size: 0.75rem; margin-top: 0.25rem; text-align: center; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .phase-step-done .phase-circle { background: #238636; color: #fff; }
    .phase-step-active .phase-circle { background: #1f6feb; color: #fff; box-shadow: 0 0 8px #1f6feb; }
    .phase-step-pending .phase-circle { background: #30363d; color: #8b949e; }
    .phase-connector { position: absolute; top: 16px; right: 50%; width: 100%; height: 2px; background: #30363d; z-index: 0; }
    .phase-connector-done { background: #238636; }
    .artifact-card { margin-bottom: 0.75rem; }
    .artifact-header { display: flex; gap: 0.5rem; align-items: center; }
    .artifact-path { margin-top: 0.25rem; }
    .badge-artifact-file { background: #1c2333; color: #58a6ff; }
    .badge-artifact-log { background: #3b2e00; color: #d29922; }
    .badge-artifact-report { background: #1a3a2a; color: #3fb950; }
    details.artifact-content { margin-top: 0.5rem; }
    details.artifact-content pre { background: #0d1117; padding: 0.75rem; border-radius: 4px; overflow-x: auto; font-size: 0.8rem; max-height: 300px; overflow-y: auto; }
    .help-diagram { background: #0d1117; padding: 1rem; border-radius: 4px; overflow-x: auto; font-family: "SF Mono", "Fira Code", monospace; font-size: 0.85rem; line-height: 1.4; color: #58a6ff; border: 1px solid #30363d; }
    .loading-bar { position: fixed; top: 0; left: 0; width: 100%; height: 3px; background: transparent; z-index: 9999; pointer-events: none; }
    .htmx-request .loading-bar, .htmx-request.loading-bar { background: linear-gradient(90deg, #58a6ff 0%, #1f6feb 50%, #58a6ff 100%); background-size: 200% 100%; animation: loading-slide 1.5s ease-in-out infinite; }
    @keyframes loading-slide { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .empty-state { text-align: center; padding: 2rem 1rem; color: #8b949e; }
    .empty-state-icon { font-size: 2rem; margin-bottom: 0.5rem; opacity: 0.6; }
    .empty-state p { margin: 0.25rem 0; }
    .activity-feed { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 0.5rem 0.75rem; min-height: 60px; }
    .activity-entry { display: flex; align-items: baseline; gap: 0.5rem; padding: 0.35rem 0; border-bottom: 1px solid #21262d; flex-wrap: wrap; }
    .activity-entry:last-child { border-bottom: none; }
    .activity-agent { font-weight: 600; color: #58a6ff; font-size: 0.85rem; flex-shrink: 0; }
    .activity-data { color: #e1e4e8; font-size: 0.78rem; font-family: "SF Mono", "Fira Code", monospace; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .activity-time { flex-shrink: 0; }
    .badge-stream-stdout { background: #1c2333; color: #79c0ff; }
    .badge-stream-stderr { background: #5c1a1a; color: #f85149; }
    .terminal-section-header { display: flex; align-items: center; gap: 1rem; margin: 1.5rem 0 0.5rem; }
    .terminal-section-header h2 { margin: 0; }
    .terminal-line-count { font-size: 0.8rem; }
    .last-output-cell { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `;
}
