import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { IdlePokeManager } from "./idle-poke-manager";
import { getAgentTypeDefinition } from "../agents/types";
import { setBoolSetting, SETTING_PARALLEL_TASKS } from "../config/app-settings";
import { EscalationManager } from "../escalations/manager";
import { eventBus, type EscalationCreatedEvent } from "../events/bus";
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
      "INSERT INTO tasks (id, title, team_id, status, current_phase) VALUES (?, ?, ?, 'active', 0)",
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
    spawnAgent?: (...args: any[]) => Promise<unknown>;
    getRunningAgent?: (id: string) => unknown;
    getRunningInstanceForTask?: (templateAgentId: string, taskId: string) => unknown;
    killAgent?: (id: string) => boolean;
    getAgent?: (id: string) => { id: string; type: string } | null;
    escalationManager?: EscalationManager;
  } = {},
): { manager: IdlePokeManager; escalateMock: ReturnType<typeof mock>; spawnMock: ReturnType<typeof mock>; } {
  // spawnAgent returns the RunningAgent — pokeSkipper reads .id off it to target
  // the exact spawned instance for the post-spawn confirmation + sendInput.
  const spawnMock = overrides.spawnAgent ?? mock(async () => ({ id: "rt-spawn" }));
  const escalateMock = mock((_input: { taskId: string }) => ({ id: "esc-1", task_id: _input.taskId }));

  const agentManager = {
    getRunningAgent: overrides.getRunningAgent ?? mock(() => null),
    // The live-entrypoint gate and stale-instance teardown are task-scoped (not
    // template-keyed), so a sibling task's live root neither blocks the poke nor
    // gets killed by it under parallel runs.
    getRunningInstanceForTask: overrides.getRunningInstanceForTask ?? mock(() => undefined),
    getAgent: overrides.getAgent ?? mock(() => ({ id: "skipper", type: "claude-code" })),
    getEffectiveRootTypeDef: (id: string) => {
      const agent = (overrides.getAgent ?? (() => ({ id: "skipper", type: "claude-code" })))(id);
      return agent ? getAgentTypeDefinition(agent.type, database) : null;
    },
    getRootSpawnOverrides: () => ({}),
    getEntrypointSessionIdForTask: () => "session-1",
    killAgent: overrides.killAgent ?? mock(() => true),
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
        paused: !!(row.paused ?? 0),
        mode: (row.mode as string) ?? "workflow",
        needs_review: !!(row.needs_review ?? 0),
        orchestration_state: JSON.parse((row.orchestration_state as string) || "{}"),
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

  const escalationManager = overrides.escalationManager ?? ({ createEscalation: escalateMock } as any);

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

    // The "live entrypoint" gate and stale teardown are task-scoped via
    // getRunningInstanceForTask (mocked to undefined), so getRunningAgent is
    // only the post-spawn confirmation, by the spawned runtime id.
    const { manager, spawnMock } = buildManager(db, {
      getRunningAgent: (id) => (id === "rt-spawn" ? ({ id: "rt-spawn" } as unknown) : null),
    });
    const acted = await manager.runIdlePokes();

    expect(acted).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(getDaemonState(db, `idle_since:${taskId}`)).toBeNull();
    expect(getDaemonState(db, `idle_poke_count:${taskId}`)).toBe("1");
  });

  // Every team shares one entrypoint template (e.g. `skipper`). This fake keeps
  // AgentManager's lookup semantics: a template id passed to getRunningAgent
  // resolves to ANY task's live instance; getRunningInstanceForTask only to the
  // given task's.
  function sharedTemplateAgents() {
    const running = new Map<string, { id: string; taskId: string; templateAgentId: string }>();
    return {
      running,
      getRunningAgent: (id: string) =>
        running.get(id) ?? [...running.values()].find((a) => a.templateAgentId === id),
      getRunningInstanceForTask: (templateAgentId: string, taskId: string) =>
        [...running.values()].find((a) => a.templateAgentId === templateAgentId && a.taskId === taskId),
      spawnAgent: mock(async (templateAgentId: string, opts: { taskId: string }) => {
        const agent = { id: `rt-${opts.taskId}`, taskId: opts.taskId, templateAgentId };
        running.set(agent.id, agent);
        return agent;
      }),
      killAgent: mock((_id: string) => true),
    };
  }

  it("pokes an idle task while another task's root on the same template is live", async () => {
    const agentId = createAgent(db);
    const teamId = createTeam(db, agentId);
    const taskId = createRunningTask(db, teamId);
    createRunningTask(db, teamId, "task-other");
    setIdleSince(db, taskId, ago(75_000));

    const agents = sharedTemplateAgents();
    agents.running.set("rt-other", { id: "rt-other", taskId: "task-other", templateAgentId: agentId });

    const { manager } = buildManager(db, agents);
    const acted = await manager.runIdlePokes();

    expect(acted).toBe(1);
    expect(agents.spawnAgent).toHaveBeenCalledTimes(1);
    expect(agents.spawnAgent.mock.calls[0]![1].taskId).toBe(taskId);
    // The other task's root is left alone.
    expect(agents.killAgent).not.toHaveBeenCalled();
    expect(agents.running.has("rt-other")).toBe(true);
    expect(getDaemonState(db, `idle_since:${taskId}`)).toBeNull();
    expect(getDaemonState(db, `idle_poke_count:${taskId}`)).toBe("1");
  });

  it("does not poke while this task's own root is still live", async () => {
    const agentId = createAgent(db);
    const teamId = createTeam(db, agentId);
    const taskId = createRunningTask(db, teamId);
    setIdleSince(db, taskId, ago(75_000));

    const agents = sharedTemplateAgents();
    agents.running.set("rt-mine", { id: "rt-mine", taskId, templateAgentId: agentId });

    const { manager } = buildManager(db, agents);
    const acted = await manager.runIdlePokes();

    expect(acted).toBe(0);
    expect(agents.spawnAgent).not.toHaveBeenCalled();
    expect(agents.killAgent).not.toHaveBeenCalled();
    expect(getDaemonState(db, `idle_since:${taskId}`)).not.toBeNull();
  });

  it("waits for a free concurrency slot before it pokes (parallel execution off)", async () => {
    setBoolSetting(db, SETTING_PARALLEL_TASKS, false);
    const agentId = createAgent(db);
    const teamId = createTeam(db, agentId);
    const taskId = createRunningTask(db, teamId);
    createRunningTask(db, teamId, "task-busy");
    // The busy task holds the only slot: it has a live agent instance.
    db.prepare("INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES (?, ?, ?, 'running')")
      .run("rt-busy", "task-busy", agentId);
    setIdleSince(db, taskId, ago(75_000));

    const agents = sharedTemplateAgents();
    agents.running.set("rt-busy", { id: "rt-busy", taskId: "task-busy", templateAgentId: agentId });
    const { manager } = buildManager(db, agents);

    expect(await manager.runIdlePokes()).toBe(0);
    expect(agents.spawnAgent).not.toHaveBeenCalled();
    expect(getDaemonState(db, `idle_since:${taskId}`)).not.toBeNull();
    expect(getDaemonState(db, `idle_poke_count:${taskId}`)).toBeNull();

    // The busy task's agent ends and frees the slot: the next tick pokes.
    db.prepare("UPDATE agent_instances SET status = 'completed' WHERE id = ?").run("rt-busy");
    agents.running.delete("rt-busy");
    expect(await manager.runIdlePokes()).toBe(1);
    expect(agents.spawnAgent).toHaveBeenCalledTimes(1);
    expect(agents.spawnAgent.mock.calls[0]![1].taskId).toBe(taskId);
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

  // The exhaustion escalation used to be inserted silently: the task showed
  // blocked, but no surface (web, apps, TUI, Slack, sounds, hooks) was told.
  it("announces the exhaustion escalation once on escalation:created", async () => {
    const agentId = createAgent(db);
    const teamId = createTeam(db, agentId);
    const taskId = createRunningTask(db, teamId);
    setIdleSince(db, taskId, ago(75_000));
    db.prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)")
      .run(`idle_poke_count:${taskId}`, "2");

    // The real writer (createEscalation never touches the AgentManager).
    const escalationManager = new EscalationManager(db, {} as any);
    const events: EscalationCreatedEvent[] = [];
    const onCreated = (e: EscalationCreatedEvent) => { events.push(e); };
    eventBus.on("escalation:created", onCreated);
    try {
      const { manager, spawnMock } = buildManager(db, { escalationManager });
      expect(await manager.runIdlePokes()).toBe(1);
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      eventBus.off("escalation:created", onCreated);
    }

    const rows = db
      .prepare("SELECT id, agent_id, runtime_agent_id, type, question FROM escalations WHERE task_id = ?")
      .all(taskId) as Array<{ id: string; agent_id: string; runtime_agent_id: string | null; type: string; question: string }>;
    expect(rows.length).toBe(1);
    // Raised on the team's entrypoint template, with no runtime instance.
    expect(rows[0]!.agent_id).toBe(agentId);
    expect(rows[0]!.runtime_agent_id).toBeNull();
    expect(events).toEqual([{
      escalationId: rows[0]!.id,
      agentId,
      taskId,
      type: "idle_poke_exhausted",
      question: rows[0]!.question,
    }]);
    expect(rows[0]!.question).toContain("pinged twice");
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

  it("skips when a running child agent_instance exists", async () => {
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
