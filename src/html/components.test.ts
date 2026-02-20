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
    expect(html).toContain("Phase Progress");
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
