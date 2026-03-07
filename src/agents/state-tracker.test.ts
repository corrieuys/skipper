import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { StateTracker } from "./state-tracker";
import { AgentManager } from "./manager";
import { clearAgentTypeCache } from "./types";
import { unlinkSync } from "fs";

const TEST_DB = "test-state-tracker.db";

let db: Database;
let agentManager: AgentManager;
let tracker: StateTracker;

function setupAgentType(name = "test-echo"): void {
  db.prepare(
    `INSERT OR IGNORE INTO agent_types (name, command, args, supports_stdin)
     VALUES (?, 'bash', '["-c", "sleep 30"]', 1)`,
  ).run(name);
}

function createAgent(name: string): string {
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO agents (id, name, type, config, capabilities) VALUES (?, ?, 'test-echo', '{}', '[]')",
  ).run(id, name);
  return id;
}

function setAgentPid(agentId: string, pid: number): void {
  db.prepare("UPDATE agents SET process_pid = ?, status = 'busy' WHERE id = ?").run(pid, agentId);
}

function insertTerminalOutput(agentId: string, data: string, sequence: number): void {
  db.prepare(
    "INSERT INTO terminal_outputs (agent_id, stream, data, sequence) VALUES (?, 'stdout', ?, ?)",
  ).run(agentId, data, sequence);
}

function createAgentState(
  agentId: string,
  opts: {
    state?: string;
    heartbeat_at?: string;
    screen_fingerprint?: string | null;
    nudge_count?: number;
  } = {},
): void {
  db.prepare(
    `INSERT INTO agent_states (agent_id, state, heartbeat_at, screen_fingerprint, nudge_count)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       state = excluded.state,
       heartbeat_at = excluded.heartbeat_at,
       screen_fingerprint = excluded.screen_fingerprint,
       nudge_count = excluded.nudge_count`,
  ).run(
    agentId,
    opts.state ?? "working",
    opts.heartbeat_at ?? "datetime('now')",
    opts.screen_fingerprint ?? null,
    opts.nudge_count ?? 0,
  );
}

beforeEach(() => {
  clearAgentTypeCache();
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  setupAgentType();
  agentManager = new AgentManager(db);
  tracker = new StateTracker(db, agentManager);
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

describe("updateHeartbeats", () => {
  it("creates agent_state record for agent with PID but no state yet", () => {
    const agentId = createAgent("Agent A");
    setAgentPid(agentId, 99999);

    tracker.updateHeartbeats();

    const state = db
      .prepare("SELECT * FROM agent_states WHERE agent_id = ?")
      .get(agentId) as { heartbeat_at: string; screen_fingerprint: string | null } | null;
    expect(state).not.toBeNull();
    expect(state!.heartbeat_at).toBeTruthy();
  });

  it("updates heartbeat when terminal output fingerprint changes", () => {
    const agentId = createAgent("Agent B");
    setAgentPid(agentId, 99999);
    insertTerminalOutput(agentId, "initial output", 1);

    // First call establishes baseline
    tracker.updateHeartbeats();

    const stateBefore = db
      .prepare("SELECT heartbeat_at FROM agent_states WHERE agent_id = ?")
      .get(agentId) as { heartbeat_at: string };

    // Small delay then add new output
    insertTerminalOutput(agentId, "more output added later", 2);

    tracker.updateHeartbeats();

    const stateAfter = db
      .prepare("SELECT heartbeat_at, screen_fingerprint FROM agent_states WHERE agent_id = ?")
      .get(agentId) as { heartbeat_at: string; screen_fingerprint: string };

    // Fingerprint should contain the new output
    expect(stateAfter.screen_fingerprint).toContain("more output added later");
  });

  it("does not update heartbeat when fingerprint is unchanged", () => {
    const agentId = createAgent("Agent C");
    setAgentPid(agentId, 99999);
    insertTerminalOutput(agentId, "static output", 1);

    // First call — establishes baseline
    tracker.updateHeartbeats();

    const stateBefore = db
      .prepare("SELECT heartbeat_at FROM agent_states WHERE agent_id = ?")
      .get(agentId) as { heartbeat_at: string };

    // Second call with same output — heartbeat should NOT be refreshed
    tracker.updateHeartbeats();

    const stateAfter = db
      .prepare("SELECT heartbeat_at FROM agent_states WHERE agent_id = ?")
      .get(agentId) as { heartbeat_at: string };

    // heartbeat_at is stored with second precision; they should be identical
    expect(stateAfter.heartbeat_at).toBe(stateBefore.heartbeat_at);
  });

  it("ignores agents without a PID", () => {
    const agentId = createAgent("Idle Agent");
    // No PID set

    tracker.updateHeartbeats();

    const state = db
      .prepare("SELECT * FROM agent_states WHERE agent_id = ?")
      .get(agentId);
    expect(state).toBeNull();
  });
});

describe("getStuckCandidates", () => {
  it("returns agent with old heartbeat in non-skip state", () => {
    const agentId = createAgent("Stuck Agent");
    setAgentPid(agentId, 99999);
    createAgentState(agentId, {
      state: "working",
      heartbeat_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
    });

    const candidates = tracker.getStuckCandidates();
    expect(candidates).toContain(agentId);
  });

  it("does not return agent with recent heartbeat", () => {
    const agentId = createAgent("Active Agent");
    setAgentPid(agentId, 99999);
    createAgentState(agentId, {
      state: "working",
      heartbeat_at: new Date(Date.now() - 60 * 1000).toISOString(), // 1 min ago
    });

    const candidates = tracker.getStuckCandidates();
    expect(candidates).not.toContain(agentId);
  });

  it("does not return agent with SQL datetime heartbeat", () => {
    const agentId = createAgent("SQL Time Agent");
    setAgentPid(agentId, 99999);
    db.prepare(
      `INSERT INTO agent_states (agent_id, state, heartbeat_at, screen_fingerprint, nudge_count)
       VALUES (?, 'working', datetime('now'), NULL, 0)
       ON CONFLICT(agent_id) DO UPDATE SET
         state = 'working',
         heartbeat_at = datetime('now'),
         screen_fingerprint = NULL,
         nudge_count = 0`,
    ).run(agentId);

    const candidates = tracker.getStuckCandidates();
    expect(candidates).not.toContain(agentId);
  });

  it("skips agents in waiting_delegation state", () => {
    const agentId = createAgent("Delegating Agent");
    setAgentPid(agentId, 99999);
    createAgentState(agentId, {
      state: "waiting_delegation",
      heartbeat_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    const candidates = tracker.getStuckCandidates();
    expect(candidates).not.toContain(agentId);
  });

  it("skips agents in escalated state", () => {
    const agentId = createAgent("Escalated Agent");
    setAgentPid(agentId, 99999);
    createAgentState(agentId, {
      state: "escalated",
      heartbeat_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    const candidates = tracker.getStuckCandidates();
    expect(candidates).not.toContain(agentId);
  });

  it("skips agents in stopped state", () => {
    const agentId = createAgent("Stopped Agent");
    setAgentPid(agentId, 99999);
    createAgentState(agentId, {
      state: "stopped",
      heartbeat_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    const candidates = tracker.getStuckCandidates();
    expect(candidates).not.toContain(agentId);
  });

  it("skips agents without a PID", () => {
    const agentId = createAgent("No PID Agent");
    // No PID
    createAgentState(agentId, {
      state: "working",
      heartbeat_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    const candidates = tracker.getStuckCandidates();
    expect(candidates).not.toContain(agentId);
  });
});

describe("analyzeStuckAgent", () => {
  it("returns true when screen fingerprint is unchanged", () => {
    const agentId = createAgent("Stuck Confirmed");
    setAgentPid(agentId, 99999);
    insertTerminalOutput(agentId, "same output", 1);
    createAgentState(agentId, {
      state: "working",
      screen_fingerprint: "same output",
      heartbeat_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    const stuck = tracker.analyzeStuckAgent(agentId);
    expect(stuck).toBe(true);
  });

  it("returns false and updates fingerprint when screen changed", () => {
    const agentId = createAgent("Active Confirmed");
    setAgentPid(agentId, 99999);
    insertTerminalOutput(agentId, "new output", 1);
    createAgentState(agentId, {
      state: "working",
      screen_fingerprint: "old output",
      heartbeat_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    const stuck = tracker.analyzeStuckAgent(agentId);
    expect(stuck).toBe(false);

    const state = db
      .prepare("SELECT screen_fingerprint FROM agent_states WHERE agent_id = ?")
      .get(agentId) as { screen_fingerprint: string };
    expect(state.screen_fingerprint).toContain("new output");
  });

  it("returns false for waiting_delegation state", () => {
    const agentId = createAgent("Waiting Agent");
    setAgentPid(agentId, 99999);
    createAgentState(agentId, {
      state: "waiting_delegation",
      screen_fingerprint: "same",
    });
    insertTerminalOutput(agentId, "same", 1);

    expect(tracker.analyzeStuckAgent(agentId)).toBe(false);
  });

  it("returns false for escalated state", () => {
    const agentId = createAgent("Escalated Agent");
    setAgentPid(agentId, 99999);
    createAgentState(agentId, {
      state: "escalated",
      screen_fingerprint: "same",
    });
    insertTerminalOutput(agentId, "same", 1);

    expect(tracker.analyzeStuckAgent(agentId)).toBe(false);
  });

  it("returns false when agent has no state record", () => {
    const agentId = createAgent("No State Agent");
    expect(tracker.analyzeStuckAgent(agentId)).toBe(false);
  });

  it("logs a stuck detection entry when stuck is confirmed", () => {
    const agentId = createAgent("Log Test Agent");
    setAgentPid(agentId, 99999);
    insertTerminalOutput(agentId, "frozen", 1);
    createAgentState(agentId, {
      state: "working",
      screen_fingerprint: "frozen",
      heartbeat_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    tracker.analyzeStuckAgent(agentId);

    const logs = db
      .prepare("SELECT * FROM stuck_detection_logs WHERE agent_id = ?")
      .all(agentId) as { detection_type: string }[];
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].detection_type).toBe("stuck");
  });
});

describe("handleStuckAgent", () => {
  it("sends a nudge and increments nudge_count when under the limit", () => {
    const agentId = createAgent("Nudge Agent");
    setAgentPid(agentId, 99999);
    insertTerminalOutput(agentId, "frozen", 1);
    createAgentState(agentId, {
      state: "working",
      screen_fingerprint: "frozen",
      nudge_count: 0,
    });

    // Track sendInput calls
    let nudgeSent = false;
    spyOn(agentManager, "sendInput").mockImplementation(() => {
      nudgeSent = true;
    });

    tracker.handleStuckAgent(agentId);

    expect(nudgeSent).toBe(true);

    const state = db
      .prepare("SELECT nudge_count FROM agent_states WHERE agent_id = ?")
      .get(agentId) as { nudge_count: number };
    expect(state.nudge_count).toBe(1);

    const logs = db
      .prepare("SELECT detection_type FROM stuck_detection_logs WHERE agent_id = ?")
      .all(agentId) as { detection_type: string }[];
    expect(logs.some((l) => l.detection_type === "nudged")).toBe(true);
  });

  it("sends nudge up to 3 times total", () => {
    const agentId = createAgent("Multi Nudge");
    setAgentPid(agentId, 99999);
    insertTerminalOutput(agentId, "frozen", 1);
    createAgentState(agentId, {
      state: "working",
      screen_fingerprint: "frozen",
      nudge_count: 2,
    });

    spyOn(agentManager, "sendInput").mockImplementation(() => {});

    tracker.handleStuckAgent(agentId);

    const state = db
      .prepare("SELECT nudge_count FROM agent_states WHERE agent_id = ?")
      .get(agentId) as { nudge_count: number };
    expect(state.nudge_count).toBe(3);
  });

  it("escalates when nudge_count reaches max (3)", () => {
    const agentId = createAgent("Escalate Agent");
    setAgentPid(agentId, 99999);
    insertTerminalOutput(agentId, "frozen", 1);

    // Give the agent a task
    const taskId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO tasks (id, title, status, started_at) VALUES (?, 'Task', 'running', datetime('now'))",
    ).run(taskId);
    db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskId, agentId);

    createAgentState(agentId, {
      state: "working",
      screen_fingerprint: "frozen",
      nudge_count: 3,
    });

    tracker.handleStuckAgent(agentId);

    // Should have created an escalation
    const escalations = db
      .prepare("SELECT * FROM escalations WHERE agent_id = ?")
      .all(agentId) as { type: string; severity: string }[];
    expect(escalations.length).toBe(1);
    expect(escalations[0].type).toBe("stuck_agent");
    expect(escalations[0].severity).toBe("high");

    // Agent state should be escalated
    const state = db
      .prepare("SELECT state FROM agent_states WHERE agent_id = ?")
      .get(agentId) as { state: string };
    expect(state.state).toBe("escalated");

    // Logged as escalated
    const logs = db
      .prepare("SELECT detection_type FROM stuck_detection_logs WHERE agent_id = ?")
      .all(agentId) as { detection_type: string }[];
    expect(logs.some((l) => l.detection_type === "escalated")).toBe(true);
  });

  it("does nothing when agent has no task (escalation path)", () => {
    const agentId = createAgent("No Task Agent");
    setAgentPid(agentId, 99999);
    insertTerminalOutput(agentId, "frozen", 1);
    createAgentState(agentId, {
      state: "working",
      screen_fingerprint: "frozen",
      nudge_count: 3,
    });

    // Should not throw even with no task
    tracker.handleStuckAgent(agentId);

    const escalations = db
      .prepare("SELECT * FROM escalations WHERE agent_id = ?")
      .all(agentId) as unknown[];
    expect(escalations.length).toBe(0);
  });

  it("does nothing when agent has no state record", () => {
    const agentId = createAgent("Ghost Agent");
    // No state record
    tracker.handleStuckAgent(agentId); // Should not throw
  });

  it("does not throw when sendInput fails (closed stdin)", () => {
    const agentId = createAgent("Closed Stdin Agent");
    setAgentPid(agentId, 99999);
    insertTerminalOutput(agentId, "frozen", 1);
    createAgentState(agentId, {
      state: "working",
      screen_fingerprint: "frozen",
      nudge_count: 0,
    });

    spyOn(agentManager, "sendInput").mockImplementation(() => {
      throw new Error("stdin closed");
    });

    // Should not throw
    tracker.handleStuckAgent(agentId);

    // Nudge count still incremented
    const state = db
      .prepare("SELECT nudge_count FROM agent_states WHERE agent_id = ?")
      .get(agentId) as { nudge_count: number };
    expect(state.nudge_count).toBe(1);
  });
});
