import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { StateTracker } from "./state-tracker";
import { AgentManager } from "./manager";
import { ManagerDaemon } from "./manager-daemon";
import { HealthMonitor } from "../orchestrator/health-monitor";
import { eventBus, type EscalationCreatedEvent } from "../events/bus";
import { clearAgentTypeCache } from "./types";
import { unlinkSync } from "fs";

const TEST_DB = "test-state-tracker.db";

let db: Database;
let agentManager: AgentManager;
let tracker: StateTracker;
// Pids the fake pgrep reports as having child processes.
let busyPids: Set<number>;

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

function createTask(): string {
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO tasks (id, title, status, started_at) VALUES (?, 'Task', 'active', datetime('now'))",
  ).run(id);
  return id;
}

function insertTerminalOutput(agentId: string, data: string, sequence: number): void {
  db.prepare(
    "INSERT INTO terminal_outputs (agent_id, stream, data, sequence) VALUES (?, 'stdout', ?, ?)",
  ).run(agentId, data, sequence);
}

function insertAgentInstance(
  instanceId: string,
  taskId: string,
  templateAgentId: string,
  status = "running",
  processPid: number | null = 12345,
): void {
  // The single-DB test schema points agent_states.agent_id and
  // stuck_detection_logs.agent_id at agents(id), so a runtime id needs an
  // agents row of its own before rows can be keyed by it.
  db.prepare(
    "INSERT OR IGNORE INTO agents (id, name, type, config, capabilities) VALUES (?, ?, 'test-echo', '{}', '[]')",
  ).run(instanceId, `Runtime ${instanceId}`);
  db.prepare(
    `INSERT INTO agent_instances (id, task_id, template_agent_id, status, process_pid, attempt)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).run(instanceId, taskId, templateAgentId, status, processPid);
}

/** A runtime instance of `templateAgentId`, live (running with a pid) unless told otherwise. */
function startRuntime(
  templateAgentId: string,
  opts: { taskId?: string; status?: string; pid?: number | null } = {},
): string {
  const runtimeId = crypto.randomUUID();
  insertAgentInstance(
    runtimeId,
    opts.taskId ?? createTask(),
    templateAgentId,
    opts.status ?? "running",
    opts.pid === undefined ? 12345 : opts.pid,
  );
  return runtimeId;
}

function taskOf(runtimeId: string): string {
  return (db.prepare("SELECT task_id FROM agent_instances WHERE id = ?").get(runtimeId) as { task_id: string }).task_id;
}

function insertDelegation(
  parentTemplateId: string,
  childTemplateId: string,
  parentInstanceId: string,
  childInstanceId: string,
  taskId: string,
  status = "running",
): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO delegations (id, parent_agent_id, child_agent_id, parent_instance_id, child_instance_id, task_id, prompt, status)
     VALUES (?, ?, ?, ?, ?, ?, 'work', ?)`,
  ).run(id, parentTemplateId, childTemplateId, parentInstanceId, childInstanceId, taskId, status);
  return id;
}

function insertEscalation(templateAgentId: string, runtimeId: string, taskId: string, type = "agent_request"): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO escalations (id, agent_id, runtime_agent_id, task_id, type, question)
     VALUES (?, ?, ?, ?, ?, 'Which database?')`,
  ).run(id, templateAgentId, runtimeId, taskId, type);
  return id;
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

function getState(agentId: string): { state: string; heartbeat_at: string; screen_fingerprint: string | null; nudge_count: number; last_signal_at: string | null } | null {
  return db.prepare("SELECT * FROM agent_states WHERE agent_id = ?").get(agentId) as {
    state: string;
    heartbeat_at: string;
    screen_fingerprint: string | null;
    nudge_count: number;
    last_signal_at: string | null;
  } | null;
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

/** Record every runtime id a nudge is written to. */
function captureNudges(): string[] {
  const targets: string[] = [];
  spyOn(agentManager, "sendInput").mockImplementation((targetId: string) => {
    targets.push(targetId);
  });
  return targets;
}

/** One stuck-detection pass exactly as the tick loop runs it. */
function runStuckDetection(): void {
  new HealthMonitor(db, agentManager, {} as never, tracker, () => null).runStuckDetection();
}

beforeEach(() => {
  clearAgentTypeCache();
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  setupAgentType();
  agentManager = new AgentManager(db);
  tracker = new StateTracker(db, agentManager);
  // No real pgrep against the fake pids these tests use.
  busyPids = new Set();
  spyOn(tracker as unknown as { pidHasChildren: (pid: number) => boolean }, "pidHasChildren")
    .mockImplementation((pid: number) => busyPids.has(pid));
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TEST_DB);
    try { unlinkSync(`${TEST_DB}-wal`); } catch {}
    try { unlinkSync(`${TEST_DB}-shm`); } catch {}
  } catch { }
});

describe("updateHeartbeats", () => {
  it("creates an agent_state row keyed by the live runtime, not its template", () => {
    const templateId = createAgent("Agent A");
    const runtimeId = startRuntime(templateId);

    tracker.updateHeartbeats();

    const state = getState(runtimeId);
    expect(state).not.toBeNull();
    expect(state!.heartbeat_at).toBeTruthy();
    expect(getState(templateId)).toBeNull();
  });

  it("updates heartbeat when the runtime's terminal output fingerprint changes", () => {
    const runtimeId = startRuntime(createAgent("Agent B"));
    insertTerminalOutput(runtimeId, "initial output", 1);

    // First call establishes baseline
    tracker.updateHeartbeats();

    insertTerminalOutput(runtimeId, "more output added later", 2);

    tracker.updateHeartbeats();

    // Fingerprint should contain the new output
    expect(getState(runtimeId)!.screen_fingerprint).toContain("more output added later");
  });

  it("fingerprints each runtime from its own output only", () => {
    // Two tasks run the same template. New output from B must not refresh A.
    const templateId = createAgent("Shared Template");
    const runtimeA = startRuntime(templateId);
    const runtimeB = startRuntime(templateId);
    insertTerminalOutput(runtimeA, "A frozen", 1);
    insertTerminalOutput(runtimeB, "B output 1", 1);
    const stale = minutesAgo(40);
    createAgentState(runtimeA, { screen_fingerprint: "A frozen", heartbeat_at: stale });
    createAgentState(runtimeB, { screen_fingerprint: "B output 1", heartbeat_at: stale });

    insertTerminalOutput(runtimeB, "B output 2", 2);
    tracker.updateHeartbeats();

    expect(getState(runtimeA)).toMatchObject({ screen_fingerprint: "A frozen", heartbeat_at: stale });
    expect(getState(runtimeB)!.screen_fingerprint).toBe("B output 1B output 2");
    expect(tracker.getStuckCandidates()).toEqual([runtimeA]);
  });

  it("does not update heartbeat when fingerprint is unchanged", () => {
    const runtimeId = startRuntime(createAgent("Agent C"));
    insertTerminalOutput(runtimeId, "static output", 1);

    // First call establishes the baseline
    tracker.updateHeartbeats();
    const before = getState(runtimeId)!.heartbeat_at;

    // Second call with the same output: heartbeat should NOT be refreshed
    tracker.updateHeartbeats();

    // heartbeat_at is stored with second precision; they should be identical
    expect(getState(runtimeId)!.heartbeat_at).toBe(before);
  });

  it("ignores runtimes without a PID or no longer live", () => {
    const templateId = createAgent("Idle Agent");
    const noPid = startRuntime(templateId, { pid: null });
    const stopped = startRuntime(templateId, { status: "stopped" });

    tracker.updateHeartbeats();

    expect(getState(noPid)).toBeNull();
    expect(getState(stopped)).toBeNull();
  });

  it("leaves template-keyed rows untouched", () => {
    // A row from before per-runtime tracking: the template has a pid on the
    // shared agents row and a stale heartbeat of its own.
    const templateId = createAgent("Legacy Template");
    setAgentPid(templateId, 99999);
    insertTerminalOutput(templateId, "legacy output", 1);
    const stale = minutesAgo(40);
    createAgentState(templateId, { screen_fingerprint: "old", heartbeat_at: stale, nudge_count: 2 });

    tracker.updateHeartbeats();

    expect(getState(templateId)).toMatchObject({ screen_fingerprint: "old", heartbeat_at: stale, nudge_count: 2 });
  });
});

describe("getStuckCandidates", () => {
  it("returns a live runtime with an old heartbeat in a non-skip state", () => {
    const runtimeId = startRuntime(createAgent("Stuck Agent"));
    createAgentState(runtimeId, {
      state: "working",
      heartbeat_at: minutesAgo(40),
    });

    expect(tracker.getStuckCandidates()).toContain(runtimeId);
  });

  it("does not return a runtime with a recent heartbeat", () => {
    const runtimeId = startRuntime(createAgent("Active Agent"));
    createAgentState(runtimeId, {
      state: "working",
      heartbeat_at: minutesAgo(1),
    });

    expect(tracker.getStuckCandidates()).not.toContain(runtimeId);
  });

  it("does not return a runtime with SQL datetime heartbeat", () => {
    const runtimeId = startRuntime(createAgent("SQL Time Agent"));
    db.prepare(
      `INSERT INTO agent_states (agent_id, state, heartbeat_at, screen_fingerprint, nudge_count)
       VALUES (?, 'working', datetime('now'), NULL, 0)
       ON CONFLICT(agent_id) DO UPDATE SET
         state = 'working',
         heartbeat_at = datetime('now'),
         screen_fingerprint = NULL,
         nudge_count = 0`,
    ).run(runtimeId);

    expect(tracker.getStuckCandidates()).not.toContain(runtimeId);
  });

  it("skips runtimes in waiting_delegation state", () => {
    const runtimeId = startRuntime(createAgent("Delegating Agent"));
    createAgentState(runtimeId, {
      state: "waiting_delegation",
      heartbeat_at: minutesAgo(40),
    });

    expect(tracker.getStuckCandidates()).not.toContain(runtimeId);
  });

  it("skips runtimes in escalated state", () => {
    const runtimeId = startRuntime(createAgent("Escalated Agent"));
    createAgentState(runtimeId, {
      state: "escalated",
      heartbeat_at: minutesAgo(40),
    });

    expect(tracker.getStuckCandidates()).not.toContain(runtimeId);
  });

  it("skips runtimes in stopped state", () => {
    const runtimeId = startRuntime(createAgent("Stopped Agent"));
    createAgentState(runtimeId, {
      state: "stopped",
      heartbeat_at: minutesAgo(40),
    });

    expect(tracker.getStuckCandidates()).not.toContain(runtimeId);
  });

  it("skips runtimes without a PID", () => {
    const runtimeId = startRuntime(createAgent("No PID Agent"), { pid: null });
    createAgentState(runtimeId, {
      state: "working",
      heartbeat_at: minutesAgo(40),
    });

    expect(tracker.getStuckCandidates()).not.toContain(runtimeId);
  });

  it("skips runtimes that are no longer live", () => {
    const runtimeId = startRuntime(createAgent("Stopped Runtime"), { status: "stopped" });
    createAgentState(runtimeId, {
      state: "working",
      heartbeat_at: minutesAgo(40),
    });

    expect(tracker.getStuckCandidates()).not.toContain(runtimeId);
  });

  it("never returns a template-keyed row, even with a pid on the shared agents row", () => {
    const templateId = createAgent("Legacy Stuck");
    setAgentPid(templateId, 99999);
    startRuntime(templateId);
    createAgentState(templateId, { state: "working", heartbeat_at: minutesAgo(40) });

    expect(tracker.getStuckCandidates()).not.toContain(templateId);
  });

  it("skips a runtime actively waiting on its own delegation even if agent_state drifted to working", () => {
    const templateId = createAgent("Skipper");
    const childAgentId = createAgent("Librarian");
    const taskId = createTask();
    const parentRuntime = startRuntime(templateId, { taskId, status: "waiting_delegation" });
    const childRuntime = startRuntime(childAgentId, { taskId, pid: 54321 });
    insertDelegation(templateId, childAgentId, parentRuntime, childRuntime, taskId);
    createAgentState(parentRuntime, {
      state: "working",
      heartbeat_at: minutesAgo(40),
    });

    expect(tracker.getStuckCandidates()).not.toContain(parentRuntime);

    expect(getState(parentRuntime)).toMatchObject({ state: "waiting_delegation", nudge_count: 0 });
  });

  it("does not let another task's delegation wait shield a runtime of the same template", () => {
    const templateId = createAgent("Skipper");
    const childAgentId = createAgent("Librarian");
    // Task B's root is waiting on a running delegation of its own.
    const taskB = createTask();
    const rootB = startRuntime(templateId, { taskId: taskB, status: "waiting_delegation" });
    const childB = startRuntime(childAgentId, { taskId: taskB, pid: 54321 });
    insertDelegation(templateId, childAgentId, rootB, childB, taskB);
    // Task A's root is alone on its task.
    const rootA = startRuntime(templateId);
    for (const runtimeId of [rootA, rootB]) {
      createAgentState(runtimeId, { state: "working", heartbeat_at: minutesAgo(40) });
    }

    const candidates = tracker.getStuckCandidates();
    expect(candidates).toContain(rootA);
    expect(candidates).not.toContain(rootB);
  });

  it("skips a runtime with an open escalation of its own, but not the template's other runtimes", () => {
    const templateId = createAgent("Coder");
    const asking = startRuntime(templateId);
    const other = startRuntime(templateId);
    for (const runtimeId of [asking, other]) {
      createAgentState(runtimeId, { state: "working", heartbeat_at: minutesAgo(40) });
    }
    insertEscalation(templateId, asking, taskOf(asking));

    const candidates = tracker.getStuckCandidates();
    expect(candidates).not.toContain(asking);
    expect(candidates).toContain(other);
  });
});

describe("analyzeStuckAgent", () => {
  it("returns true when the runtime's screen fingerprint is unchanged", () => {
    const runtimeId = startRuntime(createAgent("Stuck Confirmed"));
    insertTerminalOutput(runtimeId, "same output", 1);
    createAgentState(runtimeId, {
      state: "working",
      screen_fingerprint: "same output",
      heartbeat_at: minutesAgo(10),
    });

    expect(tracker.analyzeStuckAgent(runtimeId)).toBe(true);
  });

  it("returns false and updates fingerprint when screen changed", () => {
    const runtimeId = startRuntime(createAgent("Active Confirmed"));
    insertTerminalOutput(runtimeId, "new output", 1);
    createAgentState(runtimeId, {
      state: "working",
      screen_fingerprint: "old output",
      heartbeat_at: minutesAgo(10),
    });

    expect(tracker.analyzeStuckAgent(runtimeId)).toBe(false);
    expect(getState(runtimeId)!.screen_fingerprint).toContain("new output");
  });

  it("judges a runtime by its own output, not a sibling's", () => {
    const templateId = createAgent("Shared Template");
    const runtimeA = startRuntime(templateId);
    const runtimeB = startRuntime(templateId);
    insertTerminalOutput(runtimeA, "frozen", 1);
    insertTerminalOutput(runtimeB, "busy sibling output", 1);
    createAgentState(runtimeA, {
      state: "working",
      screen_fingerprint: "frozen",
      heartbeat_at: minutesAgo(10),
    });

    expect(tracker.analyzeStuckAgent(runtimeA)).toBe(true);
  });

  it("returns false for waiting_delegation state", () => {
    const runtimeId = startRuntime(createAgent("Waiting Agent"));
    createAgentState(runtimeId, {
      state: "waiting_delegation",
      screen_fingerprint: "same",
    });
    insertTerminalOutput(runtimeId, "same", 1);

    expect(tracker.analyzeStuckAgent(runtimeId)).toBe(false);
  });

  it("returns false for escalated state", () => {
    const runtimeId = startRuntime(createAgent("Escalated Agent"));
    createAgentState(runtimeId, {
      state: "escalated",
      screen_fingerprint: "same",
    });
    insertTerminalOutput(runtimeId, "same", 1);

    expect(tracker.analyzeStuckAgent(runtimeId)).toBe(false);
  });

  it("returns false while the runtime has an open escalation of its own", () => {
    const templateId = createAgent("Asking Agent");
    const runtimeId = startRuntime(templateId);
    insertTerminalOutput(runtimeId, "same", 1);
    createAgentState(runtimeId, { state: "working", screen_fingerprint: "same" });
    insertEscalation(templateId, runtimeId, taskOf(runtimeId));

    expect(tracker.analyzeStuckAgent(runtimeId)).toBe(false);
  });

  it("returns false when the runtime has no state record", () => {
    const runtimeId = startRuntime(createAgent("No State Agent"));
    expect(tracker.analyzeStuckAgent(runtimeId)).toBe(false);
  });

  it("logs a stuck detection entry keyed by the runtime when stuck is confirmed", () => {
    const runtimeId = startRuntime(createAgent("Log Test Agent"));
    insertTerminalOutput(runtimeId, "frozen", 1);
    createAgentState(runtimeId, {
      state: "working",
      screen_fingerprint: "frozen",
      heartbeat_at: minutesAgo(10),
    });

    tracker.analyzeStuckAgent(runtimeId);

    const logs = db
      .prepare("SELECT * FROM stuck_detection_logs WHERE agent_id = ?")
      .all(runtimeId) as { detection_type: string }[];
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].detection_type).toBe("stuck");
  });

  it("checks the runtime's own pid for child processes, not the template's shared pid", () => {
    const templateId = createAgent("Busy Shell");
    // The shared agents row holds another task's runtime pid.
    setAgentPid(templateId, 22222);
    const runtimeId = startRuntime(templateId, { pid: 11111 });
    insertTerminalOutput(runtimeId, "frozen", 1);
    createAgentState(runtimeId, {
      state: "working",
      screen_fingerprint: "frozen",
      heartbeat_at: minutesAgo(10),
    });
    busyPids.add(11111);

    expect(tracker.analyzeStuckAgent(runtimeId)).toBe(false);

    const logs = db
      .prepare("SELECT detection_type FROM stuck_detection_logs WHERE agent_id = ?")
      .all(runtimeId) as { detection_type: string }[];
    expect(logs.map((l) => l.detection_type)).toEqual(["skipped_active_children"]);
  });
});

describe("handleStuckAgent", () => {
  it("sends a nudge to the runtime and increments its nudge_count", () => {
    const runtimeId = startRuntime(createAgent("Nudge Agent"));
    insertTerminalOutput(runtimeId, "frozen", 1);
    createAgentState(runtimeId, {
      state: "working",
      screen_fingerprint: "frozen",
      nudge_count: 0,
    });
    const targets = captureNudges();

    tracker.handleStuckAgent(runtimeId);

    expect(targets).toEqual([runtimeId]);
    expect(getState(runtimeId)!.nudge_count).toBe(1);

    const logs = db
      .prepare("SELECT detection_type FROM stuck_detection_logs WHERE agent_id = ?")
      .all(runtimeId) as { detection_type: string }[];
    expect(logs.some((l) => l.detection_type === "nudged")).toBe(true);
  });

  it("nudges only the stuck runtime, not the template's instances in other tasks", () => {
    const templateId = createAgent("Shared Root");
    const stuck = startRuntime(templateId);
    startRuntime(templateId);
    insertTerminalOutput(stuck, "frozen", 1);
    createAgentState(stuck, {
      state: "working",
      screen_fingerprint: "frozen",
      nudge_count: 0,
    });
    const targets = captureNudges();

    tracker.handleStuckAgent(stuck);

    expect(targets).toEqual([stuck]);
  });

  it("sends nudge up to 3 times total", () => {
    const runtimeId = startRuntime(createAgent("Multi Nudge"));
    insertTerminalOutput(runtimeId, "frozen", 1);
    createAgentState(runtimeId, {
      state: "working",
      screen_fingerprint: "frozen",
      nudge_count: 2,
    });
    captureNudges();

    tracker.handleStuckAgent(runtimeId);

    expect(getState(runtimeId)!.nudge_count).toBe(3);
  });

  it("escalates when nudge_count reaches max (3)", () => {
    const templateId = createAgent("Escalate Agent");
    const taskId = createTask();
    const runtimeId = startRuntime(templateId, { taskId });
    insertTerminalOutput(runtimeId, "frozen", 1);
    createAgentState(runtimeId, {
      state: "working",
      screen_fingerprint: "frozen",
      nudge_count: 3,
    });
    spyOn(agentManager, "killAgent").mockImplementation(() => true);
    const created: EscalationCreatedEvent[] = [];
    const onCreated = (event: EscalationCreatedEvent): void => { created.push(event); };
    eventBus.on("escalation:created", onCreated);

    try {
      tracker.handleStuckAgent(runtimeId);
    } finally {
      eventBus.off("escalation:created", onCreated);
    }

    // Filed on the runtime's task, template as agent_id, the runtime as runtime_agent_id
    const escalations = db
      .prepare("SELECT agent_id, runtime_agent_id, task_id, type, severity FROM escalations")
      .all() as { agent_id: string; runtime_agent_id: string; task_id: string; type: string; severity: string }[];
    expect(escalations).toEqual([
      { agent_id: templateId, runtime_agent_id: runtimeId, task_id: taskId, type: "stuck_agent", severity: "high" },
    ]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ agentId: templateId, taskId, type: "stuck_agent" });

    // The runtime's state should be escalated
    expect(getState(runtimeId)!.state).toBe("escalated");

    // Logged as escalated
    const logs = db
      .prepare("SELECT detection_type FROM stuck_detection_logs WHERE agent_id = ?")
      .all(runtimeId) as { detection_type: string }[];
    expect(logs.some((l) => l.detection_type === "escalated")).toBe(true);
  });

  it("files the escalation on the stuck runtime's own task and kills that runtime, not the template", () => {
    const templateId = createAgent("Shared Entrypoint");
    setAgentPid(templateId, 99999);
    // Two tasks run this template. The shared agents row points at task A, but
    // the stuck runtime belongs to task B.
    const taskA = createTask();
    const taskB = createTask();
    db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskA, templateId);
    startRuntime(templateId, { taskId: taskA });
    const runtimeB = startRuntime(templateId, { taskId: taskB });
    insertTerminalOutput(runtimeB, "frozen", 1);
    createAgentState(runtimeB, {
      state: "working",
      screen_fingerprint: "frozen",
      nudge_count: 3,
    });

    const killed: string[] = [];
    spyOn(agentManager, "killAgent").mockImplementation((id: string) => {
      killed.push(id);
      return true;
    });

    tracker.handleStuckAgent(runtimeB);

    const escalation = db
      .prepare("SELECT task_id, runtime_agent_id FROM escalations WHERE agent_id = ?")
      .get(templateId) as { task_id: string; runtime_agent_id: string | null } | null;
    expect(escalation?.task_id).toBe(taskB);
    expect(escalation?.runtime_agent_id).toBe(runtimeB);
    expect(killed).toEqual([runtimeB]);
  });

  it("never nudges or escalates through a template-keyed row", () => {
    const templateId = createAgent("Legacy Template");
    setAgentPid(templateId, 99999);
    const taskId = createTask();
    db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskId, templateId);
    startRuntime(templateId, { taskId });
    const targets = captureNudges();
    const killSpy = spyOn(agentManager, "killAgent").mockImplementation(() => true);

    // Nudge path
    createAgentState(templateId, { state: "working", screen_fingerprint: "", nudge_count: 0 });
    tracker.handleStuckAgent(templateId);
    // Escalation path
    createAgentState(templateId, { state: "working", screen_fingerprint: "", nudge_count: 3 });
    tracker.handleStuckAgent(templateId);

    expect(targets).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
    expect(db.prepare("SELECT * FROM escalations").all()).toHaveLength(0);
  });

  it("does nothing when the runtime has no state record", () => {
    const runtimeId = startRuntime(createAgent("Ghost Agent"));
    // No state record
    tracker.handleStuckAgent(runtimeId); // Should not throw
    expect(getState(runtimeId)).toBeNull();
  });

  it("does not throw when sendInput fails (closed stdin)", () => {
    const runtimeId = startRuntime(createAgent("Closed Stdin Agent"));
    insertTerminalOutput(runtimeId, "frozen", 1);
    createAgentState(runtimeId, {
      state: "working",
      screen_fingerprint: "frozen",
      nudge_count: 0,
    });

    spyOn(agentManager, "sendInput").mockImplementation(() => {
      throw new Error("stdin closed");
    });

    // Should not throw
    tracker.handleStuckAgent(runtimeId);

    // Nudge count still incremented
    expect(getState(runtimeId)!.nudge_count).toBe(1);
  });

  it("does not nudge when the runtime is actively waiting on its own child delegation", () => {
    const templateId = createAgent("Skipper");
    const childAgentId = createAgent("Librarian");
    const taskId = createTask();
    const parentRuntime = startRuntime(templateId, { taskId, status: "waiting_delegation" });
    const childRuntime = startRuntime(childAgentId, { taskId, pid: 54321 });
    insertDelegation(templateId, childAgentId, parentRuntime, childRuntime, taskId);
    insertTerminalOutput(parentRuntime, "frozen", 1);
    createAgentState(parentRuntime, {
      state: "working",
      screen_fingerprint: "frozen",
      nudge_count: 2,
    });

    const sendSpy = spyOn(agentManager, "sendInput").mockImplementation(() => { });
    tracker.handleStuckAgent(parentRuntime);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(getState(parentRuntime)).toMatchObject({ state: "waiting_delegation", nudge_count: 0 });
  });
});

describe("active child instances guard", () => {
  it("skips stuck detection when the runtime's own task has running child instances (entrypoint agent)", () => {
    const taskId = createTask();
    const runtimeId = startRuntime(createAgent("Skipper Entrypoint"), { taskId });
    createAgentState(runtimeId, {
      state: "working",
      screen_fingerprint: "frozen",
      heartbeat_at: minutesAgo(40),
    });

    // A running child instance on the same task (different agent)
    startRuntime(createAgent("Worker"), { taskId, pid: 54321 });

    expect(tracker.getStuckCandidates()).not.toContain(runtimeId);
  });

  it("skips stuck detection when the runtime's own task has pending child instances", () => {
    const taskId = createTask();
    const runtimeId = startRuntime(createAgent("Skipper Pending"), { taskId });
    createAgentState(runtimeId, {
      state: "working",
      screen_fingerprint: "frozen",
      heartbeat_at: minutesAgo(40),
    });

    startRuntime(createAgent("Worker Pending"), { taskId, status: "pending", pid: null });

    expect(tracker.getStuckCandidates()).not.toContain(runtimeId);
  });

  it("does not skip when child instances are all completed", () => {
    const taskId = createTask();
    const runtimeId = startRuntime(createAgent("Skipper NoChildren"), { taskId });
    createAgentState(runtimeId, {
      state: "working",
      screen_fingerprint: "frozen",
      heartbeat_at: minutesAgo(40),
    });

    // Only completed children, no active ones
    startRuntime(createAgent("Worker Done"), { taskId, status: "completed", pid: null });

    expect(tracker.getStuckCandidates()).toContain(runtimeId);
  });

  it("ignores agents.current_task_id: another task's children do not shield the runtime", () => {
    const templateId = createAgent("Skipper Shared");
    // The shared slot names task B, which has a running child.
    const taskB = createTask();
    db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskB, templateId);
    startRuntime(createAgent("Worker B"), { taskId: taskB, pid: 54321 });
    // Task A's runtime works alone.
    const runtimeA = startRuntime(templateId);
    createAgentState(runtimeA, {
      state: "working",
      screen_fingerprint: "frozen",
      heartbeat_at: minutesAgo(40),
    });

    expect(tracker.getStuckCandidates()).toContain(runtimeA);
  });
});

describe("nudge count reset", () => {
  it("resets nudge_count when fingerprint changes in updateHeartbeats", () => {
    const runtimeId = startRuntime(createAgent("Nudge Reset Agent"));
    insertTerminalOutput(runtimeId, "old output", 1);

    createAgentState(runtimeId, {
      state: "working",
      screen_fingerprint: "stale fingerprint",
      nudge_count: 2,
    });

    tracker.updateHeartbeats();

    expect(getState(runtimeId)!.nudge_count).toBe(0);
  });

  it("resets nudge_count when fingerprint changes in analyzeStuckAgent", () => {
    const runtimeId = startRuntime(createAgent("Analyze Reset Agent"));
    insertTerminalOutput(runtimeId, "new output", 1);

    createAgentState(runtimeId, {
      state: "working",
      screen_fingerprint: "old fingerprint",
      nudge_count: 2,
    });

    expect(tracker.analyzeStuckAgent(runtimeId)).toBe(false);
    expect(getState(runtimeId)!.nudge_count).toBe(0);
  });

  it("does not reset nudge_count when fingerprint is unchanged", () => {
    const runtimeId = startRuntime(createAgent("No Reset Agent"));
    insertTerminalOutput(runtimeId, "same output", 1);

    createAgentState(runtimeId, {
      state: "working",
      screen_fingerprint: "same output",
      nudge_count: 2,
    });

    tracker.updateHeartbeats();

    expect(getState(runtimeId)!.nudge_count).toBe(2);
  });
});

describe("re-arming a parked runtime", () => {
  it("returns an escalated runtime to working once its escalation is resolved", () => {
    const templateId = createAgent("Resumed Agent");
    const runtimeId = startRuntime(templateId);
    insertTerminalOutput(runtimeId, "frozen", 1);
    createAgentState(runtimeId, { state: "escalated", screen_fingerprint: "frozen", heartbeat_at: minutesAgo(40), nudge_count: 3 });
    const escalationId = insertEscalation(templateId, runtimeId, taskOf(runtimeId), "stuck_agent");

    tracker.updateHeartbeats();
    expect(getState(runtimeId)!.state).toBe("escalated");

    db.prepare("UPDATE escalations SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?").run(escalationId);
    tracker.updateHeartbeats();

    expect(getState(runtimeId)!.state).toBe("working");
    expect(tracker.getStuckCandidates()).toEqual([runtimeId]);
  });

  it("returns a runtime parked in waiting_delegation to working once its delegations finish", () => {
    const templateId = createAgent("Skipper");
    const childAgentId = createAgent("Librarian");
    const taskId = createTask();
    const parentRuntime = startRuntime(templateId, { taskId, status: "waiting_delegation" });
    const childRuntime = startRuntime(childAgentId, { taskId, pid: 54321 });
    const delegationId = insertDelegation(templateId, childAgentId, parentRuntime, childRuntime, taskId);
    insertTerminalOutput(parentRuntime, "frozen", 1);
    createAgentState(parentRuntime, { state: "working", screen_fingerprint: "frozen", heartbeat_at: minutesAgo(40) });

    expect(tracker.getStuckCandidates()).toEqual([]);
    expect(getState(parentRuntime)!.state).toBe("waiting_delegation");

    // The child finishes and the result routes back: the parent runs again.
    db.prepare("UPDATE delegations SET status = 'completed' WHERE id = ?").run(delegationId);
    db.prepare("UPDATE agent_instances SET status = 'completed', process_pid = NULL WHERE id = ?").run(childRuntime);
    db.prepare("UPDATE agent_instances SET status = 'running' WHERE id = ?").run(parentRuntime);
    tracker.updateHeartbeats();

    expect(getState(parentRuntime)!.state).toBe("working");
    expect(tracker.getStuckCandidates()).toEqual([parentRuntime]);
  });
});

describe("stuck detection cycle with two tasks on one template", () => {
  // Two tasks run the shared root template. The shared agents row holds one
  // pid and one task, the way syncTemplateRuntimeState leaves it, and a
  // template-keyed heartbeat row is left over from before per-runtime tracking.
  function twoTaskRoots(): { templateId: string; taskA: string; taskB: string; rootA: string; rootB: string } {
    const templateId = createAgent("Shared Root");
    const taskA = createTask();
    const taskB = createTask();
    const rootA = startRuntime(templateId, { taskId: taskA, pid: 11111 });
    const rootB = startRuntime(templateId, { taskId: taskB, pid: 22222 });
    db.prepare("UPDATE agents SET process_pid = 11111, status = 'busy', current_task_id = ? WHERE id = ?").run(taskA, templateId);
    return { templateId, taskA, taskB, rootA, rootB };
  }

  it("nudges only the stuck root, not another task's quiet root that is busy in a subprocess", () => {
    const { templateId, rootA, rootB } = twoTaskRoots();
    insertTerminalOutput(rootA, "A frozen", 1);
    insertTerminalOutput(rootB, "B waiting on its build", 1);
    const stale = minutesAgo(40);
    createAgentState(rootA, { screen_fingerprint: "A frozen", heartbeat_at: stale });
    createAgentState(rootB, { screen_fingerprint: "B waiting on its build", heartbeat_at: stale });
    createAgentState(templateId, { screen_fingerprint: "A frozenB waiting on its build", heartbeat_at: stale });
    busyPids.add(22222);
    const targets = captureNudges();

    runStuckDetection();

    expect(targets).toEqual([rootA]);
    expect(getState(rootA)!.nudge_count).toBe(1);
    expect(getState(rootB)!.nudge_count).toBe(0);
  });

  it("still nudges a stuck root while another task's root of the same template keeps printing", () => {
    const { templateId, rootA, rootB } = twoTaskRoots();
    insertTerminalOutput(rootA, "A frozen", 1);
    insertTerminalOutput(rootB, "B tick 1", 1);
    const stale = minutesAgo(40);
    createAgentState(rootA, { screen_fingerprint: "A frozen", heartbeat_at: stale });
    createAgentState(rootB, { screen_fingerprint: "B tick 1", heartbeat_at: stale });
    createAgentState(templateId, { screen_fingerprint: "A frozenB tick 1", heartbeat_at: stale });
    insertTerminalOutput(rootB, "B tick 2", 2);
    const targets = captureNudges();

    runStuckDetection();

    expect(targets).toEqual([rootA]);
  });

  it("does not let another task's delegation wait shield a stuck root", () => {
    const { templateId, taskB, rootA, rootB } = twoTaskRoots();
    const childAgentId = createAgent("Librarian");
    db.prepare("UPDATE agent_instances SET status = 'waiting_delegation' WHERE id = ?").run(rootB);
    const childB = startRuntime(childAgentId, { taskId: taskB, pid: 33333 });
    insertDelegation(templateId, childAgentId, rootB, childB, taskB);
    insertTerminalOutput(rootA, "A frozen", 1);
    insertTerminalOutput(rootB, "B delegated", 1);
    const stale = minutesAgo(40);
    createAgentState(rootA, { screen_fingerprint: "A frozen", heartbeat_at: stale });
    createAgentState(rootB, { screen_fingerprint: "B delegated", heartbeat_at: stale });
    createAgentState(templateId, { screen_fingerprint: "A frozenB delegated", heartbeat_at: stale });
    const targets = captureNudges();

    runStuckDetection();

    expect(targets).toEqual([rootA]);
  });

  it("does not let the children of the task named by agents.current_task_id shield a stuck root", () => {
    const { templateId, taskA, taskB, rootA, rootB } = twoTaskRoots();
    // The shared slot now names task B, whose root waits on a running worker.
    db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskB, templateId);
    startRuntime(createAgent("Worker"), { taskId: taskB, pid: 33333 });
    insertTerminalOutput(rootA, "A frozen", 1);
    insertTerminalOutput(rootB, "B quiet", 1);
    const stale = minutesAgo(40);
    createAgentState(rootA, { screen_fingerprint: "A frozen", heartbeat_at: stale });
    createAgentState(rootB, { screen_fingerprint: "B quiet", heartbeat_at: stale });
    createAgentState(templateId, { screen_fingerprint: "A frozenB quiet", heartbeat_at: stale });
    const targets = captureNudges();

    runStuckDetection();

    expect(targets).toEqual([rootA]);
    expect(taskOf(rootA)).toBe(taskA);
  });
});

describe("last_signal_at", () => {
  it("is stamped on the runtime that sent the signal, not its template", () => {
    const daemon = new ManagerDaemon(db);
    try {
      const templateId = createAgent("Signalling Agent");
      const runtimeId = startRuntime(templateId);

      eventBus.emit("agent:signal", { agentId: runtimeId, signalType: "note" });

      expect(getState(runtimeId)!.last_signal_at).not.toBeNull();
      expect(getState(templateId)).toBeNull();
    } finally {
      daemon.stop();
      daemon.destroy();
      daemon.getAgentManager().close();
    }
  });
});
