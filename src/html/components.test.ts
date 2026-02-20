import { describe, it, expect } from "bun:test";
import {
  dashboardPage,
  tasksPage,
  taskDetailPage,
  agentsPage,
  agentListFragment,
  agentDetailPage,
  teamsPage,
  teamListFragment,
  teamDetailPage,
  escalationsPage,
  terminalOutputFragment,
  helpPage,
  formatTimestamp,
  recentActivityFragment,
} from "./components";

describe("layout", () => {
  it("includes HTMX script and navigation", () => {
    const html = dashboardPage({ tasks: [], agents: [], daemon: { state: "running", uptime: 100 } });
    expect(html).toContain("htmx.org");
    expect(html).toContain("htmx-ext-sse");
    expect(html).toContain("PlayHive");
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/tasks"');
    expect(html).toContain('href="/agents"');
    expect(html).toContain('href="/teams"');
    expect(html).toContain('href="/escalations"');
  });
});

describe("dashboardPage", () => {
  it("renders empty state", () => {
    const html = dashboardPage({ tasks: [], agents: [], daemon: { state: "running", uptime: 100 } });
    expect(html).toContain("Dashboard");
    expect(html).toContain("No active tasks");
    expect(html).toContain("No agents configured");
  });

  it("renders tasks and agents", () => {
    const html = dashboardPage({
      tasks: [
        { id: "t1", title: "Build feature", status: "running", priority: 3 },
        { id: "t2", title: "Fix bug", status: "approved", priority: 1 },
      ],
      agents: [
        { id: "a1", name: "Dev Agent", status: "busy", type: "claude-code", current_task_id: "t1" },
      ],
      daemon: { state: "running", uptime: 100 },
    });
    expect(html).toContain("Build feature");
    expect(html).toContain("Fix bug");
    expect(html).toContain("Dev Agent");
    expect(html).toContain("badge-running");
    expect(html).toContain("badge-busy");
  });

  it("shows correct stat counts", () => {
    const html = dashboardPage({
      tasks: [
        { id: "t1", title: "A", status: "running", priority: 5 },
        { id: "t2", title: "B", status: "completed", priority: 5 },
      ],
      agents: [
        { id: "a1", name: "X", status: "busy", type: "claude-code", current_task_id: "t1" },
        { id: "a2", name: "Y", status: "idle", type: "codex", current_task_id: null },
      ],
      daemon: { state: "running", uptime: 100 },
    });
    // 2 total tasks, 1 active, 2 agents, 1 busy
    expect(html).toContain(">2<"); // total tasks
    expect(html).toContain(">1<"); // active or busy
  });

  it("connects to SSE endpoints for real-time updates", () => {
    const html = dashboardPage({ tasks: [], agents: [], daemon: { state: "running", uptime: 100 } });
    expect(html).toContain('sse-connect="/events/tasks"');
    expect(html).toContain('sse-connect="/events/agents"');
  });

  it("shows daemon status badge", () => {
    const running = dashboardPage({ tasks: [], agents: [], daemon: { state: "running", uptime: 100 } });
    expect(running).toContain("Daemon");
    expect(running).toContain("running");

    const stopped = dashboardPage({ tasks: [], agents: [], daemon: { state: "stopped", uptime: 0 } });
    expect(stopped).toContain("stopped");
  });
});

describe("tasksPage", () => {
  it("renders empty state", () => {
    const html = tasksPage([]);
    expect(html).toContain("No tasks yet");
    expect(html).toContain("New Task");
  });

  it("renders task table with actions", () => {
    const html = tasksPage([
      { id: "t1", title: "Draft Task", status: "draft", priority: 5, current_phase: 0, created_at: "2024-01-01" },
      { id: "t2", title: "Running Task", status: "running", priority: 3, current_phase: 1, created_at: "2024-01-02" },
      { id: "t3", title: "Failed Task", status: "failed", priority: 8, current_phase: 0, created_at: "2024-01-03" },
    ]);
    expect(html).toContain("Draft Task");
    expect(html).toContain("Running Task");
    expect(html).toContain("Failed Task");
    expect(html).toContain("Approve");
    expect(html).toContain("Cancel");
    expect(html).toContain("Retry");
  });

  it("includes create form", () => {
    const html = tasksPage([]);
    expect(html).toContain('hx-post="/api/tasks"');
    expect(html).toContain('name="title"');
    expect(html).toContain('name="priority"');
  });

  it("renders team dropdown options", () => {
    const html = tasksPage([], [
      { id: "team-1", name: "Platform Team" },
      { id: "team-2", name: "UX Team" },
    ]);
    expect(html).toContain('name="teamId"');
    expect(html).toContain("Platform Team");
    expect(html).toContain("UX Team");
  });
});

describe("taskDetailPage", () => {
  it("renders task details", () => {
    const html = taskDetailPage({
      id: "t1",
      title: "Test Task",
      description: "A description",
      status: "running",
      priority: 3,
      current_phase: 2,
      team_id: "team1",
      created_at: "2024-01-01",
    });
    expect(html).toContain("Test Task");
    expect(html).toContain("A description");
    expect(html).toContain("badge-running");
    expect(html).toContain("P3");
    expect(html).toContain("Back to Tasks");
  });

  it("shows edit form for draft tasks", () => {
    const html = taskDetailPage({
      id: "t1",
      title: "Draft Task",
      status: "draft",
      priority: 3,
      current_phase: 0,
      created_at: "2024-01-01",
    });
    expect(html).toContain("Edit Task");
    expect(html).toContain('hx-post="/api/tasks/t1"');
    expect(html).toContain("Save Changes");
  });

  it("shows non-editable message for non-draft tasks", () => {
    const html = taskDetailPage({
      id: "t1",
      title: "Running Task",
      status: "running",
      priority: 3,
      current_phase: 1,
      created_at: "2024-01-01",
    });
    expect(html).toContain("Only draft tasks can be edited");
  });

  it("shows plain phase number when no phases provided", () => {
    const html = taskDetailPage({
      id: "t1",
      title: "Test Task",
      status: "draft",
      priority: 5,
      current_phase: 0,
      created_at: "2024-01-01",
    });
    expect(html).toContain("Phase:");
    expect(html).toContain("0");
    expect(html).not.toContain('class="phase-stepper"');
  });

  it("renders phase stepper when phases are provided", () => {
    const html = taskDetailPage({
      id: "t1",
      title: "Test Task",
      status: "running",
      priority: 3,
      current_phase: 1,
      team_id: "team1",
      phases: [
        { name: "Planning", prompt: "Plan the work" },
        { name: "Execution", prompt: "Do the work" },
        { name: "Review", prompt: "Review the work" },
      ],
      created_at: "2024-01-01",
    });
    expect(html).toContain("phase-stepper");
    expect(html).toContain("Planning");
    expect(html).toContain("Execution");
    expect(html).toContain("Review");
    expect(html).toContain("phase-step-done");
    expect(html).toContain("phase-step-active");
    expect(html).toContain("phase-step-pending");
  });

  it("marks completed phases as done and active phase correctly", () => {
    const html = taskDetailPage({
      id: "t1",
      title: "Test Task",
      status: "running",
      priority: 5,
      current_phase: 2,
      phases: [
        { name: "Alpha", prompt: "p1" },
        { name: "Beta", prompt: "p2" },
        { name: "Gamma", prompt: "p3" },
        { name: "Delta", prompt: "p4" },
      ],
      created_at: "2024-01-01",
    });
    expect(html).toContain("Gamma");
    // phases 0 and 1 are done, 2 is active, 3 is pending
    // Match the step div elements specifically (not CSS rules)
    const doneCount = (html.match(/class="phase-step phase-step-done"/g) || []).length;
    const activeCount = (html.match(/class="phase-step phase-step-active"/g) || []).length;
    const pendingCount = (html.match(/class="phase-step phase-step-pending"/g) || []).length;
    expect(doneCount).toBe(2);
    expect(activeCount).toBe(1);
    expect(pendingCount).toBe(1);
  });

  it("escapes HTML in phase names", () => {
    const html = taskDetailPage({
      id: "t1",
      title: "Test Task",
      status: "draft",
      priority: 5,
      current_phase: 0,
      phases: [{ name: '<script>alert(1)</script>', prompt: "xss" }],
      created_at: "2024-01-01",
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows empty state when no notes", () => {
    const html = taskDetailPage(
      { id: "t1", title: "Task", status: "running", priority: 5, current_phase: 0, created_at: "2024-01-01" },
      [],
    );
    expect(html).toContain("Notes");
    expect(html).toContain("No notes yet");
  });

  it("renders notes with agent, content, and timestamp", () => {
    const html = taskDetailPage(
      { id: "t1", title: "Task", status: "running", priority: 5, current_phase: 0, created_at: "2024-01-01" },
      [
        { id: "n1", task_id: "t1", agent_id: "agent-abc-12345678", content: "First note content", created_at: "2024-01-02T10:00:00" },
        { id: "n2", task_id: "t1", agent_id: "agent-xyz-87654321", content: "Second note content", created_at: "2024-01-02T11:00:00" },
      ],
    );
    expect(html).toContain("Notes");
    expect(html).not.toContain("No notes yet");
    expect(html).toContain("agent-ab"); // 8 chars of agent_id
    expect(html).toContain("First note content");
    expect(html).toContain("2024-01-02T10:00:00");
    expect(html).toContain("Second note content");
  });

  it("escapes HTML in note content", () => {
    const html = taskDetailPage(
      { id: "t1", title: "Task", status: "running", priority: 5, current_phase: 0, created_at: "2024-01-01" },
      [{ id: "n1", task_id: "t1", agent_id: "agent-id-12345678", content: '<script>alert("xss")</script>', created_at: "2024-01-01" }],
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("agentsPage", () => {
  it("renders empty state", () => {
    const html = agentsPage([]);
    expect(html).toContain("No agents configured");
  });

  it("renders agent table", () => {
    const html = agentsPage([
      { id: "a1", name: "Agent One", type: "claude-code", model: "opus", status: "idle", capabilities: [], config: {}, process_pid: null, current_task_id: null },
    ]);
    expect(html).toContain("Agent One");
    expect(html).toContain("claude-code");
    expect(html).toContain("opus");
    expect(html).toContain("Delete");
  });

  it("hides delete button for busy agents", () => {
    const html = agentsPage([
      { id: "a1", name: "Busy", type: "claude-code", model: "default", status: "busy", capabilities: [], config: {}, process_pid: 1234, current_task_id: "t1" },
    ]);
    expect(html).not.toContain("Delete");
  });
});

describe("agentListFragment", () => {
  it("renders empty state without full page layout", () => {
    const html = agentListFragment([]);
    expect(html).toContain("No agents configured");
    expect(html).not.toContain("<html");
    expect(html).not.toContain("PlayHive");
  });

  it("renders agent table without full page layout", () => {
    const html = agentListFragment([
      { id: "a1", name: "Agent One", type: "claude-code", model: "opus", status: "idle", capabilities: [], config: {}, process_pid: null, current_task_id: null },
    ]);
    expect(html).toContain("Agent One");
    expect(html).toContain("claude-code");
    expect(html).not.toContain("<html");
  });
});

describe("agentDetailPage", () => {
  it("renders agent detail with terminal viewer", () => {
    const html = agentDetailPage({
      id: "a1",
      name: "Dev Agent",
      type: "claude-code",
      model: "opus",
      status: "busy",
      capabilities: ["coding", "testing"],
      config: { goal: "Build features" },
      process_pid: 1234,
      current_task_id: "t1",
    });
    expect(html).toContain("Dev Agent");
    expect(html).toContain("Terminal Output");
    expect(html).toContain('sse-connect="/events/agent/a1/output"');
    expect(html).toContain("Build features");
    expect(html).toContain("coding, testing");
  });

  it("renders editable form for non-busy agents", () => {
    const html = agentDetailPage({
      id: "a1",
      name: "Editor Agent",
      type: "codex",
      model: "default",
      status: "idle",
      capabilities: [],
      config: {},
      process_pid: null,
      current_task_id: null,
    });
    expect(html).toContain("Edit Agent");
    expect(html).toContain('hx-post="/api/agents/a1"');
    expect(html).toContain("Save Changes");
  });

  it("shows session selector when multiple sessions exist", () => {
    const html = agentDetailPage(
      {
        id: "a1", name: "Agent", type: "claude-code", model: "default",
        status: "idle", capabilities: [], config: {}, process_pid: null, current_task_id: null,
      },
      [
        { id: "sess-111", created_at: "2024-01-02T10:00:00" },
        { id: "sess-222", created_at: "2024-01-01T10:00:00" },
      ],
    );
    expect(html).toContain("session-selector");
    expect(html).toContain("2 sessions");
    expect(html).toContain("Latest");
    expect(html).toContain("sess-111");
    expect(html).toContain("sess-222");
  });

  it("disables SSE when viewing historical session", () => {
    const html = agentDetailPage(
      {
        id: "a1", name: "Agent", type: "claude-code", model: "default",
        status: "idle", capabilities: [], config: {}, process_pid: null, current_task_id: null,
      },
      [
        { id: "sess-111", created_at: "2024-01-02T10:00:00" },
        { id: "sess-222", created_at: "2024-01-01T10:00:00" },
      ],
      "sess-222",
    );
    // Should NOT have SSE connection when viewing old session
    expect(html).not.toContain("sse-connect");
    // Should load the selected session's output
    expect(html).toContain("session=sess-222");
  });

  it("enables SSE when viewing latest session", () => {
    const html = agentDetailPage(
      {
        id: "a1", name: "Agent", type: "claude-code", model: "default",
        status: "idle", capabilities: [], config: {}, process_pid: null, current_task_id: null,
      },
      [{ id: "sess-111", created_at: "2024-01-02T10:00:00" }],
    );
    // Should have SSE for live output (no selectedSessionId = latest)
    expect(html).toContain("sse-connect");
  });
});

describe("terminalOutputFragment", () => {
  it("renders stdout and stderr lines", () => {
    const html = terminalOutputFragment([
      { stream: "stdout", data: "hello world", sequence: 1 },
      { stream: "stderr", data: "error msg", sequence: 2 },
    ]);
    expect(html).toContain("terminal-stdout");
    expect(html).toContain("hello world");
    expect(html).toContain("terminal-stderr");
    expect(html).toContain("error msg");
  });

  it("escapes HTML in output", () => {
    const html = terminalOutputFragment([
      { stream: "stdout", data: "<script>alert('xss')</script>", sequence: 1 },
    ]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });
});

describe("teamsPage", () => {
  it("renders empty state", () => {
    const html = teamsPage([]);
    expect(html).toContain("No teams configured");
  });

  it("renders team table", () => {
    const html = teamsPage([
      { id: "t1", name: "Alpha Team", entrypoint_agent_id: "a1", goal: "Ship fast", phases: [{ name: "plan", prompt: "Plan it" }] },
    ]);
    expect(html).toContain("Alpha Team");
    expect(html).toContain("Ship fast");
  });
});

describe("teamListFragment", () => {
  it("renders empty state without full page layout", () => {
    const fragment = teamListFragment([]);
    expect(fragment).toContain("No teams configured");
    expect(fragment).not.toContain("<!DOCTYPE html");
    expect(fragment).not.toContain("<nav");
  });

  it("renders team table without full page layout", () => {
    const fragment = teamListFragment([
      { id: "t1", name: "Beta Team", entrypoint_agent_id: null, goal: "Move fast", phases: [] },
    ]);
    expect(fragment).toContain("Beta Team");
    expect(fragment).toContain("Move fast");
    expect(fragment).toContain("data-table");
    expect(fragment).not.toContain("<!DOCTYPE html");
  });
});

describe("teamDetailPage", () => {
  it("renders team with members", () => {
    const html = teamDetailPage(
      { id: "t1", name: "Alpha", entrypoint_agent_id: "a1", goal: "Ship", phases: [] },
      [{ agent_id: "a1", agent_name: "Dev", role: "lead", level: 0, skills: ["coding"] }],
    );
    expect(html).toContain("Alpha");
    expect(html).toContain("Dev");
    expect(html).toContain("lead");
    expect(html).toContain("coding");
    expect(html).toContain("Add Agent");
  });

  it("renders edit form", () => {
    const html = teamDetailPage(
      { id: "t1", name: "Alpha", entrypoint_agent_id: "a1", goal: "Ship", phases: [] },
      [],
    );
    expect(html).toContain("Edit Team");
    expect(html).toContain('hx-post="/api/teams/t1"');
    expect(html).toContain("Save Changes");
  });

  it("renders add-agent dropdown options", () => {
    const html = teamDetailPage(
      { id: "t1", name: "Alpha", entrypoint_agent_id: null, phases: [] },
      [],
      [{ id: "a2", name: "QA Agent" }],
    );
    expect(html).toContain("Select an agent");
    expect(html).toContain("QA Agent");
  });

  it("renders phases list when phases exist", () => {
    const html = teamDetailPage(
      {
        id: "t1",
        name: "Alpha",
        entrypoint_agent_id: null,
        phases: [
          { name: "Planning", prompt: "Plan carefully" },
          { name: "Execution", prompt: "Execute the plan" },
        ],
      },
      [],
    );
    expect(html).toContain("Phases (2)");
    expect(html).toContain("Planning");
    expect(html).toContain("Plan carefully");
    expect(html).toContain("Execution");
    expect(html).toContain("Execute the plan");
    expect(html).toContain("Remove");
  });

  it("renders empty phases state when no phases", () => {
    const html = teamDetailPage(
      { id: "t1", name: "Alpha", entrypoint_agent_id: null, phases: [] },
      [],
    );
    expect(html).toContain("Phases (0)");
    expect(html).toContain("No phases defined");
  });

  it("shows Add Phase form", () => {
    const html = teamDetailPage(
      { id: "t1", name: "Alpha", entrypoint_agent_id: null, phases: [] },
      [],
    );
    expect(html).toContain('hx-post="/api/teams/t1/phases"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="prompt"');
    expect(html).toContain("Add Phase");
  });

  it("shows delete button with correct route for each phase", () => {
    const html = teamDetailPage(
      {
        id: "t1",
        name: "Alpha",
        entrypoint_agent_id: null,
        phases: [{ name: "Phase 1", prompt: "Do it" }],
      },
      [],
    );
    expect(html).toContain('hx-delete="/api/teams/t1/phases/0"');
  });

  it("truncates long prompts in the phases table", () => {
    const longPrompt = "A".repeat(100);
    const html = teamDetailPage(
      {
        id: "t1",
        name: "Alpha",
        entrypoint_agent_id: null,
        phases: [{ name: "Long Phase", prompt: longPrompt }],
      },
      [],
    );
    expect(html).toContain("…");
    expect(html).not.toContain(longPrompt);
  });

  it("escapes HTML in phase names and prompts", () => {
    const html = teamDetailPage(
      {
        id: "t1",
        name: "Alpha",
        entrypoint_agent_id: null,
        phases: [{ name: '<script>alert(1)</script>', prompt: '<img src=x>' }],
      },
      [],
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("escalationsPage", () => {
  it("renders open and resolved escalations", () => {
    const html = escalationsPage([
      { id: "e1", agent_id: "a1aaaaaa-xxxx", task_id: "t1aaaaaa-xxxx", type: "agent_request", question: "How to proceed?", response: null, status: "open", created_at: "2024-01-01" },
      { id: "e2", agent_id: "a2aaaaaa-xxxx", task_id: "t2aaaaaa-xxxx", type: "max_nudges", question: "Agent stuck", response: "Kill it", status: "resolved", created_at: "2024-01-02" },
    ]);
    expect(html).toContain("Open (1)");
    expect(html).toContain("Resolved (1)");
    expect(html).toContain("How to proceed?");
    expect(html).toContain('name="response"');
    expect(html).toContain("Kill it");
  });

  it("connects to SSE for real-time escalation updates", () => {
    const html = escalationsPage([]);
    expect(html).toContain('sse-connect="/events/escalations"');
  });
});

describe("helpPage", () => {
  it("renders all major sections", () => {
    const html = helpPage();
    expect(html).toContain("PlayHive Help");
    expect(html).toContain("Platform Overview");
    expect(html).toContain("Core Concepts");
    expect(html).toContain("Task Lifecycle");
    expect(html).toContain("Team Hierarchy");
    expect(html).toContain("Phase Execution");
    expect(html).toContain("Delegation Flow");
    expect(html).toContain("Escalation Flow");
    expect(html).toContain("Signal System");
    expect(html).toContain("Features Guide");
    expect(html).toContain("Daemon Controls");
    expect(html).toContain("Workflow Example");
  });

  it("includes signal documentation", () => {
    const html = helpPage();
    expect(html).toContain("[PHASE_COMPLETE]");
    expect(html).toContain("[DELEGATE]");
    expect(html).toContain("[ESCALATE]");
    expect(html).toContain("[NOTE]");
    expect(html).toContain("[ARTIFACT]");
  });

  it("includes navigation link to help page", () => {
    const html = helpPage();
    expect(html).toContain('href="/help"');
  });

  it("contains ASCII diagrams", () => {
    const html = helpPage();
    expect(html).toContain("help-diagram");
    expect(html).toContain("draft");
    expect(html).toContain("approved");
    expect(html).toContain("Entrypoint Agent");
  });
});

describe("XSS prevention", () => {
  it("escapes HTML in task titles", () => {
    const html = tasksPage([
      { id: "t1", title: '<img src=x onerror="alert(1)">', status: "draft", priority: 5, current_phase: 0, created_at: "now" },
    ]);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain("&lt;img");
  });

  it("escapes HTML in agent names", () => {
    const html = agentsPage([
      { id: "a1", name: '"><script>alert(1)</script>', type: "claude-code", model: "default", status: "idle", capabilities: [], config: {}, process_pid: null, current_task_id: null },
    ]);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("formatTimestamp", () => {
  it("returns relative time for recent timestamps", () => {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const result = formatTimestamp(fiveMinAgo);
    expect(result).toContain("5m ago");
    expect(result).toContain("title=");
  });

  it("returns 'just now' for very recent timestamps", () => {
    const now = new Date().toISOString();
    const result = formatTimestamp(now);
    expect(result).toContain("just now");
  });

  it("returns hours ago for older timestamps", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const result = formatTimestamp(threeHoursAgo);
    expect(result).toContain("3h ago");
  });

  it("returns days ago for multi-day timestamps", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const result = formatTimestamp(twoDaysAgo);
    expect(result).toContain("2d ago");
  });

  it("returns original string for invalid dates", () => {
    const result = formatTimestamp("not-a-date");
    expect(result).toContain("not-a-date");
  });

  it("includes full timestamp in title attribute", () => {
    const ts = new Date(Date.now() - 60 * 1000).toISOString();
    const result = formatTimestamp(ts);
    expect(result).toContain(`title="${ts}"`);
  });
});

describe("active nav indicator", () => {
  it("marks Dashboard as active on dashboard page", () => {
    const html = dashboardPage({ tasks: [], agents: [], daemon: { state: "running", uptime: 100 } });
    expect(html).toContain('hx-get="/" hx-target="body" hx-push-url="true" class="active"');
  });

  it("marks Tasks as active on tasks page", () => {
    const html = tasksPage([]);
    expect(html).toContain('hx-get="/tasks" hx-target="body" hx-push-url="true" class="active"');
  });

  it("marks Agents as active on agent detail page", () => {
    const html = agentDetailPage({
      id: "a1", name: "Agent", type: "claude-code", model: "default",
      status: "idle", capabilities: [], config: {}, process_pid: null, current_task_id: null,
    });
    expect(html).toContain('hx-get="/agents" hx-target="body" hx-push-url="true" class="active"');
  });

  it("does not mark other nav items as active", () => {
    const html = tasksPage([]);
    expect(html).not.toContain('hx-get="/" hx-target="body" hx-push-url="true" class="active"');
  });
});

describe("UI polish", () => {
  it("includes loading bar indicator", () => {
    const html = dashboardPage({ tasks: [], agents: [], daemon: { state: "running", uptime: 100 } });
    expect(html).toContain("loading-bar");
    expect(html).toContain("htmx-request");
  });

  it("includes table row hover styles", () => {
    const html = dashboardPage({ tasks: [], agents: [], daemon: { state: "running", uptime: 100 } });
    expect(html).toContain("data-table tbody tr:hover");
  });

  it("includes form focus styles", () => {
    const html = dashboardPage({ tasks: [], agents: [], daemon: { state: "running", uptime: 100 } });
    expect(html).toContain("form input:focus");
    expect(html).toContain("box-shadow");
  });

  it("includes button transitions", () => {
    const html = dashboardPage({ tasks: [], agents: [], daemon: { state: "running", uptime: 100 } });
    expect(html).toContain("transition:");
  });

  it("renders styled empty states", () => {
    const html = tasksPage([]);
    expect(html).toContain("empty-state");
    expect(html).toContain("empty-state-icon");
    expect(html).toContain("Create your first task");
  });

  it("renders styled empty states for agents", () => {
    const html = agentsPage([]);
    expect(html).toContain("empty-state");
    expect(html).toContain("Create an agent");
  });

  it("renders styled empty states for escalations", () => {
    const html = escalationsPage([]);
    expect(html).toContain("empty-state");
    expect(html).toContain("All clear");
  });
});

describe("STORY-003: agent log preview", () => {
  it("dashboard shows Recent Agent Activity section with SSE connection", () => {
    const html = dashboardPage({ tasks: [], agents: [], daemon: { state: "running", uptime: 0 } });
    expect(html).toContain("Recent Agent Activity");
    expect(html).toContain('sse-connect="/events/logs"');
    expect(html).toContain('sse-swap="logs:activity"');
  });

  it("dashboard shows empty activity state when no logs", () => {
    const html = dashboardPage({ tasks: [], agents: [], daemon: { state: "running", uptime: 0 }, recentLogs: [] });
    expect(html).toContain("No recent activity");
  });

  it("dashboard shows recent log entries with agent name, stream badge, content, and timestamp", () => {
    const html = dashboardPage({
      tasks: [],
      agents: [],
      daemon: { state: "running", uptime: 0 },
      recentLogs: [
        { agent_id: "a1", agent_name: "Dev Agent", stream: "stdout", data: "Building project...", created_at: "2024-01-01T10:00:00" },
        { agent_id: "a2", agent_name: "Test Agent", stream: "stderr", data: "Error: test failed", created_at: "2024-01-01T10:01:00" },
      ],
    });
    expect(html).toContain("Dev Agent");
    expect(html).toContain("Test Agent");
    expect(html).toContain("Building project...");
    expect(html).toContain("Error: test failed");
    expect(html).toContain("badge-stream-stdout");
    expect(html).toContain("badge-stream-stderr");
  });

  it("recentActivityFragment renders entries and escapes HTML", () => {
    const html = recentActivityFragment([
      { agent_id: "a1", agent_name: "<bad>", stream: "stdout", data: '<script>xss</script>', created_at: "2024-01-01T00:00:00" },
    ]);
    expect(html).not.toContain("<bad>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;bad&gt;");
    expect(html).toContain("&lt;script&gt;");
  });

  it("recentActivityFragment truncates long data lines", () => {
    const longData = "X".repeat(150);
    const html = recentActivityFragment([
      { agent_id: "a1", agent_name: "Agent", stream: "stdout", data: longData, created_at: "2024-01-01T00:00:00" },
    ]);
    expect(html).toContain("…");
    expect(html).not.toContain(longData);
  });

  it("agent detail page shows terminal output before edit form", () => {
    const html = agentDetailPage({
      id: "a1", name: "Dev Agent", type: "claude-code", model: "opus",
      status: "idle", capabilities: [], config: {}, process_pid: null, current_task_id: null,
    });
    const terminalPos = html.indexOf("Terminal Output");
    const editPos = html.indexOf("Edit Agent");
    expect(terminalPos).toBeGreaterThan(-1);
    expect(editPos).toBeGreaterThan(-1);
    expect(terminalPos).toBeLessThan(editPos);
  });

  it("agent detail page shows line count indicator", () => {
    const html = agentDetailPage({
      id: "a1", name: "Dev Agent", type: "claude-code", model: "opus",
      status: "idle", capabilities: [], config: {}, process_pid: null, current_task_id: null,
    });
    expect(html).toContain("terminal-line-count");
  });

  it("agent list shows Last Output column header", () => {
    const html = agentsPage([
      { id: "a1", name: "Agent One", type: "claude-code", model: "opus", status: "idle", capabilities: [], config: {}, process_pid: null, current_task_id: null },
    ]);
    expect(html).toContain("Last Output");
  });

  it("agent list shows last output line for agent", () => {
    const html = agentsPage([
      {
        id: "a1", name: "Agent One", type: "claude-code", model: "opus",
        status: "idle", capabilities: [], config: {}, process_pid: null, current_task_id: null,
        lastOutput: { stream: "stdout", data: "Working on task..." },
      },
    ]);
    expect(html).toContain("Working on task...");
    expect(html).toContain("badge-stream-stdout");
  });

  it("agent list shows dash when no last output", () => {
    const html = agentsPage([
      {
        id: "a1", name: "Agent One", type: "claude-code", model: "opus",
        status: "idle", capabilities: [], config: {}, process_pid: null, current_task_id: null,
        lastOutput: null,
      },
    ]);
    expect(html).toContain("—");
  });
});
