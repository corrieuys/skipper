import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { AgentManager } from "../agents/manager";
import { clearAgentTypeCache } from "../agents/types";
import { eventBus } from "../events/bus";
import type { AgentExitEvent } from "../events/bus";
import { PhaseManager } from "./phase-manager";
import { unlinkSync } from "fs";

const TEST_DB = "test-hasdelegation-async.db";

describe("Bug 1: hasDelegation flag from DB query", () => {
  let db: Database;
  let manager: AgentManager;

  beforeEach(() => {
    clearAgentTypeCache();
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);
    manager = new AgentManager(db);

    // Register test agent type
    db.prepare(
      `INSERT OR REPLACE INTO agent_types (name, command, args, model_flag, available_models, env_vars, supports_stdin, supports_resume, resume_flag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("test-echo", "bash", JSON.stringify(["-c", "exit 0"]), null, JSON.stringify([]), JSON.stringify({}), 1, 0, null);
  });

  afterEach(() => {
    for (const [id] of manager.getRunningAgents()) {
      try { manager.killAgent(id); } catch {}
    }
    manager.getRunningAgents().clear();
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  // agent:exit carries the runtime instance UUID, not the template agent id —
  // pick the runtime id up front via spawnAgentInstance so the delegation row
  // and the exit filter are wired before the process can exit.
  function waitForExitOf(runtimeId: string): Promise<AgentExitEvent> {
    return new Promise<AgentExitEvent>((resolve) => {
      const handler = (event: AgentExitEvent) => {
        if (event.agentId === runtimeId) {
          eventBus.off("agent:exit", handler);
          resolve(event);
        }
      };
      eventBus.on("agent:exit", handler);
    });
  }

  it("emits hasDelegation=true when agent has active delegation as parent", async () => {
    const agent = manager.createAgent({ name: "Parent", type: "test-echo" });

    // Set up required FK references
    db.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run("team-1", "Test Team");
    db.prepare("INSERT INTO tasks (id, title, status, team_id) VALUES (?, ?, ?, ?)").run("task-1", "Test Task", "running", "team-1");
    db.prepare(
      "INSERT INTO agents (id, name, type, model, config, capabilities) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("child-agent", "Child", "test-echo", "default", "{}", "[]");

    const runtimeId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO delegations (id, parent_agent_id, parent_instance_id, child_agent_id, task_id, prompt, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("del-1", agent.id, runtimeId, "child-agent", "task-1", "test", "running");

    const exitPromise = waitForExitOf(runtimeId);
    await manager.spawnAgentInstance(agent.id, runtimeId, {
      workingDir: process.cwd(),
      taskId: "task-1",
      parentInstanceId: null,
      rootInstanceId: runtimeId,
      attempt: 1,
    });
    const event = await exitPromise;

    expect(event.hasDelegation).toBe(true);
  });

  it("emits hasDelegation=false when agent has no active delegation", async () => {
    const agent = manager.createAgent({ name: "Solo", type: "test-echo" });

    const runtimeId = crypto.randomUUID();
    const exitPromise = waitForExitOf(runtimeId);
    await manager.spawnAgentInstance(agent.id, runtimeId, {
      workingDir: process.cwd(),
      taskId: null,
      parentInstanceId: null,
      rootInstanceId: runtimeId,
      attempt: 1,
    });
    const event = await exitPromise;

    expect(event.hasDelegation).toBe(false);
  });
});

describe("Bug 2: fire-and-forget async calls in PhaseManager", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  function createPhaseManager(overrides: Record<string, any> = {}) {
    const agentManager = {
      getAgent: () => ({ id: "agent-1", name: "Agent", type: "claude-code", config: { instruction: "test" } }),
      getRunningAgent: () => null,
      getSessionId: () => "session-1",
      getEntrypointSessionIdForTask: () => "session-1",
      killAgent: mock(() => true),
      waitForExit: mock(async () => {}),
      spawnAgent: overrides.spawnAgent ?? mock(async () => {}),
      spawnAgentInstance: overrides.spawnAgent ?? mock(async () => {}),
      getRunningInstanceForTask: () => undefined,
      markAsRespawning: mock(() => {}),
      sendInput: overrides.sendInput ?? mock(() => {}),
    } as any;

    const promptBuilder = {
      buildInitialPrompt: () => "test prompt",
      buildInitialPromptTracked: () => ({ prompt: "test prompt", noteIds: [] }),
      recordNoteDelivery: mock(() => {}),
    } as any;

    const failTaskMock = mock(() => {});
    const taskScheduler = {
      getTask: (id: string) => {
        const row = db.prepare("SELECT current_phase FROM tasks WHERE id = ?").get(id) as { current_phase: number } | null;
        const cp = row?.current_phase ?? 0;
        return {
          id, title: "Test", status: "running", description: null,
          current_phase: cp, team_id: "team-1", regression_count: 0,
        };
      },
      advancePhase: mock((id: string) => ({ id, current_phase: 1 })),
      completeTask: mock(() => {}),
      failTask: failTaskMock,
      regressPhase: mock(() => {}),
    } as any;

    const teamManager = {
      getTeamForExecution: () => ({
        team: { phases: [{ name: "Phase 1", prompt: "p1" }, { name: "Phase 2", prompt: "p2" }] },
        entrypoint_agent_id: "agent-1",
      }),
    } as any;

    const updateOrchestrationState = mock(() => {});
    const writeCheckpoint = mock(() => {});

    // Create test agent in DB
    try {
      db.prepare(
        "INSERT INTO agents (id, name, type, model, config, capabilities) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("agent-1", "Agent", "claude-code", "default", '{"instruction":"test"}', "[]");
      db.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run("team-1", "Test Team");
      db.prepare("INSERT INTO team_agents (team_id, agent_id, role) VALUES (?, ?, ?)").run("team-1", "agent-1", "worker");
      db.prepare("INSERT INTO tasks (id, title, status, team_id) VALUES (?, ?, ?, ?)").run("task-1", "Test", "running", "team-1");
      db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run("task-1", "agent-1");
    } catch {}

    const pm = new PhaseManager(
      db, agentManager, promptBuilder, taskScheduler, teamManager,
      updateOrchestrationState, writeCheckpoint,
    );

    return { pm, failTaskMock, agentManager };
  }

  it("catches respawnForRegression failure when invoked directly via handlePhaseRegression", async () => {
    const { pm, failTaskMock } = createPhaseManager({
      spawnAgent: mock(async () => { throw new Error("spawn failed"); }),
    });

    // Set current_phase=1 so we can regress to 0
    db.prepare("UPDATE tasks SET current_phase = 1 WHERE id = 'task-1'").run();

    await pm.handlePhaseRegression("agent-1", 1, "test regression");

    expect(failTaskMock).toHaveBeenCalled();
  });
});
