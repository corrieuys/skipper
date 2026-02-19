import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { EscalationManager } from "./manager";
import { AgentManager } from "../agents/manager";
import { TaskScheduler } from "../tasks/scheduler";
import { clearAgentTypeCache } from "../agents/types";
import { eventBus } from "../events/bus";
import { unlinkSync } from "fs";

const TEST_DB = "test-escalation-manager.db";

let db: Database;
let escalationManager: EscalationManager;
let agentManager: AgentManager;
let scheduler: TaskScheduler;

function setupAgentType(
  name = "test-echo",
  supportsStdin = true,
  supportsResume = false,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO agent_types (name, command, args, supports_stdin, supports_resume)
     VALUES (?, 'bash', '["-c", "sleep 30"]', ?, ?)`,
  ).run(name, supportsStdin ? 1 : 0, supportsResume ? 1 : 0);
}

function createAgent(name: string, type = "test-echo"): string {
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO agents (id, name, type, config, capabilities) VALUES (?, ?, ?, '{}', '[]')",
  ).run(id, name, type);
  return id;
}

function createRunningTask(agentId: string): string {
  const teamId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO teams (id, name, entrypoint_agent_id, phases) VALUES (?, 'Test Team', ?, '[]')",
  ).run(teamId, agentId);
  const taId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO team_agents (id, team_id, agent_id, role) VALUES (?, ?, ?, 'worker')",
  ).run(taId, teamId, agentId);

  const taskId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, title, team_id, status, priority)
     VALUES (?, 'Test Task', ?, 'running', 5)`,
  ).run(taskId, teamId);

  // Assign task to agent
  db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskId, agentId);

  return taskId;
}

beforeEach(() => {
  clearAgentTypeCache();
  db = new Database(TEST_DB);
  initializeDatabase(db);
  agentManager = new AgentManager(db);
  escalationManager = new EscalationManager(db, agentManager);
  scheduler = new TaskScheduler(db);
});

afterEach(() => {
  // Kill any running agents
  for (const [id] of agentManager.getRunningAgents()) {
    agentManager.killAgent(id);
  }
  eventBus.removeAllListeners();
  db.close();
  try { unlinkSync(TEST_DB); } catch {}
});

describe("createEscalation", () => {
  it("creates an escalation record", () => {
    setupAgentType();
    const agentId = createAgent("agent-1");
    const taskId = createRunningTask(agentId);

    const esc = escalationManager.createEscalation({
      agentId,
      taskId,
      type: "agent_request",
      question: "Need help with this",
    });

    expect(esc.id).toBeDefined();
    expect(esc.agent_id).toBe(agentId);
    expect(esc.task_id).toBe(taskId);
    expect(esc.type).toBe("agent_request");
    expect(esc.question).toBe("Need help with this");
    expect(esc.status).toBe("open");
    expect(esc.severity).toBe("normal");
    expect(esc.response).toBeNull();
  });

  it("creates escalation with custom severity", () => {
    setupAgentType();
    const agentId = createAgent("agent-1");
    const taskId = createRunningTask(agentId);

    const esc = escalationManager.createEscalation({
      agentId,
      taskId,
      type: "permission_required",
      question: "Need elevated access",
      severity: "high",
    });

    expect(esc.severity).toBe("high");
  });
});

describe("getEscalation", () => {
  it("returns null for non-existent escalation", () => {
    expect(escalationManager.getEscalation("nonexistent")).toBeNull();
  });

  it("returns escalation by id", () => {
    setupAgentType();
    const agentId = createAgent("agent-1");
    const taskId = createRunningTask(agentId);

    const esc = escalationManager.createEscalation({
      agentId,
      taskId,
      type: "agent_request",
      question: "Help",
    });

    const fetched = escalationManager.getEscalation(esc.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(esc.id);
  });
});

describe("listEscalations", () => {
  it("lists all escalations", () => {
    setupAgentType();
    const agentId = createAgent("agent-1");
    const taskId = createRunningTask(agentId);

    escalationManager.createEscalation({ agentId, taskId, type: "a", question: "Q1" });
    escalationManager.createEscalation({ agentId, taskId, type: "b", question: "Q2" });

    const all = escalationManager.listEscalations();
    expect(all.length).toBe(2);
  });

  it("filters by status", () => {
    setupAgentType();
    const agentId = createAgent("agent-1");
    const taskId = createRunningTask(agentId);

    const esc1 = escalationManager.createEscalation({ agentId, taskId, type: "a", question: "Q1" });
    escalationManager.createEscalation({ agentId, taskId, type: "b", question: "Q2" });

    // Resolve one directly in DB
    db.prepare("UPDATE escalations SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?").run(esc1.id);

    expect(escalationManager.listEscalations("open").length).toBe(1);
    expect(escalationManager.listEscalations("resolved").length).toBe(1);
  });
});

describe("handleEscalation", () => {
  it("creates escalation for agent with active running task", () => {
    setupAgentType();
    const agentId = createAgent("agent-1");
    const taskId = createRunningTask(agentId);

    const events: any[] = [];
    eventBus.on("escalation:created", (e) => events.push(e));

    const esc = escalationManager.handleEscalation(agentId, "I'm stuck on X");

    expect(esc).not.toBeNull();
    expect(esc!.type).toBe("agent_request");
    expect(esc!.question).toBe("I'm stuck on X");
    expect(esc!.agent_id).toBe(agentId);
    expect(esc!.task_id).toBe(taskId);
    expect(esc!.status).toBe("open");

    // Should have emitted event
    expect(events.length).toBe(1);
    expect(events[0].escalationId).toBe(esc!.id);
    expect(events[0].type).toBe("agent_request");
  });

  it("sets agent state to escalated", () => {
    setupAgentType();
    const agentId = createAgent("agent-1");
    createRunningTask(agentId);

    const stateEvents: any[] = [];
    eventBus.on("agent:state_changed", (e) => stateEvents.push(e));

    escalationManager.handleEscalation(agentId, "Need help");

    // Check agent_states table
    const state = db.prepare("SELECT state FROM agent_states WHERE agent_id = ?").get(agentId) as { state: string } | null;
    expect(state?.state).toBe("escalated");

    // Should have emitted state change
    expect(stateEvents.length).toBe(1);
    expect(stateEvents[0].newState).toBe("escalated");
  });

  it("returns null when agent has no task", () => {
    setupAgentType();
    const agentId = createAgent("agent-1");
    // No task assigned

    const esc = escalationManager.handleEscalation(agentId, "Help");
    expect(esc).toBeNull();
  });

  it("returns null when agent does not exist", () => {
    const esc = escalationManager.handleEscalation("nonexistent", "Help");
    expect(esc).toBeNull();
  });

  it("returns null when task is not running", () => {
    setupAgentType();
    const agentId = createAgent("agent-1");
    const taskId = crypto.randomUUID();

    // Create a completed task
    const teamId = crypto.randomUUID();
    db.prepare("INSERT INTO teams (id, name, phases) VALUES (?, 'T', '[]')").run(teamId);
    db.prepare(
      "INSERT INTO tasks (id, title, team_id, status, priority) VALUES (?, 'Done Task', ?, 'completed', 5)",
    ).run(taskId, teamId);
    db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskId, agentId);

    const esc = escalationManager.handleEscalation(agentId, "Help");
    expect(esc).toBeNull();
  });
});

describe("resolveEscalation", () => {
  it("resolves an open escalation and injects response via stdin", async () => {
    setupAgentType();
    const agentId = createAgent("agent-1");
    const taskId = createRunningTask(agentId);

    // Spawn agent so we have a running process
    await agentManager.spawnAgent(agentId, { workingDir: process.cwd() });

    const esc = escalationManager.handleEscalation(agentId, "What should I do?")!;

    const resolvedEvents: any[] = [];
    eventBus.on("escalation:resolved", (e) => resolvedEvents.push(e));

    const sendInputSpy = spyOn(agentManager, "sendInput");

    const resolved = await escalationManager.resolveEscalation(esc.id, "Do this instead");

    expect(resolved.status).toBe("resolved");
    expect(resolved.response).toBe("Do this instead");
    expect(resolved.resolved_at).not.toBeNull();

    // Should have sent response via stdin
    expect(sendInputSpy).toHaveBeenCalledWith(agentId, "[USER_RESPONSE] Do this instead");

    // Should have reset agent state to working
    const state = db.prepare("SELECT state FROM agent_states WHERE agent_id = ?").get(agentId) as { state: string } | null;
    expect(state?.state).toBe("working");

    // Should have emitted resolved event
    expect(resolvedEvents.length).toBe(1);
    expect(resolvedEvents[0].response).toBe("Do this instead");
  });

  it("attempts resume when agent is not running", async () => {
    setupAgentType("resumable", true, true);
    db.prepare("UPDATE agent_types SET resume_flag = '--resume' WHERE name = 'resumable'").run();
    const agentId = createAgent("agent-resume", "resumable");
    const taskId = createRunningTask(agentId);

    // Set a session ID in agent_states (simulating a previous run)
    db.prepare(
      `INSERT INTO agent_states (agent_id, state, state_metadata)
       VALUES (?, 'escalated', json_object('session_id', 'sess-123'))`,
    ).run(agentId);

    const esc = escalationManager.createEscalation({
      agentId,
      taskId,
      type: "agent_request",
      question: "Q",
    });

    // Spy on sendResumeMessage
    const resumeSpy = spyOn(agentManager, "sendResumeMessage");

    await escalationManager.resolveEscalation(esc.id, "Answer");

    expect(resumeSpy).toHaveBeenCalledWith(agentId, "[USER_RESPONSE] Answer");
  });

  it("throws when escalation not found", async () => {
    expect(escalationManager.resolveEscalation("nonexistent", "resp")).rejects.toThrow(
      "Escalation not found",
    );
  });

  it("throws when escalation already resolved", async () => {
    setupAgentType();
    const agentId = createAgent("agent-1");
    const taskId = createRunningTask(agentId);

    const esc = escalationManager.createEscalation({
      agentId,
      taskId,
      type: "agent_request",
      question: "Q",
    });

    // Resolve directly in DB
    db.prepare("UPDATE escalations SET status = 'resolved', resolved_at = datetime('now'), response = 'done' WHERE id = ?").run(esc.id);

    expect(escalationManager.resolveEscalation(esc.id, "again")).rejects.toThrow(
      "already resolved",
    );
  });

  it("gracefully handles agent that cannot be resumed", async () => {
    setupAgentType(); // not resumable
    const agentId = createAgent("agent-1");
    const taskId = createRunningTask(agentId);

    const esc = escalationManager.createEscalation({
      agentId,
      taskId,
      type: "agent_request",
      question: "Q",
    });

    // Agent is not running and type doesn't support resume — should not throw
    const resolved = await escalationManager.resolveEscalation(esc.id, "Answer");
    expect(resolved.status).toBe("resolved");
    expect(resolved.response).toBe("Answer");
  });
});
