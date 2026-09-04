import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { registerDaemonTools, type DaemonDeps } from "../mcp/tools";
import { GlobalStoreManager } from "../global-store/manager";
import { setStringSetting } from "../config/app-settings";
import { SETTING_SLACK_BOT_TOKEN } from "../config/slack-settings";
import { createLocalTeam } from "../teams/local-teams";
import { allMcpToolNames, MCP_TOOL_GROUPS } from "./mcp-catalogue";
import { flattenToolResult } from "./mcp-tools";

const TEST_DB = "test-custom-agent-catalogue.db";

let db: Database;
let origArgv: string[];

/** Records tool names the way `mcp/tools-registration.test.ts` does. */
function registeredNames(isDelegated: boolean, taskId?: string): string[] {
  const names: string[] = [];
  const server = { tool: (name: string, ..._rest: unknown[]): void => { names.push(name); } };
  const deps: DaemonDeps = {
    db,
    agentManager: {} as DaemonDeps["agentManager"],
    delegationManager: {} as DaemonDeps["delegationManager"],
    phaseManager: {} as DaemonDeps["phaseManager"],
    taskScheduler: {} as DaemonDeps["taskScheduler"],
    escalationManager: {} as DaemonDeps["escalationManager"],
    artifactManager: {} as DaemonDeps["artifactManager"],
    globalStoreManager: new GlobalStoreManager(db),
  };
  // The Slack gate reads the task from the session identity, not from options.
  const identity = taskId
    ? { type: "internal" as const, runtimeId: "rt-1", templateAgentId: "skipper", taskId }
    : null;
  registerDaemonTools(server as never, deps, () => identity, { isDelegated, taskId });
  return names;
}

beforeEach(() => {
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  origArgv = process.argv;
  process.argv = [...origArgv, "--experimental"];
});

afterEach(() => {
  process.argv = origArgv;
  db.close();
  // WAL mode leaves -wal/-shm sidecars; a stale pair next to a fresh db file
  // causes intermittent "disk I/O error" on the next open.
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try { require("fs").unlinkSync(f); } catch { }
  }
});

describe("MCP tool catalogue", () => {
  // The catalogue is what the config page renders. A name that no longer exists
  // would show a checkbox that silently grants nothing.
  it("names only tools the daemon actually registers", () => {
    setStringSetting(db, SETTING_SLACK_BOT_TOKEN, "xoxb-test");
    const team = createLocalTeam(db, {
      name: "T", skipper_prompt: "", hooks: [], phases: [{ name: "build", prompt: "" }], agents: [],
      config: { slackEnabled: true },
    });
    db.prepare("INSERT INTO tasks (id, title, team_id, status, started_at) VALUES ('t1','T',?,'active',datetime('now'))").run(team.id);

    const real = new Set(registeredNames(false, "t1"));
    const missing = allMcpToolNames().filter((name) => !real.has(name));
    expect(missing).toEqual([]);
  });

  it("flags exactly the tools a delegated session does not get", () => {
    const rootTools = new Set(registeredNames(false));
    const delegatedTools = new Set(registeredNames(true));

    for (const group of MCP_TOOL_GROUPS) {
      for (const spec of group.tools) {
        if (!rootTools.has(spec.name)) continue; // Slack needs config; covered above
        const delegatedGetsIt = delegatedTools.has(spec.name);
        expect({ name: spec.name, rootOnly: !!spec.rootOnly })
          .toEqual({ name: spec.name, rootOnly: !delegatedGetsIt });
      }
    }
  });

  it("has no duplicate names across groups", () => {
    const names = allMcpToolNames();
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("flattenToolResult", () => {
  it("joins text content blocks", () => {
    expect(flattenToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }))
      .toBe("a\nb");
  });

  it("falls back to JSON for a non-content result", () => {
    expect(flattenToolResult({ ok: true })).toBe('{"ok":true}');
  });
});
