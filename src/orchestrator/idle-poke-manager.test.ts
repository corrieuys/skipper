import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { IdlePokeManager } from "./idle-poke-manager";
import { getAgentTypeDefinition } from "../agents/types";
import { unlinkSync } from "fs";

const TEST_DB = "test-idle-poke-manager.db";

let db: Database;

const NOW = Date.now();

function ago(ms: number): number {
  return NOW - ms;
}

function setupDb(): Database {
  const database = new Database(TEST_DB);
  database.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(database);
  return database;
}

function createAgent(database: Database, id = "ip-agent-1"): string {
  database
    .prepare(
      "INSERT INTO agents (id, name, type, config, capabilities) VALUES (?, ?, 'claude-code', '{}', '[]')",
    )
    .run(id, `Agent ${id}`);
  return id;
}

function createTeam(database: Database, agentId: string, teamId = "team-1"): string {
  database
    .prepare(
      "INSERT INTO teams (id, name, entrypoint_agent_id, phases) VALUES (?, ?, ?, ?)",
    )
    .run(teamId, "Test Team", agentId, JSON.stringify([{ name: "Implementation", prompt: "Implement" }]));
  return teamId;
}

function createRunningTask(
  database: Database,
  teamId: string,
  taskId = "task-1",
): string {
  database
    .prepare(
      "INSERT INTO tasks (id, title, team_id, status, current_phase) VALUES (?, ?, ?, 'running', 0)",
    )
    .run(taskId, "Test Task", teamId);
  return taskId;
}

function setIdleSince(database: Database, taskId: string, idleAt: number): void {
  database
    .prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)")
    .run(`idle_since:${taskId}`, String(idleAt));
}

function getDaemonState(database: Database, key: string): string | null {
  const row = database
    .prepare("SELECT value FROM daemon_state WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

function buildManager(
  database: Database,
  overrides: {
    getActiveDelegationForParent?: (id: string) => unknown;
    spawnAgent?: () => Promise<void>;
    getRunningAgent?: (id: string) => unknown;
    getAgent?: (id: string) => { id: string; type: string } | null;
  } = {},
): { manager: IdlePokeManager; escalateMock: ReturnType<typeof mock>; spawnMock: ReturnType<typeof mock>; } {
  // spawnAgent returns the RunningAgent — pokeSkipper reads .id off it to target
  // the exact spawned instance for the post-spawn confirmation + sendInput.
  const spawnMock = overrides.spawnAgent ?? mock(async () => ({ id: "rt-spawn" }));
  const escalateMock = mock((_input: { taskId: string }) => ({ id: "esc-1", task_id: _input.taskId }));

  const agentManager = {
    getRunningAgent: overrides.getRunningAgent ?? mock(() => null),
    // Stale-instance teardown is now task-scoped (not template-keyed) to avoid
    // killing a sibling same-team task's entrypoint under parallel runs.
    getRunningInstanceForTask: mock(() => undefined),
    getAgent: overrides.getAgent ?? mock(() => ({ id: "skipper", type: "claude-code" })),
    getEffectiveRootTypeDef: (id: string) => {
      const agent = (overrides.getAgent ?? (() => ({ id: "skipper", type: "claude-code" })))(id);
      return agent ? getAgentTypeDefinition(agent.type, database) : null;
    },
    getRootSpawnOverrides: () => ({}),
    getEntrypointSessionIdForTask: () => "session-1",
    killAgent: mock(() => true),
    waitForExit: mock(async () => {}),
    spawnAgent: spawnMock,
    sendInput: mock(() => {}),
  } as any;

  const taskScheduler = {
    getTask: (id: string) => {
      const row = database.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | null;
      if (!row) return null;
      return {
        id: row.id as string,
        team_id: row.team_id as string | null,
        status: row.status as string,
        needs_review: !!(row.needs_review ?? 0),
        task_type: (row.task_type as string) ?? "standard",
        current_phase: row.current_phase as number,
      };
    },
  } as any;

  const teamManager = {
    getTeamForExecution: (teamId: string) => {
      const row = database.prepare("SELECT entrypoint_agent_id FROM teams WHERE id = ?").get(teamId) as { entrypoint_agent_id: string } | null;
      if (!row) return null;
      return { entrypoint_agent_id: row.entrypoint_agent_id };
    },
  } as any;

  const escalationManager = { createEscalation: escalateMock } as any;

  const manager = new IdlePokeManager(
    database,
    agentManager,
    taskScheduler,
    teamManager,
    escalationManager,
    overrides.getActiveDelegationForParent ?? (() => null),
  );

  return { manager, escalateMock, spawnMock };
}

describe("IdlePokeManager", () => {
  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it("does not poke before IDLE_POKE_DELAY_MS has elapsed", async () => {
    const agentId = createAgent(db);
    const teamId = createTeam(db, agentId);
    const taskId = createRunningTask(db, teamId);
    setIdleSince(db, taskId, ago(30_000)); // 30s ago — under the 60s threshold

    const { manager, spawnMock, escalateMock } = buildManager(db);
    const acted = await manager.runIdlePokes();

    expect(acted).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(escalateMock).not.toHaveBeenCalled();
    expect(getDaemonState(db, `idle_since:${taskId}`)).not.toBeNull();
  });

  it("pokes once after the idle threshold has elapsed and clears idle_since", async () => {
    const agentId = createAgent(db);
    const teamId = createTeam(db, agentId);
    const taskId = createRunningTask(db, teamId);
    setIdleSince(db, taskId, ago(75_000));

    // First getRunningAgent call is the "live entrypoint" gate (must be null so
    // the poke proceeds); the second is the post-spawn confirmation (must return
    // the freshly spawned runtime). Stale teardown is now task-scoped via
    // getRunningInstanceForTask (mocked to undefined), which does not consume a
    // getRunningAgent call.
    let runningCalls = 0;
    const { manager, spawnMock } = buildManager(db, {
      getRunningAgent: () => {
        runningCalls++;
        return runningCalls === 1 ? null : ({ id: "rt-spawn" } as unknown);
      },
    });
    const acted = await manager.runIdlePokes();

    expect(acted).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(getDaemonState(db, `idle_since:${taskId}`)).toBeNull();
    expect(getDaemonState(db, `idle_poke_count:${taskId}`)).toBe("1");
  });

  it("escalates after IDLE_POKE_MAX_COUNT consecutive no-op pokes", async () => {
    const agentId = createAgent(db);
    const teamId = createTeam(db, agentId);
    const taskId = createRunningTask(db, teamId);
    setIdleSince(db, taskId, ago(75_000));

    // Pretend two pokes already fired.
    db.prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)")
      .run(`idle_poke_count:${taskId}`, "2");

    const { manager, spawnMock, escalateMock } = buildManager(db);
    const acted = await manager.runIdlePokes();

    expect(acted).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(escalateMock).toHaveBeenCalledTimes(1);
    expect(getDaemonState(db, `idle_since:${taskId}`)).toBeNull();
    expect(getDaemonState(db, `idle_poke_count:${taskId}`)).toBeNull();
  });

  it("skips when there is an open escalation for the task", async () => {
    const agentId = createAgent(db);
    const teamId = createTeam(db, agentId);
    const taskId = createRunningTask(db, teamId);
    setIdleSince(db, taskId, ago(75_000));

    db.prepare(
      "INSERT INTO escalations (id, agent_id, task_id, type, question) VALUES (?, ?, ?, 'agent_request', 'q')",
    ).run("esc-existing", agentId, taskId);

    const { manager, spawnMock } = buildManager(db);
    const acted = await manager.runIdlePokes();

    expect(acted).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("skips when an active delegation exists for the task (even on a stale Skipper instance)", async () => {
    const agentId = createAgent(db);
    const childAgentId = createAgent(db, "tester-agent");
    const teamId = createTeam(db, agentId);
    const taskId = createRunningTask(db, teamId);
    setIdleSince(db, taskId, ago(75_000));

    // Older Skipper instance that issued the delegation, plus a newer Skipper
    // instance with no delegation of its own — this is the regression case:
    // the latest-only lookup used to return null and let the poke through
    // while the delegated child (e.g. the tester) was still running.
    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, status, created_at) VALUES (?, ?, ?, 'completed', datetime('now', '-2 minutes'))",
    ).run("inst-old", taskId, agentId);
    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES (?, ?, ?, 'completed')",
    ).run("inst-new", taskId, agentId);

    db.prepare(
      "INSERT INTO delegations (id, parent_agent_id, child_agent_id, parent_instance_id, task_id, prompt, status) VALUES (?, ?, ?, ?, ?, ?, 'running')",
    ).run("del-1", agentId, childAgentId, "inst-old", taskId, "do the thing");

    const { manager, spawnMock } = buildManager(db);
    const acted = await manager.runIdlePokes();

    expect(acted).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("skips when a running child agent_instance exists (e.g. consensus fan-out)", async () => {
    const agentId = createAgent(db);
    const childAgentId = createAgent(db, "tester-agent");
    const teamId = createTeam(db, agentId);
    const taskId = createRunningTask(db, teamId);
    setIdleSince(db, taskId, ago(75_000));

    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES (?, ?, ?, 'running')",
    ).run("child-inst", taskId, childAgentId);

    const { manager, spawnMock } = buildManager(db);
    const acted = await manager.runIdlePokes();

    expect(acted).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("clearIdle removes all idle/poke daemon_state rows for a task", () => {
    const taskId = "task-x";
    db.prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)").run(`idle_since:${taskId}`, "1");
    db.prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)").run(`idle_poke_count:${taskId}`, "2");
    db.prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)").run(`idle_poke_fired_at:${taskId}`, "3");

    const { manager } = buildManager(db);
    manager.clearIdle(taskId);

    expect(getDaemonState(db, `idle_since:${taskId}`)).toBeNull();
    expect(getDaemonState(db, `idle_poke_count:${taskId}`)).toBeNull();
    expect(getDaemonState(db, `idle_poke_fired_at:${taskId}`)).toBeNull();
  });

  it("skips when a recovery attempt was recorded recently for the task", async () => {
    const agentId = createAgent(db);
    const teamId = createTeam(db, agentId);
    const taskId = createRunningTask(db, teamId);
    setIdleSince(db, taskId, ago(75_000));

    db.prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)").run(
      `recovery_attempt:${taskId}`,
      JSON.stringify({ attemptedAt: new Date().toISOString(), phase: 0, checkpointSeq: 0 }),
    );

    const { manager, spawnMock } = buildManager(db);
    const acted = await manager.runIdlePokes();

    expect(acted).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
