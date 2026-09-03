import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { TaskRunner } from "./task-runner";
import { TaskScheduler } from "../tasks/scheduler";
import { TeamManager } from "../teams/manager";
import { PromptBuilder } from "../agents/prompt-builder";
import { clearAgentTypeCache, getAgentTypeDefinition } from "../agents/types";
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
  teamId: string | null,
  mode: "workflow" | "conversational" = "workflow",
  title = "Test Task",
): string {
  // Approved under the unified model: active, never started (started_at NULL).
  const taskId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, title, description, team_id, status, mode, approved_at)
     VALUES (?, ?, 'Task description', ?, 'active', ?, datetime('now'))`,
  ).run(taskId, title, teamId, mode);
  return taskId;
}

function createRunningTask(teamId: string, title = "Running Task"): string {
  // Working under the unified model: active, started, with a live agent
  // instance (live instances are what occupy a concurrency slot now).
  const taskId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, title, team_id, status, started_at)
     VALUES (?, ?, ?, 'active', datetime('now'))`,
  ).run(taskId, title, teamId);
  db.prepare(
    `INSERT INTO agent_instances (id, task_id, template_agent_id, status)
     VALUES (?, ?, ?, 'running')`,
  ).run(crypto.randomUUID(), taskId, ENTRYPOINT_AGENT_ID);
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
    getEffectiveRootTypeDef: (id: string) => {
      const row = db.prepare("SELECT type FROM agents WHERE id = ?").get(id) as { type: string } | null;
      return row ? getAgentTypeDefinition(row.type, db) : null;
    },
    getRootSpawnOverrides: () => ({}),
    getRunningAgent: () => null,
    getRunningInstanceForTask: () => undefined,
    clearSessionId: () => {},
    killAgent: () => {},
    waitForExit: async () => {},
    // spawnAgent/spawnAgentInstance return the RunningAgent — callers now read
    // .id off it to target the exact runtime instance for sendInput (parallel
    // same-team stdin routing). Return a minimal stub with an id.
    spawnAgent: async () => ({ id: "runtime-mock" }),
    spawnAgentInstance: async () => ({ id: "runtime-mock" }),
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

    it("starts a teamless conversational task and lets it idle (no failRun)", async () => {
      // Realtime/conversational tasks no longer bypass the queue, and teamless
      // tasks are no longer failed — they start and rest idle until input.
      const taskId = createApprovedTask(null, "conversational");

      const runner = createRunner();
      const result = await runner.processTaskQueue();

      expect(result.processed).toBe(1);
      const task = scheduler.getTask(taskId);
      expect(task?.status).toBe("active");
      expect(task?.started_at).toBeTruthy();
      expect(task?.result).toBeNull(); // not failRun'd for being teamless
      expect(scheduler.getRuntimeState(taskId)).toBe("idle");
    });

    it("an idle active task does not occupy a concurrency slot", async () => {
      const teamId = createTeam([{ name: "Phase 1", prompt: "Do something" }]);
      setBoolSetting(db, SETTING_PARALLEL_TASKS, false);

      // Idle: active + started, but no live instances — holds no slot.
      const idleTaskId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO tasks (id, title, team_id, status, started_at)
         VALUES (?, 'Idle Task', ?, 'active', datetime('now', '-1 hour'))`,
      ).run(idleTaskId, teamId);

      const approvedTaskId = createApprovedTask(teamId);

      const runner = createRunner();
      const result = await runner.processTaskQueue();

      expect(result.processed).toBe(1);
      expect(scheduler.getTask(approvedTaskId)?.started_at).toBeTruthy();
    });

    it("in sequential mode, a task with a failed run does not occupy the concurrency slot", async () => {
      const teamId = createTeam([{ name: "Phase 1", prompt: "Do something" }]);
      setBoolSetting(db, SETTING_PARALLEL_TASKS, false);

      // A failed run keeps the task active (idle, with an error result) — only
      // live instances / paused tasks hold the sequential (cap=1) slot.
      const failedRunTaskId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO tasks (id, title, team_id, status, result, started_at, completed_at)
         VALUES (?, 'Failed Run Task', ?, 'active', '{"error":"boom"}', datetime('now', '-1 hour'), datetime('now'))`,
      ).run(failedRunTaskId, teamId);

      const approvedTaskId = createApprovedTask(teamId);

      const runner = createRunner();
      const result = await runner.processTaskQueue();

      expect(result.processed).toBe(1);
      expect(scheduler.getTask(approvedTaskId)?.started_at).toBeTruthy();
    });

    it("in parallel mode, an archived task does not block the queue", async () => {
      const teamId = createTeam([{ name: "Phase 1", prompt: "Do something" }]);
      setBoolSetting(db, SETTING_PARALLEL_TASKS, true);

      const archivedTaskId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO tasks (id, title, team_id, status, result, started_at, completed_at, settled_at)
         VALUES (?, 'Archived Task', ?, 'settled', '{"error":"boom"}', datetime('now', '-1 hour'), datetime('now'), datetime('now'))`,
      ).run(archivedTaskId, teamId);

      const approvedTaskId = createApprovedTask(teamId);

      const runner = createRunner();
      const result = await runner.processTaskQueue();

      expect(result.processed).toBe(1);
      expect(scheduler.getTask(approvedTaskId)?.started_at).toBeTruthy();
    });

    it("in sequential mode, a working task (live instances) blocks the queue", async () => {
      const teamId = createTeam([{ name: "Phase 1", prompt: "Do something" }]);
      setBoolSetting(db, SETTING_PARALLEL_TASKS, false);
      createRunningTask(teamId);
      const stdTaskId = createApprovedTask(teamId);

      const runner = createRunner();
      const result = await runner.processTaskQueue();

      expect(result.processed).toBe(0);
      // Still queued: active, never started.
      expect(scheduler.getTask(stdTaskId)?.started_at).toBeNull();
      expect(scheduler.getRuntimeState(stdTaskId)).toBe("queued");
    });

    it("in sequential mode, a paused task keeps its concurrency slot", async () => {
      const teamId = createTeam([{ name: "Phase 1", prompt: "Do something" }]);
      setBoolSetting(db, SETTING_PARALLEL_TASKS, false);

      const pausedTaskId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO tasks (id, title, team_id, status, paused, started_at)
         VALUES (?, 'Paused Task', ?, 'active', 1, datetime('now'))`,
      ).run(pausedTaskId, teamId);

      const stdTaskId = createApprovedTask(teamId);

      const runner = createRunner();
      const result = await runner.processTaskQueue();

      expect(result.processed).toBe(0);
      expect(scheduler.getTask(stdTaskId)?.started_at).toBeNull();
    });
  });
});
