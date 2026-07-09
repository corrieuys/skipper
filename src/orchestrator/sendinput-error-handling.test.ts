import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { PhaseManager } from "./phase-manager";
import { TaskRunner } from "./task-runner";
import { RecoveryManager } from "./recovery-manager";
import { unlinkSync } from "fs";

const TEST_DB = "test-sendinput-errors.db";

function setupDb(): Database {
  const db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  return db;
}

function seedData(db: Database) {
  db.prepare(
    `INSERT OR IGNORE INTO agent_types (name, command, supports_stdin, supports_resume)
     VALUES ('claude-code', 'echo', 1, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO agents (id, name, type, status, config)
     VALUES ('agent-1', 'test-agent', 'claude-code', 'idle', '{"instruction":"test"}')`,
  ).run();
  db.prepare(
    `INSERT INTO teams (id, name, entrypoint_agent_id, phases)
     VALUES ('team-1', 'test-team', 'agent-1', ?)`,
  ).run(JSON.stringify([
    { name: "phase1", prompt: "do phase 1" },
    { name: "phase2", prompt: "do phase 2" },
  ]));
}

function insertTask(db: Database, id: string, status = "running", currentPhase = 0) {
  db.prepare(
    `INSERT INTO tasks (id, title, status, team_id, current_phase, orchestration_state)
     VALUES (?, ?, ?, 'team-1', ?, '{}')`,
  ).run(id, `task-${id}`, status, currentPhase);
}

function assignAgent(db: Database, taskId: string) {
  db.prepare("UPDATE agents SET current_task_id = ? WHERE id = 'agent-1'").run(taskId);
}

function throwingSendInput() {
  throw new Error("stdin closed");
}

const mockAgent = {
  id: "agent-1",
  name: "test-agent",
  type: "claude-code",
  config: { instruction: "test" },
};

const mockTeamExec = {
  team: {
    id: "team-1",
    name: "test-team",
    phases: [
      { name: "phase1", prompt: "do phase 1" },
      { name: "phase2", prompt: "do phase 2" },
    ],
  },
  entrypoint_agent_id: "agent-1",
};

describe("sendInput error handling", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
    seedData(db);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  describe("PhaseManager.handlePhaseComplete", () => {
    it("fails the task when sendInput throws during phase advance", async () => {
      insertTask(db, "task-1", "running", 0);
      assignAgent(db, "task-1");

      let failedTaskId: string | null = null;
      const pm = new PhaseManager(
        db,
        {
          getAgent: () => mockAgent,
          sendInput: throwingSendInput,
          getRunningAgent: () => null,
          getSessionId: () => null,
          getEntrypointSessionIdForTask: () => null,
          markAsRespawning: () => {},
          killAgent: () => true,
          waitForExit: async () => {},
          spawnAgent: async () => {},
          spawnAgentInstance: async () => ({ id: "runtime-mock" }),
          getRunningInstanceForTask: () => undefined,
        } as any,
        { buildInitialPrompt: () => "prompt", buildInitialPromptTracked: () => ({ prompt: "prompt", noteIds: [] }), recordNoteDelivery: () => {} } as any,
        {
          getTask: (id: string) => {
            const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
            return row ? { ...row } : null;
          },
          advancePhase: () => ({ current_phase: 1 }),
          failTask: (id: string) => { failedTaskId = id; },
        } as any,
        { getTeamForExecution: () => mockTeamExec } as any,
        () => {},
        () => {},
      );

      await pm.handlePhaseComplete("agent-1");
      expect(failedTaskId).toBe("task-1");
    });
  });

  describe("TaskRunner.processTaskQueue", () => {
    it("fails the task when sendInput throws during startup", async () => {
      insertTask(db, "task-1", "approved", 0);

      let failedTaskId: string | null = null;
      const runner = new TaskRunner(
        db,
        {
          getAgent: () => mockAgent,
          getRunningAgent: () => null,
          spawnAgent: async () => ({ id: "runtime-mock" }),
          spawnAgentInstance: async () => ({ id: "runtime-mock" }),
          getRunningInstanceForTask: () => undefined,
          markAsRespawning: () => {},
          killAgent: () => true,
          waitForExit: async () => {},
          sendInput: throwingSendInput,
          clearSessionId: () => {},
          getSessionId: () => null,
          getEntrypointSessionIdForTask: () => null,
        } as any,
        { buildInitialPrompt: () => "prompt", buildInitialPromptTracked: () => ({ prompt: "prompt", noteIds: [] }), recordNoteDelivery: () => {} } as any,
        {
          getNextApprovedTask: () => {
            const row = db.prepare("SELECT * FROM tasks WHERE status = 'approved' LIMIT 1").get() as any;
            return row ?? null;
          },
          startTask: (id: string) => { db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(id); },
          failTask: (id: string) => { failedTaskId = id; },
        } as any,
        { getTeamForExecution: () => mockTeamExec } as any,
        () => {},
        () => {},
      );

      const result = await runner.processTaskQueue();
      expect(result.processed).toBe(1);
      expect(failedTaskId).toBe("task-1");
    });
  });

  describe("RecoveryManager.recoverTask", () => {
    it("returns false when sendInput throws during recovery", async () => {
      insertTask(db, "task-1", "running", 0);
      assignAgent(db, "task-1");

      const rm = new RecoveryManager(
        db,
        {
          getAgent: () => mockAgent,
          getRunningAgent: () => null,
          getSessionId: () => null,
          getEntrypointSessionIdForTask: () => null,
          spawnAgent: async () => ({ id: "runtime-mock" }),
          sendInput: throwingSendInput,
        } as any,
        { buildInitialPrompt: () => "prompt", buildInitialPromptTracked: () => ({ prompt: "prompt", noteIds: [] }), recordNoteDelivery: () => {} } as any,
        {
          getTask: (id: string) => {
            const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
            return row ? { ...row, orchestration_state: JSON.parse(row.orchestration_state || "{}") } : null;
          },
        } as any,
        { getTeamForExecution: () => mockTeamExec } as any,
        () => new Set(),
        () => new Map(),
        () => {},
        () => null,
      );

      const result = await rm.recoverTask("task-1");
      expect(result).toBe(false);
    });
  });

  describe("PhaseManager.advanceAndRespawn", () => {
    it("fails the task when sendInput throws after respawn", async () => {
      insertTask(db, "task-1", "running", 0);
      assignAgent(db, "task-1");

      let failedTaskId: string | null = null;
      const pm = new PhaseManager(
        db,
        {
          getAgent: () => mockAgent,
          getRunningAgent: () => null,
          getSessionId: () => null,
          getEntrypointSessionIdForTask: () => null,
          spawnAgent: async () => {},
          spawnAgentInstance: async () => ({ id: "runtime-mock" }),
          getRunningInstanceForTask: () => undefined,
          markAsRespawning: () => {},
          killAgent: () => true,
          waitForExit: async () => {},
          sendInput: throwingSendInput,
        } as any,
        { buildInitialPrompt: () => "prompt", buildInitialPromptTracked: () => ({ prompt: "prompt", noteIds: [] }), recordNoteDelivery: () => {} } as any,
        {
          advancePhase: () => ({ current_phase: 1 }),
          failTask: (id: string) => { failedTaskId = id; },
        } as any,
        {} as any,
        () => {},
        () => {},
      );

      const task = { id: "task-1", title: "test", description: null, current_phase: 0 } as any;
      const phases = mockTeamExec.team.phases;
      await pm.advanceAndRespawn(task, "agent-1", phases);
      expect(failedTaskId).toBe("task-1");
    });
  });

  describe("PhaseManager.respawnForRegression", () => {
    it("fails the task when sendInput throws after regression respawn", async () => {
      insertTask(db, "task-1", "running", 1);
      assignAgent(db, "task-1");

      let failedTaskId: string | null = null;
      const pm = new PhaseManager(
        db,
        {
          getAgent: () => mockAgent,
          getRunningAgent: () => null,
          getSessionId: () => null,
          getEntrypointSessionIdForTask: () => null,
          spawnAgent: async () => {},
          spawnAgentInstance: async () => ({ id: "runtime-mock" }),
          getRunningInstanceForTask: () => undefined,
          markAsRespawning: () => {},
          killAgent: () => true,
          waitForExit: async () => {},
          sendInput: throwingSendInput,
        } as any,
        { buildInitialPrompt: () => "prompt", buildInitialPromptTracked: () => ({ prompt: "prompt", noteIds: [] }), recordNoteDelivery: () => {} } as any,
        {
          failTask: (id: string) => { failedTaskId = id; },
        } as any,
        {} as any,
        () => {},
        () => {},
      );

      const task = { id: "task-1", title: "test", description: null } as any;
      const phases = mockTeamExec.team.phases;
      await pm.respawnForRegression(task, "agent-1", phases, 0, "quality issues");
      expect(failedTaskId).toBe("task-1");
    });
  });
});
