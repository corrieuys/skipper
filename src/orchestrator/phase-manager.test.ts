import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { PhaseManager } from "./phase-manager";
import { unlinkSync } from "fs";

const TEST_DB = "test-phase-manager.db";

let db: Database;

function setupDb(): Database {
  const database = new Database(TEST_DB);
  database.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(database);
  return database;
}

function createAgent(database: Database, id = "agent-1"): string {
  database
    .prepare(
      "INSERT INTO agents (id, name, type, config, capabilities) VALUES (?, ?, 'claude-code', '{}', '[]')",
    )
    .run(id, `Agent ${id}`);
  return id;
}

function createTeamWithPhases(
  database: Database,
  agentId: string,
  phases: { name: string; prompt: string }[],
  teamId = "team-1",
): string {
  database
    .prepare(
      "INSERT INTO teams (id, name, entrypoint_agent_id, phases) VALUES (?, ?, ?, ?)",
    )
    .run(teamId, "Test Team", agentId, JSON.stringify(phases));
  return teamId;
}

function createRunningTask(
  database: Database,
  teamId: string,
  currentPhase = 0,
  taskId = "task-1",
): string {
  database
    .prepare(
      "INSERT INTO tasks (id, title, team_id, status, current_phase) VALUES (?, ?, ?, 'running', ?)",
    )
    .run(taskId, "Test Task", teamId, currentPhase);
  database
    .prepare("UPDATE agents SET current_task_id = ? WHERE id = 'agent-1'")
    .run(taskId);
  return taskId;
}

function createPhaseManager(
  database: Database,
  overrides: {
    completeTask?: (id: string) => void;
    advancePhase?: (id: string) => { current_phase: number };
    sendInput?: (agentId: string, prompt: string) => void;
  } = {},
): PhaseManager {
  const mockTaskScheduler = {
    getTask: (id: string) => {
      const row = database
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(id) as Record<string, unknown> | null;
      if (!row) return null;
      return {
        id: row.id as string,
        title: row.title as string,
        description: row.description as string | null,
        team_id: row.team_id as string | null,
        status: row.status as string,
        current_phase: row.current_phase as number,
        regression_count: row.regression_count as number,
      };
    },
    completeTask: overrides.completeTask ?? (() => {}),
    advancePhase:
      overrides.advancePhase ??
      ((id: string) => {
        database
          .prepare(
            "UPDATE tasks SET current_phase = current_phase + 1 WHERE id = ?",
          )
          .run(id);
        return database.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as {
          current_phase: number;
        };
      }),
  } as any;

  const mockAgentManager = {
    getAgent: (id: string) => {
      const row = database
        .prepare("SELECT * FROM agents WHERE id = ?")
        .get(id) as Record<string, unknown> | null;
      if (!row) return null;
      return {
        id: row.id as string,
        name: row.name as string,
        type: row.type as string,
        config: JSON.parse((row.config as string) ?? "{}"),
      };
    },
    sendInput: overrides.sendInput ?? (() => {}),
  } as any;

  const mockPromptBuilder = {
    buildInitialPrompt: () => "test prompt",
  } as any;

  const mockTeamManager = {
    getTeamForExecution: (teamId: string) => {
      const row = database
        .prepare("SELECT * FROM teams WHERE id = ?")
        .get(teamId) as Record<string, unknown> | null;
      if (!row || !row.entrypoint_agent_id) return null;
      return {
        team: {
          phases: JSON.parse((row.phases as string) ?? "[]"),
        },
        entrypoint_agent_id: row.entrypoint_agent_id as string,
      };
    },
  } as any;

  return new PhaseManager(
    database,
    mockAgentManager,
    mockPromptBuilder,
    mockTaskScheduler,
    mockTeamManager,
    () => {},
    () => {},
  );
}

beforeEach(() => {
  db = setupDb();
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

describe("handlePhaseComplete - dedup retry after failure", () => {
  it("does not add dedup key when completeTask throws, allowing retry", () => {
    const agentId = createAgent(db);
    const teamId = createTeamWithPhases(db, agentId, []);
    createRunningTask(db, teamId, 0);

    let callCount = 0;
    const phaseManager = createPhaseManager(db, {
      completeTask: () => {
        callCount++;
        if (callCount === 1) throw new Error("DB error on first attempt");
      },
    });

    // First call: completeTask throws — dedup key should NOT be persisted
    phaseManager.handlePhaseComplete(agentId);
    expect(callCount).toBe(1);
    expect(phaseManager.getPhaseCompleteHandled().size).toBe(0);

    // Second call: should be allowed through (not deduped)
    phaseManager.handlePhaseComplete(agentId);
    expect(callCount).toBe(2);
  });

  it("adds dedup key after successful completeTask, preventing duplicate", () => {
    const agentId = createAgent(db);
    const teamId = createTeamWithPhases(db, agentId, []);
    createRunningTask(db, teamId, 0);

    let callCount = 0;
    const phaseManager = createPhaseManager(db, {
      completeTask: () => {
        callCount++;
      },
    });

    // First call: succeeds — dedup key added
    phaseManager.handlePhaseComplete(agentId);
    expect(callCount).toBe(1);
    expect(phaseManager.getPhaseCompleteHandled().has("task-1:0")).toBe(true);

    // Second call: should be deduped
    phaseManager.handlePhaseComplete(agentId);
    expect(callCount).toBe(1);
  });

  it("adds dedup key after successful phase advance", () => {
    const agentId = createAgent(db);
    const phases = [
      { name: "Phase 1", prompt: "p1" },
      { name: "Phase 2", prompt: "p2" },
    ];
    const teamId = createTeamWithPhases(db, agentId, phases);
    createRunningTask(db, teamId, 0);

    let sendCount = 0;
    const phaseManager = createPhaseManager(db, {
      sendInput: () => {
        sendCount++;
      },
    });

    phaseManager.handlePhaseComplete(agentId);
    expect(sendCount).toBe(1);
    expect(phaseManager.getPhaseCompleteHandled().has("task-1:0")).toBe(true);

    // Second call should be deduped
    phaseManager.handlePhaseComplete(agentId);
    expect(sendCount).toBe(1);
  });
});

describe("clearPendingRegression - memory leak cleanup", () => {
  it("clearPendingRegression removes a pending regression entry", () => {
    const agentId = createAgent(db);
    const phases = [
      { name: "Phase 1", prompt: "p1" },
      { name: "Phase 2", prompt: "p2" },
    ];
    const teamId = createTeamWithPhases(db, agentId, phases);
    createRunningTask(db, teamId, 1);

    const phaseManager = createPhaseManager(db);

    // Manually inject a pending regression to simulate non-streaming flow
    phaseManager.getPendingRegressions().set(agentId, {
      targetPhase: 0,
      reason: "test regression",
    });

    expect(phaseManager.getPendingRegression(agentId)).toBeDefined();

    phaseManager.clearPendingRegression(agentId);

    expect(phaseManager.getPendingRegression(agentId)).toBeUndefined();
  });

  it("clearPendingRegression is a no-op for unknown agent", () => {
    const phaseManager = createPhaseManager(db);
    // Should not throw for non-existent agent
    expect(() => phaseManager.clearPendingRegression("unknown-agent")).not.toThrow();
  });

  it("pending regression is cleaned up on successful exit when team is missing", () => {
    const agentId = createAgent(db);
    const teamId = createTeamWithPhases(db, agentId, [{ name: "P1", prompt: "p1" }]);
    createRunningTask(db, teamId, 0);

    const phaseManager = createPhaseManager(db);

    // Inject a pending regression
    phaseManager.getPendingRegressions().set(agentId, {
      targetPhase: 0,
      reason: "regression reason",
    });

    // handleSuccessfulExit removes the entry even when teamExec is null
    // by setting team_id to null on the task
    db.prepare("UPDATE tasks SET team_id = NULL WHERE id = 'task-1'").run();

    const task = {
      id: "task-1",
      title: "Test Task",
      description: null,
      team_id: null,
      status: "running" as const,
      current_phase: 0,
      regression_count: 0,
      priority: 5,
      result: null,
      orchestration_state: {},
      created_at: "",
      approved_at: null,
      started_at: null,
      completed_at: null,
      updated_at: "",
    };

    phaseManager.handleSuccessfulExit(task, agentId);

    // Regression should be cleaned up
    expect(phaseManager.getPendingRegression(agentId)).toBeUndefined();
  });
});
