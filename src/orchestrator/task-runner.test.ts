import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { TaskRunner } from "./task-runner";
import { TaskScheduler } from "../tasks/scheduler";
import { TeamManager } from "../teams/manager";
import { PromptBuilder } from "../agents/prompt-builder";
import { clearAgentTypeCache } from "../agents/types";
import { setBoolSetting, SETTING_PARALLEL_TASKS } from "../config/app-settings";
import type { OrchestrationState } from "./types";
import { ArtifactManager } from "./artifact-manager";
import { unlinkSync } from "fs";

const TEST_DB = "test-task-runner.db";
const ENTRYPOINT_AGENT_ID = "test-entrypoint";

let db: Database;

function setupAgentType(
  name = "test-echo",
  supportsStdin = false,
  supportsResume = false,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO agent_types (name, command, args, supports_stdin, supports_resume)
     VALUES (?, 'echo', '["hello"]', ?, ?)`,
  ).run(name, supportsStdin ? 1 : 0, supportsResume ? 1 : 0);
}

function seedEntrypointAgent(): void {
  setupAgentType("claude-code", false, true);
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, name, type, model) VALUES (?, 'Lead Agent', 'claude-code', 'default')`,
  ).run(ENTRYPOINT_AGENT_ID);
}

function createTeam(
  phases: { name: string; prompt: string }[] = [],
): string {
  const teamId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO teams (id, name, entrypoint_agent_id, phases) VALUES (?, ?, ?, ?)",
  ).run(teamId, "Test Team", ENTRYPOINT_AGENT_ID, JSON.stringify(phases));

  const memberTaId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES (?, ?, ?, 'lead', 0)",
  ).run(memberTaId, teamId, ENTRYPOINT_AGENT_ID);

  return teamId;
}

function createApprovedTask(
  teamId: string,
  taskType: "standard" | "real_time" = "standard",
  title = "Test Task",
): string {
  const taskId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, title, description, team_id, status, task_type, approved_at)
     VALUES (?, ?, 'Task description', ?, 'approved', ?, datetime('now'))`,
  ).run(taskId, title, teamId, taskType);
  return taskId;
}

function createRunningTask(teamId: string, title = "Running Task"): string {
  const taskId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, title, team_id, status, started_at)
     VALUES (?, ?, ?, 'running', datetime('now'))`,
  ).run(taskId, title, teamId);
  return taskId;
}

function createMockAgentManager() {
  return {
    getAgent: (id: string) => {
      const row = db
        .prepare("SELECT * FROM agents WHERE id = ?")
        .get(id) as Record<string, unknown> | null;
      if (!row) return null;
      return {
        id: row.id as string,
        name: row.name as string,
        type: row.type as string,
        config: JSON.parse((row.config as string) || "{}"),
        capabilities: JSON.parse((row.capabilities as string) || "[]"),
        status: row.status as string,
        process_pid: row.process_pid as number | null,
        current_task_id: row.current_task_id as string | null,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
        model: row.model as string,
      };
    },
    getRunningAgent: () => null,
    getRunningInstanceForTask: () => undefined,
    clearSessionId: () => {},
    killAgent: () => {},
    waitForExit: async () => {},
    spawnAgent: async () => {},
    spawnAgentInstance: async () => {},
    sendInput: () => {},
    getSessionId: () => null,
    getEntrypointSessionIdForTask: () => null,
    getTemplateAgentId: (id: string) => id,
    getRunningAgents: () => new Map(),
  } as any;
}


describe("TaskRunner", () => {
  let scheduler: TaskScheduler;
  let teamManager: TeamManager;
  let promptBuilder: PromptBuilder;
  let artifactManager: ArtifactManager;
  let mockAgentManager: ReturnType<typeof createMockAgentManager>;
  let orchestrationUpdates: { taskId: string; state: OrchestrationState }[];
  let checkpointWrites: { taskId: string; type: string; snapshot?: Record<string, unknown> }[];

  beforeEach(() => {
    clearAgentTypeCache();
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);
    seedEntrypointAgent();

    scheduler = new TaskScheduler(db);
    teamManager = new TeamManager(db);
    artifactManager = new ArtifactManager(db);
    promptBuilder = new PromptBuilder(db, artifactManager);
    mockAgentManager = createMockAgentManager();
    orchestrationUpdates = [];
    checkpointWrites = [];
  });

  afterEach(() => {
    db.close();
    try {
      unlinkSync(TEST_DB);
    } catch {}
  });

  function createRunner(): TaskRunner {
    return new TaskRunner(
      db,
      mockAgentManager,
      promptBuilder,
      scheduler,
      teamManager,
      (taskId: string, state: OrchestrationState) => {
        orchestrationUpdates.push({ taskId, state });
      },
      (taskId: string, type: string, snapshot?: Record<string, unknown>) => {
        checkpointWrites.push({ taskId, type, snapshot });
      },
    );
  }

  describe("processTaskQueue", () => {
    it("returns processed=0 when a task is already running", async () => {
      const teamId = createTeam();
      createRunningTask(teamId);

      const runner = createRunner();
      const result = await runner.processTaskQueue();

      expect(result.processed).toBe(0);
    });

    it("returns processed=0 when no approved tasks", async () => {
      const runner = createRunner();
      const result = await runner.processTaskQueue();

      expect(result.processed).toBe(0);
    });

    it("skips real_time tasks entirely", async () => {
      const teamId = createTeam([{ name: "Phase 1", prompt: "Monitor something" }]);
      createApprovedTask(teamId, "real_time");

      const runner = createRunner();
      const result = await runner.processTaskQueue();

      // Real-time tasks are managed by RealtimeSessionManager, not the task runner
      expect(result.processed).toBe(0);
      expect(orchestrationUpdates.length).toBe(0);
      expect(checkpointWrites.length).toBe(0);
    });

    it("running real_time tasks do not count against the standard task concurrency cap", async () => {
      const teamId = createTeam([{ name: "Phase 1", prompt: "Do something" }]);

      // Create a running real_time task — managed separately by RealtimeSessionManager
      const rtTaskId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO tasks (id, title, team_id, status, task_type, started_at)
         VALUES (?, 'RT Task', ?, 'running', 'real_time', datetime('now'))`,
      ).run(rtTaskId, teamId);

      // Create a standard approved task
      const stdTaskId = createApprovedTask(teamId, "standard");

      const runner = createRunner();
      const result = await runner.processTaskQueue();

      // The realtime task is excluded from the running count, so the standard task runs
      expect(result.processed).toBe(1);
      const task = scheduler.getTask(stdTaskId);
      expect(task?.status).toBe("running");
    });

    it("in sequential mode, a failed task blocks the queue until resolved", async () => {
      const teamId = createTeam([{ name: "Phase 1", prompt: "Do something" }]);
      setBoolSetting(db, SETTING_PARALLEL_TASKS, false);

      const failedTaskId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO tasks (id, title, team_id, status, task_type, started_at, completed_at)
         VALUES (?, 'Failed Task', ?, 'failed', 'standard', datetime('now', '-1 hour'), datetime('now'))`,
      ).run(failedTaskId, teamId);

      const approvedTaskId = createApprovedTask(teamId, "standard");

      const runner = createRunner();
      const result = await runner.processTaskQueue();

      expect(result.processed).toBe(0);
      expect(scheduler.getTask(approvedTaskId)?.status).toBe("approved");
    });

    it("in parallel mode, a failed task does not block the queue", async () => {
      const teamId = createTeam([{ name: "Phase 1", prompt: "Do something" }]);
      setBoolSetting(db, SETTING_PARALLEL_TASKS, true);

      const failedTaskId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO tasks (id, title, team_id, status, task_type, started_at, completed_at)
         VALUES (?, 'Failed Task', ?, 'failed', 'standard', datetime('now', '-1 hour'), datetime('now'))`,
      ).run(failedTaskId, teamId);

      const approvedTaskId = createApprovedTask(teamId, "standard");

      const runner = createRunner();
      const result = await runner.processTaskQueue();

      expect(result.processed).toBe(1);
      expect(scheduler.getTask(approvedTaskId)?.status).toBe("running");
    });

    it("in sequential mode, a running standard task blocks the queue", async () => {
      const teamId = createTeam([{ name: "Phase 1", prompt: "Do something" }]);
      setBoolSetting(db, SETTING_PARALLEL_TASKS, false);
      createRunningTask(teamId);
      const stdTaskId = createApprovedTask(teamId, "standard");

      const runner = createRunner();
      const result = await runner.processTaskQueue();

      expect(result.processed).toBe(0);
      expect(scheduler.getTask(stdTaskId)?.status).toBe("approved");
    });
  });
});
