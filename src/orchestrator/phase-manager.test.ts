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
    spawnAgent?: (id: string, opts: unknown) => Promise<void>;
    spawnAgentInstance?: (templateId: string, runtimeId: string, opts: unknown) => Promise<void>;
    runningInstance?: { id: string; taskId: string } | undefined;
    killAgent?: (id: string) => boolean;
    failTask?: (id: string, reason: string) => void;
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
    setNeedsReview: () => {},
    failTask: overrides.failTask ?? (() => {}),
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
    getRunningAgent: () => null,
    getRunningInstanceForTask: () => overrides.runningInstance,
    getSessionId: () => null,
    getEntrypointSessionIdForTask: () => null,
    markAsRespawning: () => {},
    killAgent: overrides.killAgent ?? (() => true),
    waitForExit: async () => {},
    spawnAgent: overrides.spawnAgent ?? (async () => {}),
    // Entrypoint respawn now goes through spawnAgentInstance; route it to the
    // explicit override, else fall back to the spawnAgent override so existing
    // spawn-count assertions keep working.
    spawnAgentInstance:
      overrides.spawnAgentInstance ??
      (overrides.spawnAgent
        ? ((id: string, _runtimeId: string, opts: unknown) => overrides.spawnAgent!(id, opts))
        : (async () => {})),
  } as any;

  const mockPromptBuilder = {
    buildInitialPrompt: () => "test prompt",
    buildInitialPromptTracked: () => ({ prompt: "test prompt", noteIds: [] }),
    recordNoteDelivery: () => {},
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

  it("adds dedup key after successful phase advance", async () => {
    const agentId = createAgent(db);
    const phases = [
      { name: "Phase 1", prompt: "p1" },
      { name: "Phase 2", prompt: "p2" },
    ];
    const teamId = createTeamWithPhases(db, agentId, phases);
    createRunningTask(db, teamId, 0);

    let spawnCount = 0;
    const phaseManager = createPhaseManager(db, {
      spawnAgent: async () => {
        spawnCount++;
      },
    });

    await phaseManager.handlePhaseComplete(agentId);
    expect(spawnCount).toBe(1);
    expect(phaseManager.getPhaseCompleteHandled().has("task-1:0")).toBe(true);

    // Second call should be deduped — current_phase has advanced to 1,
    // and the dedup key for phase 0 prevents re-advancing it.
    await phaseManager.handlePhaseComplete(agentId);
    expect(spawnCount).toBe(1);
  });

  it("advance kills THIS task's entrypoint instance, not the shared template", async () => {
    const agentId = createAgent(db);
    const phases = [
      { name: "Phase 1", prompt: "p1" },
      { name: "Phase 2", prompt: "p2" },
    ];
    const teamId = createTeamWithPhases(db, agentId, phases);
    createRunningTask(db, teamId, 0);

    // The shared template (agentId) has a live runtime instance bound to task-1.
    const runtimeInstanceId = "runtime-task-1";
    let killedId: string | null = null;
    let spawnedTemplate: string | null = null;
    let spawnedRuntimeId: string | null = null;

    const phaseManager = createPhaseManager(db, {
      runningInstance: { id: runtimeInstanceId, taskId: "task-1" },
      killAgent: (id: string) => {
        killedId = id;
        return true;
      },
      spawnAgentInstance: async (templateId: string, runtimeId: string) => {
        spawnedTemplate = templateId;
        spawnedRuntimeId = runtimeId;
      },
    });

    await phaseManager.handlePhaseComplete(agentId);

    // Kill must target the task's runtime instance, never the template id.
    expect(killedId).toBe(runtimeInstanceId);
    expect(killedId).not.toBe(agentId);
    // Respawn reuses that runtime id under the same template.
    expect(spawnedTemplate).toBe(agentId);
    expect(spawnedRuntimeId).toBe(runtimeInstanceId);
  });

  it("advance with no running instance respawns under a fresh runtime id", async () => {
    const agentId = createAgent(db);
    const phases = [
      { name: "Phase 1", prompt: "p1" },
      { name: "Phase 2", prompt: "p2" },
    ];
    const teamId = createTeamWithPhases(db, agentId, phases);
    createRunningTask(db, teamId, 0);

    let killed = false;
    let spawnedRuntimeId: string | null = null;

    const phaseManager = createPhaseManager(db, {
      runningInstance: undefined,
      killAgent: () => {
        killed = true;
        return true;
      },
      spawnAgentInstance: async (_templateId: string, runtimeId: string) => {
        spawnedRuntimeId = runtimeId;
      },
    });

    await phaseManager.handlePhaseComplete(agentId);

    expect(killed).toBe(false);
    expect(spawnedRuntimeId).toBeTruthy();
    expect(spawnedRuntimeId).not.toBe(agentId);
  });
});

