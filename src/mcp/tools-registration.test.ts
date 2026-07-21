import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { registerDaemonTools, registerExternalTools, type DaemonDeps } from "./tools";
import { hashApiKey, resolveAgentFromToken, type InternalAgentIdentity } from "./auth";
import { GlobalStoreManager } from "../global-store/manager";
import { createLocalTeam } from "../teams/local-teams";
import { setStringSetting } from "../config/app-settings";
import { SETTING_SLACK_BOT_TOKEN } from "../config/slack-settings";

let db: Database;
const TEST_DB = "test-mcp-tools-registration.db";

function makeFakeMcpServer(): { registeredNames: string[]; server: { tool: (name: string, ...rest: unknown[]) => void } } {
  const registeredNames: string[] = [];
  const server = {
    tool: (name: string, ..._rest: unknown[]): void => {
      registeredNames.push(name);
    },
  };
  return { registeredNames, server };
}

function makeDeps(): DaemonDeps {
  // Minimal stubs — none of these are touched at registration time; only at
  // tool-invocation time, which this test does not exercise.
  return {
    db,
    agentManager: {} as DaemonDeps["agentManager"],
    delegationManager: {} as DaemonDeps["delegationManager"],
    phaseManager: {} as DaemonDeps["phaseManager"],
    taskScheduler: {} as DaemonDeps["taskScheduler"],
    escalationManager: {} as DaemonDeps["escalationManager"],
    artifactManager: {} as DaemonDeps["artifactManager"],
    consensusManager: {} as DaemonDeps["consensusManager"],
    globalStoreManager: new GlobalStoreManager(db),
  };
}

const PHASE_TOOLS = ["complete_phase", "regress_phase", "complete_task"];

describe("registerDaemonTools — role-based registration", () => {
  beforeEach(() => {
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);
  });

  afterEach(() => {
    db.close();
    try { require("fs").unlinkSync(TEST_DB); } catch {}
  });

  it("root session (default / isDelegated:false) registers phase-control tools", () => {
    const { server, registeredNames } = makeFakeMcpServer();
    registerDaemonTools(server as any, makeDeps(), () => null);

    for (const tool of PHASE_TOOLS) {
      expect(registeredNames).toContain(tool);
    }
    // Sanity: at least one non-phase tool is registered too
    expect(registeredNames).toContain("create_note");
    expect(registeredNames).toContain("delegate");
  });

  it("delegated child session (isDelegated:true) omits phase-control tools", () => {
    const { server, registeredNames } = makeFakeMcpServer();
    registerDaemonTools(server as any, makeDeps(), () => null, { isDelegated: true });

    for (const tool of PHASE_TOOLS) {
      expect(registeredNames).not.toContain(tool);
    }
    // Non-phase tools are still available to children
    expect(registeredNames).toContain("create_note");
    expect(registeredNames).toContain("delegate");
    expect(registeredNames).toContain("escalate");
    expect(registeredNames).toContain("create_artifact");
  });

  it("registers global-store tools for both root and delegated sessions (no experimental flag needed)", () => {
    const gsTools = ["set_global_value", "get_global_value", "query_global_store", "delete_global_value"];
    const root = makeFakeMcpServer();
    registerDaemonTools(root.server as any, makeDeps(), () => null);
    const child = makeFakeMcpServer();
    registerDaemonTools(child.server as any, makeDeps(), () => null, { isDelegated: true });
    for (const tool of gsTools) {
      expect(root.registeredNames).toContain(tool);
      expect(child.registeredNames).toContain(tool);
    }
  });

  it("explicit isDelegated:false behaves identically to default", () => {
    const a = makeFakeMcpServer();
    const b = makeFakeMcpServer();
    registerDaemonTools(a.server as any, makeDeps(), () => null);
    registerDaemonTools(b.server as any, makeDeps(), () => null, { isDelegated: false });

    expect(a.registeredNames).toEqual(b.registeredNames);
  });
});

const SLACK_TOOLS = ["slack_send_message", "slack_send_dm", "slack_read_channel"];

describe("registerDaemonTools — Slack tools (experimental + configured + team gated)", () => {
  beforeEach(() => {
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);
    process.argv.push("--experimental");
  });

  afterEach(() => {
    const i = process.argv.indexOf("--experimental");
    if (i !== -1) process.argv.splice(i, 1);
    db.close();
    try { require("fs").unlinkSync(TEST_DB); } catch {}
  });

  // Create a team (optionally Slack-enabled) + a task on it, and an internal
  // identity pointing at that task — the shape server.ts passes at session create.
  function setupTeamTask(slackEnabled: boolean): InternalAgentIdentity {
    const team = createLocalTeam(db, {
      name: "T",
      phases: [{ name: "build", prompt: "", review: false }],
      config: { slackEnabled },
    });
    db.prepare("INSERT INTO tasks (id, title, team_id) VALUES (?, ?, ?)").run("task-1", "T1", team.id);
    return { type: "internal", runtimeId: "rt-1", templateAgentId: "skipper", taskId: "task-1" };
  }

  it("registers Slack tools when configured + team enabled", () => {
    setStringSetting(db, SETTING_SLACK_BOT_TOKEN, "xoxb-abc");
    const identity = setupTeamTask(true);
    const { server, registeredNames } = makeFakeMcpServer();
    registerDaemonTools(server as any, makeDeps(), () => identity);
    for (const tool of SLACK_TOOLS) expect(registeredNames).toContain(tool);
  });

  it("omits Slack tools when the team has not opted in", () => {
    setStringSetting(db, SETTING_SLACK_BOT_TOKEN, "xoxb-abc");
    const identity = setupTeamTask(false);
    const { server, registeredNames } = makeFakeMcpServer();
    registerDaemonTools(server as any, makeDeps(), () => identity);
    for (const tool of SLACK_TOOLS) expect(registeredNames).not.toContain(tool);
  });

  it("omits Slack tools when no bot token is configured, even if the team opted in", () => {
    const identity = setupTeamTask(true);
    const { server, registeredNames } = makeFakeMcpServer();
    registerDaemonTools(server as any, makeDeps(), () => identity);
    for (const tool of SLACK_TOOLS) expect(registeredNames).not.toContain(tool);
  });
});

const EXTERNAL_TOOLS = ["create_task", "list_tasks", "approve_task", "list_teams"];

describe("registerExternalTools — external agent registration", () => {
  beforeEach(() => {
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);
  });

  afterEach(() => {
    db.close();
    try { require("fs").unlinkSync(TEST_DB); } catch {}
  });

  it("registers exactly the external tool set", () => {
    const { server, registeredNames } = makeFakeMcpServer();
    registerExternalTools(server as any, makeDeps(), () => null);

    for (const tool of EXTERNAL_TOOLS) {
      expect(registeredNames).toContain(tool);
    }
    expect(registeredNames).toHaveLength(EXTERNAL_TOOLS.length);
  });

  it("does not register internal tools", () => {
    const { server, registeredNames } = makeFakeMcpServer();
    registerExternalTools(server as any, makeDeps(), () => null);

    expect(registeredNames).not.toContain("delegate");
    expect(registeredNames).not.toContain("create_note");
    expect(registeredNames).not.toContain("complete_phase");
    expect(registeredNames).not.toContain("escalate");
  });
});

describe("resolveAgentFromToken — API key auth", () => {
  beforeEach(() => {
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);
  });

  afterEach(() => {
    db.close();
    try { require("fs").unlinkSync(TEST_DB); } catch {}
  });

  it("resolves an API key to an external identity", () => {
    const plainKey = "sk-test-key-for-external-agents";
    const keyHash = hashApiKey(plainKey);
    db.prepare("INSERT INTO api_keys (id, name, key_hash) VALUES (?, ?, ?)")
      .run("key-1", "test-key", keyHash);

    const identity = resolveAgentFromToken(db, plainKey);
    expect(identity).not.toBeNull();
    expect(identity!.type).toBe("external");
    if (identity!.type === "external") {
      expect(identity!.apiKeyId).toBe("key-1");
      expect(identity!.apiKeyName).toBe("test-key");
    }
  });

  it("returns null for unknown tokens", () => {
    const identity = resolveAgentFromToken(db, "unknown-token-value");
    expect(identity).toBeNull();
  });

  it("returns null for short tokens", () => {
    const identity = resolveAgentFromToken(db, "short");
    expect(identity).toBeNull();
  });

  function seedInstance(instanceId: string, instanceStatus: string, taskStatus: string): void {
    db.prepare("INSERT OR IGNORE INTO agents (id, name, type) VALUES (?, ?, ?)").run("tmpl-1", "Tmpl", "claude-code");
    db.prepare("INSERT OR IGNORE INTO tasks (id, title, status) VALUES (?, ?, ?)").run("task-x", "t", taskStatus);
    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES (?, ?, ?, ?)",
    ).run(instanceId, "task-x", "tmpl-1", instanceStatus);
  }

  it("resolves a live-task instance even when its status was raced off 'running'", () => {
    // The core fix: instance status flipped to 'completed' by an exit handler mid-run,
    // but the task is still running, so the token must remain valid.
    seedInstance("inst-raced", "completed", "running");
    const identity = resolveAgentFromToken(db, "inst-raced");
    expect(identity).not.toBeNull();
    expect(identity!.type).toBe("internal");
    if (identity!.type === "internal") {
      expect(identity!.runtimeId).toBe("inst-raced");
      expect(identity!.taskId).toBe("task-x");
    }
  });

  it("still resolves a running instance whose task is not running (task-less/preserve old path)", () => {
    seedInstance("inst-running", "running", "completed");
    const identity = resolveAgentFromToken(db, "inst-running");
    expect(identity).not.toBeNull();
    expect(identity!.type).toBe("internal");
  });

  it("rejects a finished instance on a finished task", () => {
    seedInstance("inst-done", "completed", "completed");
    expect(resolveAgentFromToken(db, "inst-done")).toBeNull();
  });
});
