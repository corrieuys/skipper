import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { registerDaemonTools, registerExternalTools, type DaemonDeps } from "./tools";
import { hashApiKey, resolveAgentFromToken } from "./auth";
import { GlobalStoreManager } from "../global-store/manager";

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

  it("registers global-store tools (experimental) for both root and delegated sessions", () => {
    const gsTools = ["set_global_value", "get_global_value", "query_global_store", "delete_global_value"];
    process.argv.push("--experimental");
    try {
      const root = makeFakeMcpServer();
      registerDaemonTools(root.server as any, makeDeps(), () => null);
      const child = makeFakeMcpServer();
      registerDaemonTools(child.server as any, makeDeps(), () => null, { isDelegated: true });
      for (const tool of gsTools) {
        expect(root.registeredNames).toContain(tool);
        expect(child.registeredNames).toContain(tool);
      }
    } finally {
      const i = process.argv.indexOf("--experimental");
      if (i !== -1) process.argv.splice(i, 1);
    }
  });

  it("omits global-store tools when not experimental", () => {
    const { server, registeredNames } = makeFakeMcpServer();
    registerDaemonTools(server as any, makeDeps(), () => null);
    expect(registeredNames).not.toContain("set_global_value");
  });

  it("explicit isDelegated:false behaves identically to default", () => {
    const a = makeFakeMcpServer();
    const b = makeFakeMcpServer();
    registerDaemonTools(a.server as any, makeDeps(), () => null);
    registerDaemonTools(b.server as any, makeDeps(), () => null, { isDelegated: false });

    expect(a.registeredNames).toEqual(b.registeredNames);
  });
});

const EXTERNAL_TOOLS = ["create_task", "list_tasks", "approve_task", "list_teams", "list_templates"];

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
});
