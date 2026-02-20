// Server-rendered HTML components for HTMX UI

export function layout(title: string, content: string): string {
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
      <a href="/" hx-get="/" hx-target="body" hx-push-url="true">Dashboard</a>
      <a href="/tasks" hx-get="/tasks" hx-target="body" hx-push-url="true">Tasks</a>
      <a href="/agents" hx-get="/agents" hx-target="body" hx-push-url="true">Agents</a>
      <a href="/teams" hx-get="/teams" hx-target="body" hx-push-url="true">Teams</a>
      <a href="/escalations" hx-get="/escalations" hx-target="body" hx-push-url="true">Escalations</a>
    </div>
  </nav>
  <main class="container">${content}</main>
</body>
</html>`;
}

// --- Dashboard ---

export interface DashboardData {
  tasks: { id: string; title: string; status: string; priority: number }[];
  agents: { id: string; name: string; status: string; type: string; current_task_id: string | null }[];
  daemon: { state: "running" | "pausing" | "paused" | "stopped"; uptime: number };
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
          ${activeTasks.length === 0 ? "<p class='muted'>No active tasks</p>" : activeTasks.map(taskRow).join("")}
        </div>
      </section>

      <section>
        <h2>Agent Status</h2>
        <div id="agent-status" hx-ext="sse" sse-connect="/events/agents" sse-swap="agent:state_changed" hx-swap="innerHTML">
          ${data.agents.length === 0 ? "<p class='muted'>No agents configured</p>" : data.agents.map(agentStatusRow).join("")}
        </div>
      </section>
    </div>`,
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

// --- Tasks ---

export interface TaskData {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: number;
  current_phase: number;
  team_id?: string;
  phases?: { name: string; prompt: string }[];
  created_at: string;
  result?: unknown;
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
      ${tasks.length === 0 ? "<p class='muted'>No tasks yet</p>" : `<table class="data-table">
        <thead><tr><th>Status</th><th>Title</th><th>Priority</th><th>Phase</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>${tasks.map(taskTableRow).join("")}</tbody>
      </table>`}
    </div>`,
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
    <td>${escapeHtml(task.created_at)}</td>
    <td>${actions.join(" ")}</td>
  </tr>`;
}

export function taskDetailPage(task: TaskData): string {
  return layout(
    task.title,
    `<a href="/tasks" hx-get="/tasks" hx-target="body" hx-push-url="true">&larr; Back to Tasks</a>
    <h1>${escapeHtml(task.title)}</h1>
    <div class="card">
      <div class="detail-grid">
        <div><strong>Status:</strong> <span class="badge badge-${task.status}">${task.status}</span></div>
        <div><strong>Priority:</strong> P${task.priority}</div>
        <div><strong>Team:</strong> ${task.team_id ? escapeHtml(task.team_id) : "None"}</div>
        <div><strong>Created:</strong> ${escapeHtml(task.created_at)}</div>
      </div>
      ${task.description ? `<div class="detail-desc"><strong>Description:</strong><p>${escapeHtml(task.description)}</p></div>` : ""}
      ${task.result ? `<div class="detail-desc"><strong>Result:</strong><pre>${escapeHtml(JSON.stringify(task.result, null, 2))}</pre></div>` : ""}
    </div>
    ${phaseStepper(task.current_phase, task.phases)}`,
  );
}

function phaseStepper(currentPhase: number, phases?: { name: string; prompt: string }[]): string {
  if (!phases || phases.length === 0) {
    return `<div class="card"><strong>Phase:</strong> ${currentPhase}</div>`;
  }

  const steps = phases.map((phase, index) => {
    const isDone = index < currentPhase;
    const isActive = index === currentPhase;
    const stateClass = isDone ? "phase-step-done" : isActive ? "phase-step-active" : "phase-step-pending";
    const connector = index < phases.length - 1 ? `<div class="phase-connector${isDone ? " phase-connector-done" : ""}"></div>` : "";
    return `<div class="phase-step ${stateClass}">
      <div class="phase-circle">${isDone ? "&#10003;" : index + 1}</div>
      <div class="phase-name">${escapeHtml(phase.name)}</div>
    </div>${connector}`;
  }).join("");

  return `<h2>Phase Progress</h2>
  <div class="card">
    <div class="phase-stepper">${steps}</div>
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
      ${agents.length === 0 ? "<p class='muted'>No agents configured</p>" : `<table class="data-table">
        <thead><tr><th>Status</th><th>Name</th><th>Type</th><th>Model</th><th>PID</th><th>Task</th><th>Actions</th></tr></thead>
        <tbody>${agents.map(agentTableRow).join("")}</tbody>
      </table>`}
    </div>`,
  );
}

export function agentListFragment(agents: AgentData[]): string {
  return agents.length === 0
    ? "<p class='muted'>No agents configured</p>"
    : `<table class="data-table">
        <thead><tr><th>Status</th><th>Name</th><th>Type</th><th>Model</th><th>PID</th><th>Task</th><th>Actions</th></tr></thead>
        <tbody>${agents.map(agentTableRow).join("")}</tbody>
      </table>`;
}

function agentTableRow(agent: AgentData): string {
  return `<tr>
    <td><span class="badge badge-${agent.status}">${agent.status}</span></td>
    <td><a href="/agents/${escapeHtml(agent.id)}" hx-get="/agents/${escapeHtml(agent.id)}" hx-target="body" hx-push-url="true">${escapeHtml(agent.name)}</a></td>
    <td>${escapeHtml(agent.type)}</td>
    <td>${escapeHtml(agent.model)}</td>
    <td>${agent.process_pid ?? "-"}</td>
    <td>${agent.current_task_id ? escapeHtml(agent.current_task_id.slice(0, 8)) : "-"}</td>
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

    <h2>Terminal Output</h2>
    <div id="terminal" class="terminal" hx-ext="sse" sse-connect="/events/agent/${escapeHtml(agent.id)}/output" sse-swap="agent:output" hx-swap="beforeend scroll:bottom">
      <div hx-get="/agents/${escapeHtml(agent.id)}/output" hx-trigger="load" hx-swap="innerHTML"></div>
    </div>`,
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
    ? "<p class='muted'>No teams configured</p>"
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
        <div><strong>Phases:</strong> ${team.phases.length}</div>
      </div>
    </div>

    <h2>Members</h2>
    ${agents.length === 0 ? "<p class='muted'>No agents in this team</p>" : `<table class="data-table">
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
      ${open.length === 0 ? "<p class='muted'>No open escalations</p>" : open.map(escalationCard).join("")}
    </div>

    <h2>Resolved (${resolved.length})</h2>
    ${resolved.length === 0 ? "<p class='muted'>No resolved escalations</p>" : resolved.map(escalationCard).join("")}`,
  );
}

function escalationCard(esc: EscalationData): string {
  return `<div class="card escalation-card">
    <div class="escalation-header">
      <span class="badge badge-${esc.status}">${esc.status}</span>
      <span class="badge">${escapeHtml(esc.type)}</span>
      <span class="muted">${escapeHtml(esc.created_at)}</span>
    </div>
    <div class="escalation-question"><strong>Question:</strong> ${escapeHtml(esc.question)}</div>
    <div class="muted">Agent: ${escapeHtml(esc.agent_id.slice(0, 8))} | Task: ${escapeHtml(esc.task_id.slice(0, 8))}</div>
    ${esc.status === "open" ? `<form hx-post="/api/escalations/${escapeHtml(esc.id)}/resolve" hx-target="body" hx-swap="innerHTML" class="escalation-form">
      <textarea name="response" placeholder="Type your response..." rows="3" required></textarea>
      <button type="submit">Respond</button>
    </form>` : `<div class="escalation-response"><strong>Response:</strong> ${esc.response ? escapeHtml(esc.response) : "-"}</div>`}
  </div>`;
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
    .nav-links a { color: #8b949e; }
    .nav-links a:hover { color: #f0f6fc; }
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
    .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
    .detail-desc { margin-top: 1rem; }
    .detail-desc pre { background: #0d1117; padding: 0.75rem; border-radius: 4px; overflow-x: auto; font-size: 0.875rem; margin-top: 0.25rem; }
    button, .btn-sm { background: #238636; color: #fff; border: none; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.875rem; }
    button:hover { background: #2ea043; }
    .btn-sm { padding: 0.25rem 0.5rem; font-size: 0.75rem; }
    .btn-danger { background: #da3633; }
    .btn-danger:hover { background: #f85149; }
    form label { display: block; margin-bottom: 0.75rem; color: #c9d1d9; font-size: 0.875rem; }
    form input, form textarea, form select { display: block; width: 100%; margin-top: 0.25rem; padding: 0.5rem; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #e1e4e8; font-size: 0.875rem; }
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
    .phase-stepper { display: flex; align-items: center; flex-wrap: wrap; gap: 0; padding: 0.5rem 0; }
    .phase-step { display: flex; flex-direction: column; align-items: center; gap: 0.35rem; min-width: 80px; }
    .phase-circle { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: bold; border: 2px solid #30363d; background: #0d1117; color: #8b949e; }
    .phase-name { font-size: 0.75rem; color: #8b949e; text-align: center; max-width: 90px; word-break: break-word; }
    .phase-step-done .phase-circle { background: #1a3a2a; border-color: #3fb950; color: #3fb950; }
    .phase-step-done .phase-name { color: #3fb950; }
    .phase-step-active .phase-circle { background: #0d419d; border-color: #58a6ff; color: #58a6ff; box-shadow: 0 0 0 3px rgba(88,166,255,0.2); }
    .phase-step-active .phase-name { color: #58a6ff; font-weight: bold; }
    .phase-connector { flex: 1; height: 2px; background: #30363d; min-width: 20px; margin-bottom: 1.2rem; }
    .phase-connector-done { background: #3fb950; }
  `;
}
