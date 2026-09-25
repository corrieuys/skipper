import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import { initializeDatabase } from "../db/connection";
import { eventBus } from "../events/bus";
import type { ManagerDaemon } from "../agents/manager-daemon";
import type { WSData } from "./types";
import { UIWebSocketManager } from "./ui-push";

// Push routing: who gets which push, and a push nobody listens to does no
// read or render. Sockets are fakes handed straight to wsHandlers.open.

const fakeDaemon = { listRuntimeSteeringOptions: () => [] } as unknown as ManagerDaemon;

let db: Database;
let manager: UIWebSocketManager;
/** Every statement prepared on `db` since the last reset. */
let sqls: string[];

interface FakeClient {
  sent: string[];
}

function connect(format: "html" | "json", topics: string[]): FakeClient {
  const sent: string[] = [];
  const ws = {
    data: { type: "ui-push", subscriptions: new Set(topics), format },
    send: (message: string) => {
      sent.push(message);
      return message.length;
    },
  } as unknown as ServerWebSocket<WSData>;
  manager.wsHandlers.open(ws);
  sent.length = 0; // drop the JSON connect snapshot
  return { sent };
}

function jsonFrames(client: FakeClient): Array<{ event: string; resource: string; data: Record<string, unknown> }> {
  return client.sent.filter((m) => m.startsWith("{")).map((m) => JSON.parse(m));
}

function sameStatusChange(): void {
  eventBus.emit("task:state_changed", { taskId: "task-1", previousStatus: "active", newStatus: "active" });
}

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  db.prepare("INSERT INTO agents (id, name, type, model, config, capabilities) VALUES ('a-tmpl','Claude','codex','default','{}','[]')").run();
  db.prepare("INSERT INTO tasks (id, title, status, started_at) VALUES ('task-1','Fix auth','active',datetime('now'))").run();
  db.prepare("INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('inst-1','task-1','a-tmpl','running')").run();
  sqls = [];
  const prepare = db.prepare.bind(db) as (...args: unknown[]) => unknown;
  db.prepare = ((...args: unknown[]) => {
    sqls.push(String(args[0]));
    return prepare(...args);
  }) as unknown as typeof db.prepare;
  manager = new UIWebSocketManager(db, fakeDaemon);
});

afterEach(() => {
  manager.destroy();
  db.close();
});

describe("agent terminal pushes", () => {
  it("sends an output chunk only to that agent's terminal page", () => {
    const commandCenter = connect("html", ["dashboard", "task:task-1"]);
    const terminal = connect("html", ["agent:inst-1"]);
    const config = connect("html", ["config"]);

    eventBus.emit("agent:output", { agentId: "inst-1", stream: "stdout", data: "hello from the agent", sequence: 1 });

    expect(terminal.sent.some((m) => m.includes('id="terminal-lines"') && m.includes("hello from the agent"))).toBe(true);
    expect(commandCenter.sent.some((m) => m.includes("terminal-lines"))).toBe(false);
    expect(config.sent).toHaveLength(0);
  });

  it("reads and renders the drained session only while a terminal page for it is open", () => {
    db.prepare("INSERT INTO agent_sessions (id, agent_id) VALUES ('sess-1', 'inst-1')").run();
    db.prepare("INSERT INTO terminal_outputs (agent_id, session_id, stream, data, sequence) VALUES ('inst-1', 'sess-1', 'stdout', 'drained line', 1)").run();
    const commandCenter = connect("html", ["dashboard", "task:task-1"]);

    sqls.length = 0;
    eventBus.emit("agent:streams_drained", { agentId: "inst-1" });
    expect(sqls.some((s) => s.includes("terminal_outputs") || s.includes("agent_sessions"))).toBe(false);
    expect(commandCenter.sent).toHaveLength(0);

    const terminal = connect("html", ["agent:inst-1"]);
    eventBus.emit("agent:streams_drained", { agentId: "inst-1" });
    expect(terminal.sent.some((m) => m.includes('id="terminal-lines" hx-swap-oob="innerHTML"') && m.includes("drained line"))).toBe(true);
    expect(commandCenter.sent).toHaveLength(0);
  });
});

describe("full task list push", () => {
  const isFullTaskListRead = (sql: string) => sql.includes("SELECT t.*, tm.name AS team_name") && !sql.includes("WHERE");

  it("does not read the task table when no JSON client takes the list", () => {
    const commandCenter = connect("html", ["dashboard", "task:task-1"]);
    const terminalDashboard = connect("json", ["dashboard"]);

    sqls.length = 0;
    sameStatusChange();

    expect(sqls.some(isFullTaskListRead)).toBe(false);
    expect(commandCenter.sent.some((m) => m.includes('id="task-list"'))).toBe(false);
    expect(jsonFrames(terminalDashboard).map((f) => f.resource)).not.toContain("tasks");
  });

  it("still sends the list, same shape, to an unscoped JSON client (the VS Code extension)", () => {
    const extension = connect("json", []);
    sameStatusChange();
    const frame = jsonFrames(extension).find((f) => f.resource === "tasks");
    expect(frame?.event).toBe("updated");
    const tasks = frame?.data.tasks as Array<{ id: string; title: string }>;
    expect(tasks.map((t) => t.id)).toEqual(["task-1"]);
    expect(tasks[0]?.title).toBe("Fix auth");
  });
});

describe("dashboard pushes", () => {
  it("pushes no HTML for ids that no page renders", () => {
    const commandCenter = connect("html", ["dashboard", "task:task-1"]);

    sameStatusChange();
    eventBus.emit("task:run_completed", { taskId: "task-1", result: null });
    eventBus.emit("instance:state_changed", { instanceId: "inst-1", templateAgentId: "a-tmpl", taskId: "task-1", parentInstanceId: null, rootInstanceId: null, status: "running" });
    eventBus.emit("agent:state_changed", { agentId: "inst-1", previousState: "idle", newState: "running" });
    eventBus.emit("escalation:created", { escalationId: "esc-1", agentId: "a-tmpl", taskId: "task-1", type: "question", question: "q?" });
    eventBus.emit("task:note_added", { noteId: "n-1", taskId: "task-1", agentId: "inst-1", content: "a note" });
    eventBus.emit("task:message_posted", { messageId: "m-1", taskId: "task-1", agentId: "a-tmpl", content: "hi" });
    eventBus.emit("artifact:created", { artifactId: "art-1", taskId: "task-1", name: "plan", version: 1, kind: "markdown" });
    eventBus.emit("delegation_group:progress", { groupId: "g-1", taskId: "task-1", parentInstanceId: "inst-1", settledCount: 0, expectedCount: 1, failedCount: 0, status: "running" });
    eventBus.emit("realtime:timeline_updated", { taskId: "task-1", entryId: "tl-1", entryType: "text" });

    const all = commandCenter.sent.join("\n");
    for (const dead of [
      'id="active-tasks"', 'id="dashboard-queue"', 'id="dashboard-metrics"', 'id="running-instances',
      'id="dashboard-progress-', 'id="dashboard-steer-slot"', 'id="dashboard-rt-timeline"',
      'id="dashboard-phase-indicator', 'id="dashboard-delegations', 'id="dashboard-escalations"',
      'id="dashboard-rerender-trigger"', 'id="recent-activity"', 'id="task-list"', 'id="task-summary-fragment"',
      'id="task-phases-fragment"', 'id="task-delegations-fragment"', 'id="rt-notes"', 'id="sk-notes"',
      'id="timeline-entries"', 'id="rt-running-agents"', 'id="artifact-list"', 'id="mc-nav-stats-live"',
      'id="mc-task-escalations-', "#mc-messages-",
    ]) {
      expect(all).not.toContain(dead);
    }
    // The live command-center targets still arrive.
    expect(all).toContain('id="mc-sidebar-list"');
    expect(all).toContain("#mc-timeline-inner-task-1");
    expect(all).toContain("#mc-notes-task-1");
    expect(all).toContain("#mc-artifacts-task-1");
    expect(all).toContain('id="mc-task-escalation-task-1"');
  });

  it("keeps the JSON lanes for the terminal dashboard and the VS Code extension", () => {
    const terminalDashboard = connect("json", ["dashboard"]);
    const extension = connect("json", []);
    sameStatusChange();
    const lanes = ["dashboard:tasks", "dashboard:metrics", "dashboard:instances", "dashboard:phase-indicator", "dashboard:realtime-timeline", "task"];
    for (const lane of lanes) {
      expect(jsonFrames(terminalDashboard).map((f) => f.resource)).toContain(lane);
      expect(jsonFrames(extension).map((f) => f.resource)).toContain(lane);
    }
  });

  it("does no read or render for a push nobody listens to", () => {
    connect("json", ["glyph:task-1"]); // a Canvas overlay: topic-scoped, takes none of these

    sqls.length = 0;
    eventBus.emit("realtime:timeline_updated", { taskId: "task-1", entryId: "tl-1", entryType: "text" });
    eventBus.emit("task:note_added", { noteId: "n-1", taskId: "task-1", agentId: "inst-1", content: "a note" });
    eventBus.emit("artifact:created", { artifactId: "art-1", taskId: "task-1", name: "plan", version: 1, kind: "markdown" });
    eventBus.emit("escalation:created", { escalationId: "esc-1", agentId: "a-tmpl", taskId: "task-1", type: "question", question: "q?" });

    expect(sqls).toEqual([]);
  });
});

describe("pages with their own topics", () => {
  it("get no task pushes but still get the global notices", () => {
    const config = connect("html", ["config"]);

    sameStatusChange();
    eventBus.emit("agent:output", { agentId: "inst-1", stream: "stdout", data: "noise", sequence: 1 });
    expect(config.sent).toHaveLength(0);

    manager.broadcastNotification("/sounds/done.mp3");
    manager.broadcastOmarchyTheme("v2");
    expect(config.sent.some((m) => m.includes('"kind":"audio"'))).toBe(true);
    expect(config.sent.some((m) => m.includes('"kind":"omarchy"'))).toBe(true);
  });
});

describe("timeline push on a long task", () => {
  it("carries the newest operator input", () => {
    const ins = db.prepare(
      "INSERT INTO realtime_timeline (id, task_id, entry_type, content, fed_to_skipper, created_at) VALUES (?, 'task-1', 'text', ?, 1, ?)",
    );
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 310; i++) {
      ins.run(`tl-${i}`, `input-number-${i}-end`, new Date(base + i * 60_000).toISOString().replace("T", " ").slice(0, 19));
    }
    const commandCenter = connect("html", ["dashboard", "task:task-1"]);

    eventBus.emit("realtime:timeline_updated", { taskId: "task-1", entryId: "tl-309", entryType: "text" });

    const push = commandCenter.sent.find((m) => m.includes("#mc-timeline-inner-task-1"));
    expect(push).toContain("input-number-309-end");
    expect(push).not.toContain("input-number-0-end");
  });
});
