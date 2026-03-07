import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { DelegationManager } from "./delegation-manager";

function setupTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);

  // Create test agents
  db.prepare(
    "INSERT INTO agents (id, name, type, model, config, capabilities) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("parent-1", "Parent Agent", "claude-code", "default", '{"instruction":"test"}', "[]");
  db.prepare(
    "INSERT INTO agents (id, name, type, model, config, capabilities) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("child-1", "Child Agent", "claude-code", "default", '{"instruction":"test"}', "[]");

  // Put agents on the same team
  db.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run("team-1", "Test Team");
  db.prepare("INSERT INTO team_agents (team_id, agent_id, role) VALUES (?, ?, ?)").run("team-1", "parent-1", "worker");
  db.prepare("INSERT INTO team_agents (team_id, agent_id, role) VALUES (?, ?, ?)").run("team-1", "child-1", "worker");

  // Create a running task assigned to parent
  db.prepare(
    "INSERT INTO tasks (id, title, status, team_id) VALUES (?, ?, ?, ?)",
  ).run("task-1", "Test Task", "running", "team-1");
  db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run("task-1", "parent-1");

  return db;
}

function createMocks() {
  const sendInputMock = mock(() => {});
  const killAgentMock = mock(() => {});
  const spawnAgentMock = mock(async () => {});
  const waitForExitMock = mock(async () => {});
  const getSessionIdMock = mock(() => "session-1");
  const sendResumeMessageMock = mock(async () => {});

  const agentManager = {
    getAgent: (id: string) => {
      if (id === "parent-1") return { id: "parent-1", name: "Parent", type: "claude-code", config: { instruction: "test" } };
      if (id === "child-1") return { id: "child-1", name: "Child", type: "claude-code", config: { instruction: "test" } };
      return null;
    },
    getRunningAgent: () => null,
    sendInput: sendInputMock,
    killAgent: killAgentMock,
    spawnAgent: spawnAgentMock,
    waitForExit: waitForExitMock,
    getSessionId: getSessionIdMock,
    sendResumeMessage: sendResumeMessageMock,
  } as any;

  const promptBuilder = {
    buildDelegationPrompt: () => "delegation prompt",
  } as any;

  const taskScheduler = {
    getTask: (id: string) => {
      if (id === "task-1") return { id: "task-1", title: "Test Task", status: "running", description: null };
      return null;
    },
    failTask: mock(() => {}),
  } as any;

  const setAgentState = mock(() => {});
  const updateOrchestrationState = mock(() => {});
  const writeCheckpoint = mock(() => {});
  const getPhaseCompleteHandled = mock(() => new Set<string>());

  return {
    agentManager,
    promptBuilder,
    taskScheduler,
    setAgentState,
    updateOrchestrationState,
    writeCheckpoint,
    getPhaseCompleteHandled,
    sendInputMock,
    killAgentMock,
    spawnAgentMock,
  };
}

describe("DelegationManager", () => {
  let db: Database;

  beforeEach(() => {
    db = setupTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe("Bug 1: handleChildExit updates orchestration state", () => {
    it("updates orchestration state to AGENT_RUNNING on successful child exit", () => {
      const mocks = createMocks();
      const dm = new DelegationManager(
        db, mocks.agentManager, mocks.promptBuilder, mocks.taskScheduler,
        mocks.setAgentState, mocks.updateOrchestrationState, mocks.writeCheckpoint, mocks.getPhaseCompleteHandled,
      );

      // Insert a running delegation
      db.prepare(
        "INSERT INTO delegations (id, parent_agent_id, child_agent_id, task_id, prompt, status) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("del-1", "parent-1", "child-1", "task-1", "test", "running");

      // Insert terminal output for child
      const sessionId = "sess-1";
      db.prepare("INSERT INTO agent_sessions (id, agent_id) VALUES (?, ?)").run(sessionId, "child-1");
      db.prepare(
        "INSERT INTO terminal_outputs (agent_id, session_id, stream, data, sequence) VALUES (?, ?, ?, ?, ?)",
      ).run("child-1", sessionId, "stdout", "result data", 1);

      const delegation = dm.getDelegation("del-1")!;
      dm.handleChildExit(delegation, { agentId: "child-1", code: 0 });

      expect(mocks.updateOrchestrationState).toHaveBeenCalled();
      const call = mocks.updateOrchestrationState.mock.calls[0];
      expect(call[0]).toBe("task-1");
      expect(call[1].step).toBe("AGENT_RUNNING");
      expect(call[1].active_delegation_id).toBeNull();
    });

    it("updates orchestration state to AGENT_RUNNING on failed child exit", () => {
      const mocks = createMocks();
      const dm = new DelegationManager(
        db, mocks.agentManager, mocks.promptBuilder, mocks.taskScheduler,
        mocks.setAgentState, mocks.updateOrchestrationState, mocks.writeCheckpoint, mocks.getPhaseCompleteHandled,
      );

      db.prepare(
        "INSERT INTO delegations (id, parent_agent_id, child_agent_id, task_id, prompt, status) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("del-1", "parent-1", "child-1", "task-1", "test", "running");

      const delegation = dm.getDelegation("del-1")!;
      dm.handleChildExit(delegation, { agentId: "child-1", code: 1 });

      expect(mocks.updateOrchestrationState).toHaveBeenCalled();
      const call = mocks.updateOrchestrationState.mock.calls[0];
      expect(call[0]).toBe("task-1");
      expect(call[1].step).toBe("AGENT_RUNNING");
      expect(call[1].active_delegation_id).toBeNull();
    });
  });

  describe("Bug 2: sendInput wrapped in try-catch", () => {
    it("fails delegation and cleans up when first sendInput throws", async () => {
      const mocks = createMocks();
      mocks.sendInputMock.mockImplementation(() => {
        throw new Error("stdin closed");
      });

      const dm = new DelegationManager(
        db, mocks.agentManager, mocks.promptBuilder, mocks.taskScheduler,
        mocks.setAgentState, mocks.updateOrchestrationState, mocks.writeCheckpoint, mocks.getPhaseCompleteHandled,
      );

      const result = await dm.handleDelegation("parent-1", "child-1", "do something");

      expect(result).toBeNull();

      // Delegation should be marked failed
      const delegation = db.prepare("SELECT status FROM delegations WHERE parent_agent_id = ?").get("parent-1") as any;
      expect(delegation.status).toBe("failed");

      // Child agent should be killed
      expect(mocks.killAgentMock).toHaveBeenCalled();
    });
  });

  describe("Bug 3: updateOrchestrationState error handling", () => {
    it("cleans up when updateOrchestrationState throws", async () => {
      const mocks = createMocks();
      mocks.updateOrchestrationState.mockImplementation(() => {
        throw new Error("InvalidTransitionError");
      });

      const dm = new DelegationManager(
        db, mocks.agentManager, mocks.promptBuilder, mocks.taskScheduler,
        mocks.setAgentState, mocks.updateOrchestrationState, mocks.writeCheckpoint, mocks.getPhaseCompleteHandled,
      );

      const result = await dm.handleDelegation("parent-1", "child-1", "do something");

      expect(result).toBeNull();

      // Delegation should be marked failed
      const delegation = db.prepare("SELECT status FROM delegations WHERE parent_agent_id = ?").get("parent-1") as any;
      expect(delegation.status).toBe("failed");

      // Parent state should be reset to working
      expect(mocks.setAgentState).toHaveBeenCalledWith("parent-1", "working");
    });
  });

  describe("Bug 4: spawn failure cleanup", () => {
    it("cleans up parent state and orchestration state on spawn failure", async () => {
      const mocks = createMocks();
      mocks.spawnAgentMock.mockImplementation(async () => {
        throw new Error("spawn failed");
      });

      const dm = new DelegationManager(
        db, mocks.agentManager, mocks.promptBuilder, mocks.taskScheduler,
        mocks.setAgentState, mocks.updateOrchestrationState, mocks.writeCheckpoint, mocks.getPhaseCompleteHandled,
      );

      const result = await dm.handleDelegation("parent-1", "child-1", "do something");

      expect(result).toBeNull();

      // Parent agent state should be reset to working
      expect(mocks.setAgentState).toHaveBeenCalledWith("parent-1", "working");

      // Orchestration state should be updated back to AGENT_RUNNING
      expect(mocks.updateOrchestrationState).toHaveBeenCalled();
      const call = mocks.updateOrchestrationState.mock.calls[0];
      expect(call[0]).toBe("task-1");
      expect(call[1].step).toBe("AGENT_RUNNING");
      expect(call[1].active_delegation_id).toBeNull();
    });
  });

  describe("Bug 5: routeResultToParent race condition", () => {
    it("checks task status before failing on resume error", () => {
      const mocks = createMocks();
      // Make the task already completed
      mocks.taskScheduler.getTask = (id: string) => {
        if (id === "task-1") return { id: "task-1", title: "Test Task", status: "completed", description: null };
        return null;
      };

      const dm = new DelegationManager(
        db, mocks.agentManager, mocks.promptBuilder, mocks.taskScheduler,
        mocks.setAgentState, mocks.updateOrchestrationState, mocks.writeCheckpoint, mocks.getPhaseCompleteHandled,
      );

      // Simulate the resume path by ensuring no running parent
      mocks.agentManager.getRunningAgent = () => null;
      mocks.agentManager.sendResumeMessage = mock(() => Promise.reject(new Error("resume failed")));

      dm.routeResultToParent("parent-1", "child-1", "result", "task-1");

      // Wait for the async catch to execute
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          // failTask should NOT have been called since task is already completed
          expect(mocks.taskScheduler.failTask).not.toHaveBeenCalled();
          resolve();
        }, 50);
      });
    });
  });
});
