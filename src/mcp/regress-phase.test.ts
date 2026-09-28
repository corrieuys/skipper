import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { initializeDatabase } from "../db/connection";
import { clearAgentTypeCache } from "../agents/types";
import { eventBus, type AgentSignalEvent } from "../events/bus";
import { GlobalStoreManager } from "../global-store/manager";
import { PhaseManager } from "../orchestrator/phase-manager";
import { TaskScheduler } from "../tasks/scheduler";
import { registerDaemonTools, type DaemonDeps } from "./tools";
import type { AgentIdentity } from "./auth";

// The regress_phase MCP tool must answer with what handlePhaseRegression
// actually did. It used to fire and forget and always answer "regressed", so a
// refused regression read as a success to the agent.

const TEST_DB = "test-mcp-regress-phase.db";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

let db: Database;
let handlers: Map<string, ToolHandler>;
let signals: AgentSignalEvent[];
let respawned: boolean;

const onSignal = (event: AgentSignalEvent): void => {
  signals.push(event);
};

function makeFakeServer() {
  handlers = new Map();
  return {
    tool: (name: string, ...rest: unknown[]) => {
      handlers.set(name, rest[rest.length - 1] as ToolHandler);
    },
    registerPrompt: () => {},
  };
}

async function regress(target: number, reason: string): Promise<Record<string, unknown>> {
  const result = await handlers.get("regress_phase")!({ target, reason });
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function taskRow(): { current_phase: number; regression_count: number } {
  return db
    .prepare("SELECT current_phase, regression_count FROM tasks WHERE id = 'task-1'")
    .get() as { current_phase: number; regression_count: number };
}

function phaseRegressionSignals(): AgentSignalEvent[] {
  return signals.filter((s) => s.signalType === "phase_regression");
}

beforeEach(() => {
  clearAgentTypeCache();
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  db.prepare("INSERT INTO agents (id, name, type, config, capabilities) VALUES ('lead', 'Lead', 'claude-code', '{}', '[]')").run();
  db.prepare("INSERT INTO teams (id, name) VALUES ('team-1', 'Team')").run();
  // The root agent is on phase 3 of 3 (0-indexed 2).
  db.prepare("INSERT INTO tasks (id, title, team_id, status, current_phase) VALUES ('task-1', 'T', 'team-1', 'active', 2)").run();
  db.prepare("INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES ('rt-root', 'task-1', 'lead', 'running')").run();

  respawned = false;
  const phases = [
    { name: "Plan", prompt: "p1" },
    { name: "Build", prompt: "p2" },
    { name: "Test", prompt: "p3" },
  ];
  const agentManager = {
    getAgent: (id: string) => ({ id, name: "Lead", type: "claude-code", config: {} }),
    getEffectiveRootTypeDef: () => null,
    getEntrypointSessionIdForTask: () => null,
    getRunningInstanceForTask: () => undefined,
    getRootSpawnOverrides: () => ({}),
    // Finishes on a later tick, so a response sent before the regression
    // settles still sees respawned === false.
    spawnAgentInstance: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      respawned = true;
    },
    sendInput: () => {},
  };
  const phaseManager = new PhaseManager(
    db,
    agentManager as unknown as ConstructorParameters<typeof PhaseManager>[1],
    { buildInitialPromptTracked: () => ({ prompt: "p", noteIds: [] }), recordNoteDelivery: () => {} } as unknown as ConstructorParameters<typeof PhaseManager>[2],
    new TaskScheduler(db),
    { getTeamForExecution: () => ({ team: { phases }, entrypoint_agent_id: "lead" }) } as unknown as ConstructorParameters<typeof PhaseManager>[4],
    () => {},
    () => {},
  );

  const deps: DaemonDeps = {
    db,
    agentManager: {} as DaemonDeps["agentManager"],
    delegationManager: {} as DaemonDeps["delegationManager"],
    phaseManager,
    taskScheduler: {} as DaemonDeps["taskScheduler"],
    escalationManager: {} as DaemonDeps["escalationManager"],
    artifactManager: {} as DaemonDeps["artifactManager"],
    globalStoreManager: new GlobalStoreManager(db),
  };
  const identity: AgentIdentity = { type: "internal", runtimeId: "rt-root", templateAgentId: "lead", taskId: "task-1" };
  registerDaemonTools(makeFakeServer() as never, deps, () => identity);

  signals = [];
  eventBus.on("agent:signal", onSignal);
});

afterEach(() => {
  eventBus.off("agent:signal", onSignal);
  db.close();
  try { unlinkSync(TEST_DB); } catch {}
});

describe("regress_phase MCP tool", () => {
  it("reports a regression denied at the regression limit, not 'regressed'", async () => {
    db.prepare("UPDATE tasks SET regression_count = 20 WHERE id = 'task-1'").run();

    const payload = await regress(1, "Tests still fail");

    expect(payload.status).toBe("denied_max_regressions");
    expect(taskRow()).toEqual({ current_phase: 2, regression_count: 20 });
    // Nothing moved, so no phase_regression signal and no respawn.
    expect(phaseRegressionSignals()).toHaveLength(0);
    expect(respawned).toBe(false);
  });

  it("reports a target that is not an earlier phase as refused, not 'regressed'", async () => {
    const payload = await regress(3, "Redo the current phase");

    expect(payload.status).toBe("noop_invalid_target");
    expect(taskRow()).toEqual({ current_phase: 2, regression_count: 0 });
    expect(phaseRegressionSignals()).toHaveLength(0);
  });

  it("answers 'regressed' with the target phase only after the regression and respawn finished", async () => {
    const payload = await regress(1, "Plan missed a requirement");

    expect(payload).toEqual({ status: "regressed", target_phase: 1 });
    expect(taskRow()).toEqual({ current_phase: 0, regression_count: 1 });
    expect(respawned).toBe(true);
    const emitted = phaseRegressionSignals();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ agentId: "rt-root", taskId: "task-1" });
  });
});
