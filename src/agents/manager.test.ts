import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { AgentManager } from "./manager";
import type { RunningAgent } from "./manager";
import { clearAgentTypeCache } from "./types";
import { eventBus } from "../events/bus";
import type { AgentOutputEvent, AgentExitEvent } from "../events/bus";
import { unlinkSync } from "fs";

const TEST_DB = "test-agent-manager.db";

let db: Database;
let manager: AgentManager;

beforeEach(() => {
  clearAgentTypeCache();
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  manager = new AgentManager(db);
});

afterEach(() => {
  // Kill any running agents
  for (const [id] of manager.getRunningAgents()) {
    manager.killAgent(id);
  }
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

// Helper: register a test agent type that uses a simple shell script
function registerTestAgentType(dbRef: Database) {
  dbRef
    .prepare(
      `INSERT OR REPLACE INTO agent_types (name, command, args, model_flag, available_models, env_vars, supports_stdin, supports_resume, resume_flag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "test-echo",
      "bash",
      JSON.stringify(["-c"]),
      null,
      JSON.stringify([]),
      JSON.stringify({}),
      1,
      0,
      null,
    );
}

// Helper: create a test agent with the test-echo type
function createTestEchoAgent(script: string): { agentId: string; script: string } {
  registerTestAgentType(db);
  // Override the args to include the script inline
  db.prepare("UPDATE agent_types SET args = ? WHERE name = 'test-echo'").run(
    JSON.stringify(["-c", script]),
  );
  const agent = manager.createAgent({ name: "Test Echo", type: "test-echo" });
  return { agentId: agent.id, script };
}

describe("createAgent", () => {
  it("creates an agent with required fields", () => {
    const agent = manager.createAgent({
      name: "Test Agent",
      type: "claude-code",
    });
    expect(agent.id).toBeTruthy();
    expect(agent.name).toBe("Test Agent");
    expect(agent.type).toBe("claude-code");
    expect(agent.model).toBe("default");
    expect(agent.status).toBe("idle");
    expect(agent.capabilities).toEqual([]);
  });

  it("creates an agent with all optional fields", () => {
    const agent = manager.createAgent({
      name: "Full Agent",
      type: "claude-code",
      model: "opus",
      capabilities: ["coding", "architecture"],
      goal: "Lead developer",
    });
    expect(agent.model).toBe("opus");
    expect(agent.capabilities).toEqual(["coding", "architecture"]);
    expect(agent.config.goal).toBe("Lead developer");
  });

  it("throws for unknown agent type", () => {
    expect(() =>
      manager.createAgent({ name: "Bad Agent", type: "nonexistent" }),
    ).toThrow("Unknown agent type: nonexistent");
  });
});

describe("getAgent", () => {
  it("returns an agent by id", () => {
    const created = manager.createAgent({
      name: "Agent A",
      type: "claude-code",
    });
    const fetched = manager.getAgent(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.name).toBe("Agent A");
  });

  it("returns null for nonexistent id", () => {
    const result = manager.getAgent("nonexistent");
    expect(result).toBeNull();
  });
});

describe("listAgents", () => {
  it("returns empty array when no agents exist", () => {
    expect(manager.listAgents()).toEqual([]);
  });

  it("returns all created agents", () => {
    manager.createAgent({ name: "Agent 1", type: "claude-code" });
    manager.createAgent({ name: "Agent 2", type: "codex" });
    const agents = manager.listAgents();
    expect(agents).toHaveLength(2);
  });
});

describe("deleteAgent", () => {
  it("deletes an existing agent", () => {
    const agent = manager.createAgent({
      name: "To Delete",
      type: "claude-code",
    });
    const result = manager.deleteAgent(agent.id);
    expect(result).toBe(true);
    expect(manager.getAgent(agent.id)).toBeNull();
  });

  it("returns false for nonexistent agent", () => {
    expect(manager.deleteAgent("nonexistent")).toBe(false);
  });

  it("throws when deleting a busy agent", () => {
    const agent = manager.createAgent({
      name: "Busy Agent",
      type: "claude-code",
    });
    db.prepare("UPDATE agents SET status = 'busy' WHERE id = ?").run(agent.id);
    expect(() => manager.deleteAgent(agent.id)).toThrow(
      "Cannot delete a busy agent",
    );
  });

  it("cleans up team memberships on delete", () => {
    const agent = manager.createAgent({
      name: "Team Member",
      type: "claude-code",
    });
    db.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run("t1", "Team");
    db.prepare(
      "INSERT INTO team_agents (id, team_id, agent_id) VALUES (?, ?, ?)",
    ).run("ta1", "t1", agent.id);

    manager.deleteAgent(agent.id);

    const membership = db
      .prepare("SELECT * FROM team_agents WHERE agent_id = ?")
      .get(agent.id);
    expect(membership).toBeNull();
  });

  it("clears entrypoint reference on delete", () => {
    const agent = manager.createAgent({
      name: "Entrypoint",
      type: "claude-code",
    });
    db.prepare("INSERT INTO teams (id, name, entrypoint_agent_id) VALUES (?, ?, ?)").run(
      "t1",
      "Team",
      agent.id,
    );
    db.prepare(
      "INSERT INTO team_agents (id, team_id, agent_id) VALUES (?, ?, ?)",
    ).run("ta1", "t1", agent.id);

    manager.deleteAgent(agent.id);

    const team = db.prepare("SELECT * FROM teams WHERE id = ?").get("t1") as Record<string, unknown>;
    expect(team.entrypoint_agent_id).toBeNull();
  });
});

describe("spawnAgent", () => {
  it("throws for nonexistent agent", async () => {
    await expect(
      manager.spawnAgent("nonexistent", { workingDir: "/tmp" }),
    ).rejects.toThrow("Agent not found: nonexistent");
  });

  it("spawns a process and tracks it in memory", async () => {
    const { agentId } = createTestEchoAgent("sleep 0.2");
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });

    expect(running.id).toBe(agentId);
    expect(running.process.pid).toBeGreaterThan(0);
    expect(running.sessionId).toBeNull();
    expect(manager.getRunningAgent(agentId)).toBe(running);

    // DB should show busy with PID
    const agent = manager.getAgent(agentId);
    expect(agent!.status).toBe("busy");
    expect(agent!.process_pid).toBe(running.process.pid);

    await running.process.exited;
    await new Promise((r) => setTimeout(r, 50));
  });

  it("clears old terminal outputs on spawn", async () => {
    const { agentId } = createTestEchoAgent('echo "test"');

    // Insert some old terminal output
    db.prepare(
      "INSERT INTO terminal_outputs (agent_id, stream, data, sequence) VALUES (?, ?, ?, ?)",
    ).run(agentId, "stdout", "old data", 1);

    const oldRows = db
      .prepare("SELECT COUNT(*) as cnt FROM terminal_outputs WHERE agent_id = ?")
      .get(agentId) as { cnt: number };
    expect(oldRows.cnt).toBe(1);

    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });
    await running.process.exited;

    // Old rows should be gone (new rows may exist from the echo output)
    const rows = db
      .prepare("SELECT * FROM terminal_outputs WHERE agent_id = ? AND data = 'old data'")
      .all(agentId);
    expect(rows).toHaveLength(0);
  });

  it("captures stdout in terminal_outputs and emits events", async () => {
    const { agentId } = createTestEchoAgent('echo "line1" && echo "line2"');
    const events: AgentOutputEvent[] = [];
    const handler = (e: AgentOutputEvent) => {
      if (e.agentId === agentId) events.push(e);
    };
    eventBus.on("agent:output", handler);

    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });
    await running.process.exited;
    // Small delay for stream reading to complete
    await new Promise((r) => setTimeout(r, 100));

    eventBus.off("agent:output", handler);

    // Should have captured output
    const rows = db
      .prepare(
        "SELECT * FROM terminal_outputs WHERE agent_id = ? AND stream = 'stdout' ORDER BY sequence",
      )
      .all(agentId) as { data: string; sequence: number }[];
    expect(rows.length).toBeGreaterThan(0);

    const allData = rows.map((r) => r.data).join("");
    expect(allData).toContain("line1");
    expect(allData).toContain("line2");

    // Events should have been emitted
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].stream).toBe("stdout");
  });

  it("captures stderr in terminal_outputs", async () => {
    const { agentId } = createTestEchoAgent('echo "error output" >&2');
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });
    await running.process.exited;
    await new Promise((r) => setTimeout(r, 100));

    const rows = db
      .prepare(
        "SELECT * FROM terminal_outputs WHERE agent_id = ? AND stream = 'stderr' ORDER BY sequence",
      )
      .all(agentId) as { data: string }[];
    expect(rows.length).toBeGreaterThan(0);
    const allData = rows.map((r) => r.data).join("");
    expect(allData).toContain("error output");
  });

  it("sets environment variables correctly", async () => {
    const { agentId } = createTestEchoAgent(
      'echo "AGENT_ID=$AGENT_ID AGENT_NAME=$AGENT_NAME AGENT_TYPE=$AGENT_TYPE"',
    );
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });
    await running.process.exited;
    await new Promise((r) => setTimeout(r, 100));

    const rows = db
      .prepare(
        "SELECT * FROM terminal_outputs WHERE agent_id = ? AND stream = 'stdout'",
      )
      .all(agentId) as { data: string }[];
    const allData = rows.map((r) => r.data).join("");
    expect(allData).toContain(`AGENT_ID=${agentId}`);
    expect(allData).toContain("AGENT_NAME=Test Echo");
    expect(allData).toContain("AGENT_TYPE=test-echo");
  });

  it("emits exit event and updates DB on process exit with code 0", async () => {
    const { agentId } = createTestEchoAgent('echo "done"');
    const exitEvents: AgentExitEvent[] = [];
    const handler = (e: AgentExitEvent) => {
      if (e.agentId === agentId) exitEvents.push(e);
    };
    eventBus.on("agent:exit", handler);

    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });
    await running.process.exited;
    // Wait for exit handler to fire
    await new Promise((r) => setTimeout(r, 100));

    eventBus.off("agent:exit", handler);

    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0].code).toBe(0);
    expect(exitEvents[0].isRespawn).toBe(false);

    // Agent should be removed from running map
    expect(manager.getRunningAgent(agentId)).toBeUndefined();

    // DB should show idle with null PID
    const agent = manager.getAgent(agentId);
    expect(agent!.status).toBe("idle");
    expect(agent!.process_pid).toBeNull();
  });

  it("sets error status on non-zero exit", async () => {
    const { agentId } = createTestEchoAgent("exit 1");
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });
    await running.process.exited;
    await new Promise((r) => setTimeout(r, 100));

    const agent = manager.getAgent(agentId);
    expect(agent!.status).toBe("error");
  });

  it("uses working directory for spawned process", async () => {
    // Use a real, resolved path (avoids macOS /var -> /private/var symlink issues)
    const workDir = import.meta.dir;

    const { agentId } = createTestEchoAgent("pwd");
    const running = await manager.spawnAgent(agentId, { workingDir: workDir });
    await running.process.exited;
    await new Promise((r) => setTimeout(r, 100));

    const rows = db
      .prepare(
        "SELECT * FROM terminal_outputs WHERE agent_id = ? AND stream = 'stdout'",
      )
      .all(agentId) as { data: string }[];
    const allData = rows.map((r) => r.data).join("").trim();
    expect(allData).toBe(workDir);
  });
});

describe("processStdoutBuffer", () => {
  it("extracts complete lines from buffer", () => {
    const running: RunningAgent = {
      id: "test",
      process: null as any,
      stdin: null as any,
      stdoutBuffer: "line1\nline2\nincomplete",
      stderrBuffer: "",
      outputSequence: 0,
      sessionId: null,
    };

    const lines = manager.processStdoutBuffer(running);
    expect(lines).toEqual(["line1", "line2"]);
    expect(running.stdoutBuffer).toBe("incomplete");
  });

  it("returns empty array when no complete lines", () => {
    const running: RunningAgent = {
      id: "test",
      process: null as any,
      stdin: null as any,
      stdoutBuffer: "no newline here",
      stderrBuffer: "",
      outputSequence: 0,
      sessionId: null,
    };

    const lines = manager.processStdoutBuffer(running);
    expect(lines).toEqual([]);
    expect(running.stdoutBuffer).toBe("no newline here");
  });

  it("handles empty buffer", () => {
    const running: RunningAgent = {
      id: "test",
      process: null as any,
      stdin: null as any,
      stdoutBuffer: "",
      stderrBuffer: "",
      outputSequence: 0,
      sessionId: null,
    };

    const lines = manager.processStdoutBuffer(running);
    expect(lines).toEqual([]);
  });

  it("handles buffer ending with newline", () => {
    const running: RunningAgent = {
      id: "test",
      process: null as any,
      stdin: null as any,
      stdoutBuffer: "line1\nline2\n",
      stderrBuffer: "",
      outputSequence: 0,
      sessionId: null,
    };

    const lines = manager.processStdoutBuffer(running);
    expect(lines).toEqual(["line1", "line2"]);
    expect(running.stdoutBuffer).toBe("");
  });
});

describe("sendInput", () => {
  it("throws for nonexistent running agent", () => {
    expect(() => manager.sendInput("nonexistent", "hello")).toThrow(
      "No running agent found: nonexistent",
    );
  });

  it("sends input to a running process stdin", async () => {
    // Use a script that reads stdin and echoes it
    const { agentId } = createTestEchoAgent('read line && echo "GOT:$line"');
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });

    // Small delay to let the process start
    await new Promise((r) => setTimeout(r, 50));

    // Send input (close stdin so the read completes and process exits)
    manager.sendInput(agentId, "hello-world", true);

    await running.process.exited;
    // Wait for stream reading to finish
    await new Promise((r) => setTimeout(r, 200));

    const rows = db
      .prepare(
        "SELECT * FROM terminal_outputs WHERE agent_id = ? AND stream = 'stdout'",
      )
      .all(agentId) as { data: string }[];
    const allData = rows.map((r) => r.data).join("");
    expect(allData).toContain("GOT:hello-world");
  });
});

describe("killAgent", () => {
  it("returns false for nonexistent running agent", () => {
    expect(manager.killAgent("nonexistent")).toBe(false);
  });

  it("kills a running process", async () => {
    const { agentId } = createTestEchoAgent("sleep 30");
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });

    expect(manager.killAgent(agentId)).toBe(true);

    const exitCode = await running.process.exited;
    // Process should have been killed (non-zero exit)
    expect(exitCode).not.toBe(0);
  });
});

describe("getRunningAgents", () => {
  it("returns empty map initially", () => {
    expect(manager.getRunningAgents().size).toBe(0);
  });

  it("tracks spawned agents", async () => {
    const { agentId } = createTestEchoAgent("sleep 0.5");
    await manager.spawnAgent(agentId, { workingDir: "/tmp" });

    expect(manager.getRunningAgents().size).toBe(1);
    expect(manager.getRunningAgents().has(agentId)).toBe(true);

    manager.killAgent(agentId);
  });
});
