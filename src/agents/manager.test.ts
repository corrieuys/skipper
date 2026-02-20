import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { AgentManager, extractTextFromJsonEvent, detectSignalsInText } from "./manager";
import type { RunningAgent, JsonEvent } from "./manager";
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
  // Kill any running agents (only those with real processes)
  for (const [id, agent] of manager.getRunningAgents()) {
    if (agent.process) {
      try { manager.killAgent(id); } catch {}
    }
  }
  // Clear the map to prevent stale entries from test mocks
  manager.getRunningAgents().clear();
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
      instruction: "Lead developer",
    });
    expect(agent.model).toBe("opus");
    expect(agent.capabilities).toEqual(["coding", "architecture"]);
    expect(agent.config.instruction).toBe("Lead developer");
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

  it("preserves old terminal outputs and creates new session on spawn", async () => {
    const { agentId } = createTestEchoAgent('echo "test"');

    // Insert some old terminal output (without session_id, simulating legacy data)
    db.prepare(
      "INSERT INTO terminal_outputs (agent_id, stream, data, sequence) VALUES (?, ?, ?, ?)",
    ).run(agentId, "stdout", "old data", 1);

    const oldRows = db
      .prepare("SELECT COUNT(*) as cnt FROM terminal_outputs WHERE agent_id = ?")
      .get(agentId) as { cnt: number };
    expect(oldRows.cnt).toBe(1);

    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });
    await running.process.exited;
    await new Promise((r) => setTimeout(r, 100));

    // Old rows should still be present (no longer deleted)
    const oldDataRows = db
      .prepare("SELECT * FROM terminal_outputs WHERE agent_id = ? AND data = 'old data'")
      .all(agentId);
    expect(oldDataRows).toHaveLength(1);

    // A new session should have been created
    const sessions = db
      .prepare("SELECT * FROM agent_sessions WHERE agent_id = ?")
      .all(agentId) as { id: string }[];
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    // New output should be tagged with the session_id
    const newRows = db
      .prepare("SELECT * FROM terminal_outputs WHERE agent_id = ? AND session_id IS NOT NULL")
      .all(agentId) as { session_id: string }[];
    expect(newRows.length).toBeGreaterThanOrEqual(1);
    expect(newRows[0].session_id).toBe(sessions[0].id);
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

  it("uses explicit resume_args template when sessionId is provided", async () => {
    db.prepare(
      `INSERT OR REPLACE INTO agent_types (
        name, command, args, resume_args, model_flag, available_models, env_vars, supports_stdin, supports_resume, resume_flag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "test-resume-args",
      "bash",
      JSON.stringify(["-lc", "echo base"]),
      JSON.stringify(["-lc", "printf '%s' \"$0\"", "{{session_id}}"]),
      null,
      JSON.stringify([]),
      JSON.stringify({}),
      0,
      1,
      null,
    );

    const agent = manager.createAgent({ name: "Resume Args Agent", type: "test-resume-args" });
    const running = await manager.spawnAgent(agent.id, { workingDir: "/tmp", sessionId: "sess-resume-xyz" });
    await running.process.exited;
    await new Promise((r) => setTimeout(r, 100));

    const rows = db
      .prepare("SELECT data FROM terminal_outputs WHERE agent_id = ? AND stream = 'stdout'")
      .all(agent.id) as { data: string }[];
    const allData = rows.map((r) => r.data).join("");
    expect(allData).toContain("sess-resume-xyz");
    expect(allData).not.toContain("base");
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

// --- Output Parsing Tests ---

describe("parseAgentOutput", () => {
  const agentId = "test-agent-id";

  it("detects JSON lines", () => {
    const result = manager.parseAgentOutput(agentId, '{"type":"system","data":"init"}');
    expect(result.type).toBe("json");
    expect(result.jsonEvent).toBeDefined();
    expect(result.jsonEvent!.type).toBe("system");
  });

  it("detects agent messages", () => {
    const result = manager.parseAgentOutput(agentId, "[MSG:status to:LeadDev] Build complete");
    expect(result.type).toBe("message");
    expect(result.messageType).toBe("status");
    expect(result.targetAgent).toBe("LeadDev");
    expect(result.content).toBe("Build complete");
  });

  it("detects delegation signals", () => {
    const result = manager.parseAgentOutput(agentId, "[DELEGATE to:qa-agent-123] Review the changes");
    expect(result.type).toBe("delegate");
    expect(result.targetAgent).toBe("qa-agent-123");
    expect(result.content).toBe("Review the changes");
  });

  it("detects delegation complete signals", () => {
    const result = manager.parseAgentOutput(agentId, "[DELEGATE_COMPLETE] All tests pass");
    expect(result.type).toBe("delegate_complete");
    expect(result.content).toBe("All tests pass");
  });

  it("detects escalation signals", () => {
    const result = manager.parseAgentOutput(agentId, "[ESCALATE] Need permission to deploy");
    expect(result.type).toBe("escalate");
    expect(result.content).toBe("Need permission to deploy");
  });

  it("detects note signals", () => {
    const result = manager.parseAgentOutput(agentId, "[NOTE] Auth config is in /etc/app.conf");
    expect(result.type).toBe("note");
    expect(result.content).toBe("Auth config is in /etc/app.conf");
  });

  it("detects task complete signals", () => {
    const result = manager.parseAgentOutput(agentId, "[TASK_COMPLETE task:task-123] Done successfully");
    expect(result.type).toBe("task_complete");
    expect(result.taskId).toBe("task-123");
    expect(result.content).toBe("Done successfully");
  });

  it("detects phase complete signals", () => {
    const result = manager.parseAgentOutput(agentId, "[PHASE_COMPLETE]");
    expect(result.type).toBe("phase_complete");
  });

  it("detects phase regression signals", () => {
    const result = manager.parseAgentOutput(agentId, "[PHASE_REGRESSION 1] QA found bugs");
    expect(result.type).toBe("phase_regression");
    expect(result.targetPhase).toBe(1);
    expect(result.reason).toBe("QA found bugs");
  });

  it("returns text type for plain lines", () => {
    const result = manager.parseAgentOutput(agentId, "Just some regular output");
    expect(result.type).toBe("text");
    expect(result.raw).toBe("Just some regular output");
  });

  it("handles invalid JSON gracefully", () => {
    const result = manager.parseAgentOutput(agentId, "{not valid json}");
    expect(result.type).toBe("text");
  });

  it("follows correct parse order - JSON before signals", () => {
    // A JSON line that happens to contain signal-like text
    const json = JSON.stringify({ type: "system", data: "[ESCALATE] embedded" });
    const result = manager.parseAgentOutput(agentId, json);
    expect(result.type).toBe("json");
  });

  it("follows correct parse order - message before delegate", () => {
    // MSG pattern takes priority (checked before DELEGATE)
    const result = manager.parseAgentOutput(agentId, "[MSG:request to:Agent1] [DELEGATE to:x] test");
    expect(result.type).toBe("message");
  });
});

describe("handleJsonOutput", () => {
  it("captures session_id from JSON events", () => {
    const agent = manager.createAgent({ name: "Test", type: "claude-code" });
    // Manually add to running agents map for the test
    const runningAgent: RunningAgent = {
      id: agent.id,
      process: null as any,
      stdin: null as any,
      stdoutBuffer: "",
      stderrBuffer: "",
      outputSequence: 0,
      sessionId: null,
    };
    manager.getRunningAgents().set(agent.id, runningAgent);

    manager.handleJsonOutput(agent.id, { type: "system", session_id: "sess-123" }, "{}");

    expect(runningAgent.sessionId).toBe("sess-123");

    // Session ID should be persisted to DB eagerly (not just on process exit)
    const row = db
      .prepare(
        "SELECT json_extract(state_metadata, '$.session_id') as session_id FROM agent_states WHERE agent_id = ?",
      )
      .get(agent.id) as { session_id: string | null } | null;
    expect(row).not.toBeNull();
    expect(row!.session_id).toBe("sess-123");
  });

  it("captures thread_id from Codex JSON events for resume", () => {
    const agent = manager.createAgent({ name: "Test", type: "codex" });
    const runningAgent: RunningAgent = {
      id: agent.id,
      process: null as any,
      stdin: null as any,
      stdoutBuffer: "",
      stderrBuffer: "",
      outputSequence: 0,
      sessionId: null,
    };
    manager.getRunningAgents().set(agent.id, runningAgent);

    manager.handleJsonOutput(agent.id, { type: "thread.started", thread_id: "thread-abc-123" }, "{}");

    expect(runningAgent.sessionId).toBe("thread-abc-123");
    const row = db
      .prepare(
        "SELECT json_extract(state_metadata, '$.session_id') as session_id FROM agent_states WHERE agent_id = ?",
      )
      .get(agent.id) as { session_id: string | null } | null;
    expect(row).not.toBeNull();
    expect(row!.session_id).toBe("thread-abc-123");
  });

  it("does not overwrite existing session_id", () => {
    const agent = manager.createAgent({ name: "Test", type: "claude-code" });
    const runningAgent: RunningAgent = {
      id: agent.id,
      process: null as any,
      stdin: null as any,
      stdoutBuffer: "",
      stderrBuffer: "",
      outputSequence: 0,
      sessionId: "existing-session",
    };
    manager.getRunningAgents().set(agent.id, runningAgent);

    manager.handleJsonOutput(agent.id, { type: "system", session_id: "new-session" }, "{}");

    expect(runningAgent.sessionId).toBe("existing-session");

    // DB should not be updated since session was already set
    const row = db
      .prepare(
        "SELECT json_extract(state_metadata, '$.session_id') as session_id FROM agent_states WHERE agent_id = ?",
      )
      .get(agent.id) as { session_id: string | null } | null;
    expect(row).toBeNull();
  });

  it("detects embedded signals in Claude Code assistant output", () => {
    const json: JsonEvent = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Done with work.\n[PHASE_COMPLETE]" }],
      },
    };
    const result = manager.handleJsonOutput("agent-1", json, "{}");
    expect(result.type).toBe("phase_complete");
  });

  it("detects embedded delegate signal in Codex output", () => {
    const json: JsonEvent = {
      type: "item.completed",
      item: { type: "agent_message", text: "[DELEGATE to:qa-1] Review code" },
    };
    const result = manager.handleJsonOutput("agent-1", json, "{}");
    expect(result.type).toBe("delegate");
    expect(result.targetAgent).toBe("qa-1");
  });

  it("returns json type for system events", () => {
    const result = manager.handleJsonOutput("agent-1", { type: "system" }, "{}");
    expect(result.type).toBe("json");
  });

  it("returns json type for rate_limit_event", () => {
    const result = manager.handleJsonOutput("agent-1", { type: "rate_limit_event" }, "{}");
    expect(result.type).toBe("json");
  });

  it("extracts content from result events", () => {
    const result = manager.handleJsonOutput("agent-1", { type: "result", result: "Final answer" }, "{}");
    expect(result.type).toBe("json");
    expect(result.content).toBe("Final answer");
  });

  it("extracts error messages", () => {
    const result = manager.handleJsonOutput("agent-1", { type: "error", error: { message: "Rate limited" } }, "{}");
    expect(result.type).toBe("json");
    expect(result.content).toBe("Rate limited");
  });
});

describe("extractTextFromJsonEvent", () => {
  it("extracts text from Claude Code assistant format", () => {
    const json: JsonEvent = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello world" },
          { type: "tool_use" },
          { type: "text", text: "More text" },
        ],
      },
    };
    expect(extractTextFromJsonEvent(json)).toBe("Hello world\nMore text");
  });

  it("extracts text from Codex item format", () => {
    const json: JsonEvent = {
      type: "item.completed",
      item: { type: "agent_message", text: "Codex says hello" },
    };
    expect(extractTextFromJsonEvent(json)).toBe("Codex says hello");
  });

  it("extracts text from Codex item content array", () => {
    const json: JsonEvent = {
      type: "item.completed",
      item: {
        content: [{ type: "text", text: "Item content text" }],
      },
    };
    expect(extractTextFromJsonEvent(json)).toBe("Item content text");
  });

  it("extracts text from result events", () => {
    const json: JsonEvent = { type: "result", result: "The final result" };
    expect(extractTextFromJsonEvent(json)).toBe("The final result");
  });

  it("returns null for events without text", () => {
    const json: JsonEvent = { type: "system" };
    expect(extractTextFromJsonEvent(json)).toBeNull();
  });

  it("returns null for empty content arrays", () => {
    const json: JsonEvent = {
      type: "assistant",
      message: { content: [] },
    };
    expect(extractTextFromJsonEvent(json)).toBeNull();
  });

  it("skips non-text content items", () => {
    const json: JsonEvent = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use" }, { type: "image" }],
      },
    };
    expect(extractTextFromJsonEvent(json)).toBeNull();
  });
});

// --- Session Resume Tests ---

describe("persistSessionId", () => {
  it("persists session ID to agent_states on process exit", async () => {
    const { agentId } = createTestEchoAgent('echo "done"');
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });

    // Manually set session ID (simulating JSON event capture)
    running.sessionId = "sess-abc-123";

    await running.process.exited;
    await new Promise((r) => setTimeout(r, 100));

    // Check agent_states table
    const row = db
      .prepare(
        "SELECT json_extract(state_metadata, '$.session_id') as session_id FROM agent_states WHERE agent_id = ?",
      )
      .get(agentId) as { session_id: string | null } | null;
    expect(row).not.toBeNull();
    expect(row!.session_id).toBe("sess-abc-123");
  });

  it("does not persist when no session ID exists", async () => {
    const { agentId } = createTestEchoAgent('echo "done"');
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });

    // sessionId is null by default
    expect(running.sessionId).toBeNull();

    await running.process.exited;
    await new Promise((r) => setTimeout(r, 100));

    const row = db
      .prepare("SELECT * FROM agent_states WHERE agent_id = ?")
      .get(agentId);
    expect(row).toBeNull();
  });

  it("updates existing agent_states record", async () => {
    const { agentId } = createTestEchoAgent('echo "done"');

    // Pre-insert an agent_states row
    db.prepare(
      "INSERT INTO agent_states (agent_id, state, state_metadata) VALUES (?, 'working', '{}')",
    ).run(agentId);

    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });
    running.sessionId = "sess-updated";

    await running.process.exited;
    await new Promise((r) => setTimeout(r, 100));

    const row = db
      .prepare(
        "SELECT state, json_extract(state_metadata, '$.session_id') as session_id FROM agent_states WHERE agent_id = ?",
      )
      .get(agentId) as { state: string; session_id: string | null } | null;
    expect(row).not.toBeNull();
    // State should remain as-is from the ON CONFLICT DO UPDATE (only metadata updated)
    expect(row!.session_id).toBe("sess-updated");
  });
});

describe("getSessionId", () => {
  it("returns session ID from running agent (memory-first)", async () => {
    const { agentId } = createTestEchoAgent("sleep 30");
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });
    running.sessionId = "sess-in-memory";

    const result = manager.getSessionId(agentId);
    expect(result).toBe("sess-in-memory");

    manager.killAgent(agentId);
  });

  it("falls back to DB when agent not running", () => {
    const agent = manager.createAgent({ name: "Offline Agent", type: "claude-code" });
    db.prepare(
      "INSERT INTO agent_states (agent_id, state, state_metadata) VALUES (?, 'stopped', ?)",
    ).run(agent.id, JSON.stringify({ session_id: "sess-from-db" }));

    const result = manager.getSessionId(agent.id);
    expect(result).toBe("sess-from-db");
  });

  it("returns null when no session ID anywhere", () => {
    const agent = manager.createAgent({ name: "No Session Agent", type: "claude-code" });
    const result = manager.getSessionId(agent.id);
    expect(result).toBeNull();
  });

  it("returns null for nonexistent agent", () => {
    const result = manager.getSessionId("nonexistent");
    expect(result).toBeNull();
  });
});

describe("sendResumeMessage", () => {
  function registerResumableType() {
    db.prepare(
      `INSERT OR REPLACE INTO agent_types (name, command, args, model_flag, available_models, env_vars, supports_stdin, supports_resume, resume_flag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "resumable-agent",
      "bash",
      JSON.stringify(["-c", "sleep 30"]),
      null,
      JSON.stringify([]),
      JSON.stringify({}),
      1,
      1,
      "--resume",
    );
  }

  it("throws when agent not found", async () => {
    await expect(
      manager.sendResumeMessage("nonexistent", "hello"),
    ).rejects.toThrow("Agent not found: nonexistent");
  });

  it("throws when agent type does not support resume", async () => {
    registerTestAgentType(db);
    const agent = manager.createAgent({ name: "No Resume", type: "test-echo" });

    await expect(
      manager.sendResumeMessage(agent.id, "hello"),
    ).rejects.toThrow("does not support resume");
  });

  it("throws when no session ID available", async () => {
    registerResumableType();
    const agent = manager.createAgent({ name: "No Session", type: "resumable-agent" });

    await expect(
      manager.sendResumeMessage(agent.id, "hello"),
    ).rejects.toThrow("No session ID available");
  });

  it("respawns agent with session ID from DB", async () => {
    registerResumableType();
    const agent = manager.createAgent({ name: "Resumable", type: "resumable-agent" });

    // Store session ID in DB
    db.prepare(
      "INSERT INTO agent_states (agent_id, state, state_metadata) VALUES (?, 'stopped', ?)",
    ).run(agent.id, JSON.stringify({ session_id: "sess-resume-123" }));

    await manager.sendResumeMessage(agent.id, "Continue working");

    // Agent should be running
    const running = manager.getRunningAgent(agent.id);
    expect(running).toBeDefined();
    expect(running!.sessionId).toBe("sess-resume-123");
  });

  it("kills existing process with respawn guard before resume", async () => {
    registerResumableType();
    const agent = manager.createAgent({ name: "Running Agent", type: "resumable-agent" });

    // Spawn agent initially
    const initial = await manager.spawnAgent(agent.id, { workingDir: "/tmp" });
    initial.sessionId = "sess-initial";

    const exitEvents: AgentExitEvent[] = [];
    const handler = (e: AgentExitEvent) => {
      if (e.agentId === agent.id) exitEvents.push(e);
    };
    eventBus.on("agent:exit", handler);

    await manager.sendResumeMessage(agent.id, "Resume work");

    // Wait for events to settle
    await new Promise((r) => setTimeout(r, 300));
    eventBus.off("agent:exit", handler);

    // The kill exit should have isRespawn=true
    const respawnExit = exitEvents.find((e) => e.isRespawn);
    expect(respawnExit).toBeDefined();

    // Agent should still be running (respawned)
    const running = manager.getRunningAgent(agent.id);
    expect(running).toBeDefined();
  });
});

describe("detectSignalsInText", () => {
  const agentId = "test-agent";

  it("detects DELEGATE signal in text", () => {
    const result = detectSignalsInText(agentId, "Some preamble\n[DELEGATE to:child-1] Do the work");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("delegate");
    expect(result!.targetAgent).toBe("child-1");
    expect(result!.content).toBe("Do the work");
  });

  it("detects DELEGATE_COMPLETE signal", () => {
    const result = detectSignalsInText(agentId, "[DELEGATE_COMPLETE] All done");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("delegate_complete");
    expect(result!.content).toBe("All done");
  });

  it("detects ESCALATE signal", () => {
    const result = detectSignalsInText(agentId, "[ESCALATE] Need human help");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("escalate");
    expect(result!.content).toBe("Need human help");
  });

  it("detects NOTE signal", () => {
    const result = detectSignalsInText(agentId, "[NOTE] Important finding");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("note");
  });

  it("detects PHASE_COMPLETE signal", () => {
    const result = detectSignalsInText(agentId, "Work done\n[PHASE_COMPLETE]\nMore text");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("phase_complete");
  });

  it("detects PHASE_REGRESSION signal", () => {
    const result = detectSignalsInText(agentId, "[PHASE_REGRESSION 2] Found critical bugs");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("phase_regression");
    expect(result!.targetPhase).toBe(2);
    expect(result!.reason).toBe("Found critical bugs");
  });

  it("returns null when no signals found", () => {
    const result = detectSignalsInText(agentId, "Just regular text\nNothing special here");
    expect(result).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(detectSignalsInText(agentId, "")).toBeNull();
  });

  it("returns first signal found when multiple present", () => {
    const result = detectSignalsInText(agentId, "[NOTE] A note\n[ESCALATE] Help me");
    expect(result).not.toBeNull();
    // NOTE comes before ESCALATE in scan order (by line)
    expect(result!.type).toBe("note");
  });

  it("trims whitespace from lines before matching", () => {
    const result = detectSignalsInText(agentId, "  [PHASE_COMPLETE]  ");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("phase_complete");
  });
});
