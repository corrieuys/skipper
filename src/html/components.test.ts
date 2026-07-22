import { describe, it, expect } from "bun:test";
import {
  taskListPollingFragment,
  taskDetailSummaryFragment,
  taskPhaseStepperFragment,
  taskDelegationsFragment,
  agentDetailSummaryFragment,
  teamListFragment,
  teamListPollingFragment,
  teamDetailSummaryFragment,
  teamMembersFragment,
  logsTableFragment,
  terminalOutputFragment,
} from "./components";
import { formatTimestamp } from "./formatTimestamp";
import { logsPage } from "./pages/logs.page";
import { daemonControlFragment } from "./daemonControlFragment";
import { recentActivityFragment } from "./recentActivityFragment";
import { realtimeTaskDetailPage } from "./realtime-components";


describe("daemonControlFragment", () => {
  it("renders a compact pause control when the daemon is running", () => {
    const html = daemonControlFragment({ state: "running", uptime: 100 }, true);
    expect(html).toContain('id="daemon-global-control"');
    expect(html).toContain("Pause Daemon");
    expect(html).toContain('class="btn-danger daemon-kill-btn"');
  });

  it("renders a compact resume control when the daemon is paused", () => {
    const html = daemonControlFragment({ state: "paused", uptime: 100 }, true);
    expect(html).toContain("Resume Daemon");
    expect(html).not.toContain("Pause Daemon");
  });
});



describe("logsPage", () => {
  const baseVm = { daemonState: "running", daemonUptime: 0, escalationCount: 0 };

  it("renders logs table fragment with selected filters", () => {
    const html = logsPage({
      ...baseVm,
      entries: [],
      filters: { agent_id: "agent-1", stream: "stderr" },
      agents: [{ id: "agent-1", name: "Agent One" }],
    });
    expect(html).toContain('id="log-entries"');
    expect(html).toContain("agent_id=agent-1");
    expect(html).toContain("stream=stderr");
  });

  it("disables websocket live target when filters are active", () => {
    const html = logsPage({
      ...baseVm,
      entries: [],
      filters: { agent_id: "agent-1" },
      agents: [{ id: "agent-1", name: "Agent One" }],
    });
    expect(html).toContain('id="log-entries-body-filtered"');
    expect(html).not.toContain('id="log-entries-body"');
    expect(html).toContain("Filtered View");
    expect(html).toContain("Live feed paused");
  });
});


describe("fragment containers", () => {
  it("renders task list fragment with stable ID", () => {
    const html = taskListPollingFragment([]);
    expect(html).toContain('id="task-list"');
    // No polling attributes — updates via WebSocket push
    expect(html).not.toContain('hx-trigger="every');
  });

  it("renders task detail fragments with stable IDs", () => {
    const task = {
      id: "task-1",
      title: "Task",
      status: "running",
      current_phase: 1,
      created_at: "2024-01-01",
      phases: [{ name: "Plan", prompt: "Plan it" }],
    };
    expect(taskDetailSummaryFragment(task)).toContain('id="task-summary-fragment"');
    expect(taskPhaseStepperFragment(task)).toContain('id="task-phases-fragment"');
    expect(taskDelegationsFragment(task.id, [])).toContain('id="task-delegations-fragment"');
  });

  it("renders delegation prompts as expandable details with full text", () => {
    const html = taskDelegationsFragment(
      "task-1",
      [{
        id: "d1",
        parent_agent_id: "a1",
        child_agent_id: "a2",
        parent_agent_name: "Parent",
        child_agent_name: "Child",
        task_id: "task-1",
        prompt: "This is a very long delegation prompt that should be fully readable when expanded by the user.",
        result: null,
        status: "running",
        created_at: "2024-01-01T00:00:00Z",
        completed_at: null,
      }],
    );
    expect(html).toContain('class="delegation-prompt"');
    expect(html).toContain("<summary");
    expect(html).toContain("fully readable when expanded");
  });

  it("renders agent fragments with stable IDs", () => {
    const agent = {
      id: "a1",
      name: "Agent One",
      type: "codex",
      model: "default",
      status: "idle",
      capabilities: ["analysis"],
      config: { instruction: "Analyze" },
      process_pid: null,
      current_task_id: null,
    };
    expect(agentDetailSummaryFragment(agent)).toContain('id="agent-summary-fragment"');
  });

  it("renders team fragments with stable IDs", () => {
    const team = {
      id: "t1",
      name: "Team One",
      entrypoint_agent_id: "a1",
      entrypoint_agent_name: "Agent One",
      phases: [{ name: "Plan", prompt: "Plan" }],
    };
    const members = [{ agent_id: "a1", agent_name: "Agent One", role: "lead", level: 0, capabilities: ["planning"] }];
    expect(teamListPollingFragment([team])).toContain('id="team-list"');
    expect(teamDetailSummaryFragment(team, members)).toContain('id="team-summary-fragment"');
    expect(teamMembersFragment(team, members, [])).toContain('id="team-members-fragment"');
  });
});


describe("realtimeTaskDetailPage", () => {
  it("consolidates realtime operations into a single sidebar card", () => {
    const html = realtimeTaskDetailPage(
      {
        id: "rt1",
        title: "Realtime Review",
        description: "Monitor the discussion and surface action items.",
        status: "running",
        task_type: "real_time",
        task_config: JSON.stringify({ assigned_agent_ids: ["agent-1"], summarizer_agent_id: "summarizer-1" }),
        created_at: "2024-01-01T10:00:00Z",
        started_at: "2024-01-01T10:01:00Z",
        completed_at: null,
        team_name: "Real Time",
        segment_count: 8,
      },
      [
        {
          id: "tl1",
          task_id: "rt1",
          entry_type: "text",
          content: "First event",
          source_segment_ids: "seg-1",
          fed_to_skipper: 1,
          created_at: "2024-01-01T10:02:00Z",
        },
      ],
      {
        task_id: "rt1",
        analyst_instance_id: null,
        analyst_session_id: null,
        analyst_status: "idle",
        action_instance_id: null,
        action_status: "idle",
        last_summary_version: 0,
        last_analyst_fed_version: 0,
        queued_summary_versions: "",
        cadence_timer_active: 1,
        updated_at: "2024-01-01T10:03:00Z",
        total_segments: 8,
        pending_transcription: 1,
        failed_transcription: 0,
        pending_summarization: 2,
        timeline_entry_count: 1,
      },
      {
        transcription_provider: "local",
        transcription_endpoint: "http://localhost:8080/inference",
        openai_transcription_model: "gpt-4o-transcribe",
        summarization_model: "claude-sonnet-4-6",
        summary_max_tokens: 500,
        cadence_seconds: 30,
        overlap_seconds: 5,
      },
      true,
      [
        {
          id: "inst-1",
          template_agent_id: "agent-1",
          agent_name: "Researcher",
          status: "running",
          created_at: "2024-01-01T10:02:30Z",
        },
      ],
      [
        {
          id: "note-1",
          agent_id: "agent-1",
          agent_name: "Researcher",
          content: "Need a summary artifact.",
          created_at: "2024-01-01T10:02:45Z",
        },
      ],
      [
        { id: "agent-1", name: "Researcher", type: "codex", capabilities: "[]" },
        { id: "summarizer-1", name: "Summarizer", type: "codex", capabilities: "[]" },
      ],
      [
        { id: "agent-1", name: "Researcher", role: "lead" },
      ],
    );

    expect(html).toContain(">Operations<");
    expect(html).toContain("Assignments, activity, pipeline state, and runtime config.");
    expect(html).not.toContain(">Task Actions<");
    expect(html).not.toContain(">Team & Agents<");
    expect(html).toContain("rt-panel-section");
  });

  it("uses a denser composer and opens artifacts in-panel (no full-screen modal)", () => {
    const html = realtimeTaskDetailPage(
      {
        id: "rt2",
        title: "Realtime Review",
        description: null,
        status: "running",
        task_type: "real_time",
        task_config: "{}",
        created_at: "2024-01-01T10:00:00Z",
        started_at: "2024-01-01T10:01:00Z",
        completed_at: null,
      },
      [],
      null,
      {
        transcription_provider: "local",
        transcription_endpoint: "http://localhost:8080/inference",
        openai_transcription_model: "gpt-4o-transcribe",
        summarization_model: "claude-sonnet-4-6",
        summary_max_tokens: 500,
        cadence_seconds: 30,
        overlap_seconds: 5,
      },
      true,
      [],
      [],
      [],
      [],
    );

    expect(html).toContain('class="rt-composer-wrap"');
    expect(html).toContain('class="rt-secondary-grid"');
    // Artifacts now open inside their panel, not a full-screen modal.
    expect(html).toContain('id="sk-artifact-detail"');
    expect(html).toContain("skOpenArtifactPanel");
    expect(html).not.toContain('id="task-artifact-modal"');
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

  it("formats JSON output with structured wrapper", () => {
    const jsonLine = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Created file" },
    });
    const html = terminalOutputFragment([
      { stream: "stdout", data: jsonLine, sequence: 1 },
    ]);
    expect(html).toContain("terminal-json");
    expect(html).toContain("badge-json-type");
    expect(html).toContain("item.completed");
    expect(html).toContain("agent_message");
    expect(html).toContain("Created file");
  });

  it("escapes HTML in output", () => {
    const html = terminalOutputFragment([
      { stream: "stdout", data: "<script>alert('xss')</script>", sequence: 1 },
    ]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
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


describe("logsTableFragment", () => {
  it("extracts assistant message.content text for anthropic-style payloads", () => {
    const html = logsTableFragment([
      {
        id: 0,
        agent_id: "a1",
        agent_name: "Agent A",
        session_id: "s1",
        stream: "stdout",
        data: JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-6",
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I now have enough information to produce a comprehensive planning analysis.",
              },
            ],
          },
        }),
        sequence: 0,
        created_at: "2024-01-01T00:00:00Z",
      },
    ]);

    expect(html).toContain("I now have enough information");
    expect(html).toContain("raw json");
  });

  it("renders formatted json payloads without truncation", () => {
    const html = logsTableFragment([
      {
        id: 1,
        agent_id: "a1",
        agent_name: "Agent A",
        session_id: "s1",
        stream: "stdout",
        data: JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_1",
            type: "agent_message",
            text: "This is a longer message that should stay readable in logs output payload.",
          },
        }),
        sequence: 1,
        created_at: "2024-01-01T00:00:00Z",
      },
    ]);

    expect(html).toContain("log-json-body");
    expect(html).toContain("item.completed");
    expect(html).toContain("This is a longer message");
  });

  it("renders newline-delimited json events as separate payload blocks", () => {
    const html = logsTableFragment([
      {
        id: 2,
        agent_id: "a1",
        agent_name: "Agent A",
        session_id: "s1",
        stream: "stdout",
        data: '{"type":"turn.started"}\n{"type":"turn.completed","usage":{"output_tokens":12}}',
        sequence: 2,
        created_at: "2024-01-01T00:00:01Z",
      },
    ]);

    const eventCount = (html.match(/class="log-json-event"/g) || []).length;
    expect(eventCount).toBe(2);
    expect(html).toContain("turn.started");
    expect(html).toContain("turn.completed");
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
    expect(result).toContain("3h 0m ago");
  });

  it("includes hours and minutes for times under 10 hours", () => {
    const ts = new Date(Date.now() - (2 * 60 + 37) * 60 * 1000).toISOString();
    const result = formatTimestamp(ts);
    expect(result).toContain("2h 37m ago");
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

  it("parses sqlite UTC timestamps correctly", () => {
    const result = formatTimestamp("2026-02-20 17:04:16");
    expect(result).not.toContain("2026-02-20 17:04:16");
    expect(result).toContain("title=");
  });

  it("includes full timestamp in title attribute", () => {
    const ts = new Date(Date.now() - 60 * 1000).toISOString();
    const result = formatTimestamp(ts);
    expect(result).toContain("title=");
  });
});


