import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { AgentManager, extractTextFromJsonEvent, detectAllSignalsInText, detectSignalsInText, compactResumeMessage } from "./manager";
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
  manager.close();
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch { }
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

function createInlinePromptAgent(): { agentId: string } {
  db.prepare(
    `INSERT OR REPLACE INTO agent_types (
      name, command, args, resume_args, model_flag, available_models, env_vars, supports_stdin, supports_resume, resume_flag
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "test-inline-prompt",
    "bash",
    JSON.stringify(["-lc", "printf '%s' \"$1\"; sleep 0.2", "bash", "{{prompt}}"]),
    null,
    null,
    JSON.stringify([]),
    JSON.stringify({}),
    0,
    0,
    null,
  );
  const agent = manager.createAgent({ name: "Inline Prompt Agent", type: "test-inline-prompt" });
  return { agentId: agent.id };
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
  it("returns only seeded agents when no manual agents exist", () => {
    // chat-skipper is seeded by initializeDatabase via seedDefaultAgents
    const agents = manager.listAgents();
    expect(agents.some(a => a.id === "chat-skipper")).toBe(true);
  });

  it("returns all created agents plus seeded agents", () => {
    const seededCount = manager.listAgents().length;
    manager.createAgent({ name: "Agent 1", type: "claude-code" });
    manager.createAgent({ name: "Agent 2", type: "codex" });
    const agents = manager.listAgents();
    expect(agents).toHaveLength(seededCount + 2);
    expect(agents.some(a => a.name === "Agent 1")).toBe(true);
    expect(agents.some(a => a.name === "Agent 2")).toBe(true);
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

    expect(running.id).not.toBe(agentId); // UUID, not template ID
    expect(running.templateAgentId).toBe(agentId);
    expect(running.process.pid).toBeGreaterThan(0);
    expect(running.sessionId).toBeNull();
    expect(manager.getRunningAgent(agentId)).toBe(running); // fallback via templateToInstances

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

    // A new session should have been created (stored with running.id, the UUID)
    const sessions = db
      .prepare("SELECT * FROM agent_sessions WHERE agent_id = ?")
      .all(running.id) as { id: string }[];
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    // New output should be tagged with the session_id (stored with running.id)
    const newRows = db
      .prepare("SELECT * FROM terminal_outputs WHERE agent_id = ? AND session_id IS NOT NULL")
      .all(running.id) as { session_id: string }[];
    expect(newRows.length).toBeGreaterThanOrEqual(1);
    expect(newRows[0].session_id).toBe(sessions[0].id);
  });

  it("captures stdout in terminal_outputs and emits events", async () => {
    const { agentId } = createTestEchoAgent('echo "line1" && echo "line2"');
    const allEvents: AgentOutputEvent[] = [];
    // Register handler before spawn to capture all events; filter by running.id after
    const handler = (e: AgentOutputEvent) => {
      allEvents.push(e);
    };
    eventBus.on("agent:output", handler);

    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });
    await running.process.exited;
    // Small delay for stream reading to complete
    await new Promise((r) => setTimeout(r, 100));

    eventBus.off("agent:output", handler);

    // Filter events for this agent's runtime ID
    const events = allEvents.filter((e) => e.agentId === running.id);

    // Should have captured output (stored with running.id, the UUID)
    const rows = db
      .prepare(
        "SELECT * FROM terminal_outputs WHERE agent_id = ? AND stream = 'stdout' ORDER BY sequence",
      )
      .all(running.id) as { data: string; sequence: number }[];
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
      .all(running.id) as { data: string }[];
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
      .all(running.id) as { data: string }[];
    const allData = rows.map((r) => r.data).join("");
    expect(allData).toContain(`AGENT_ID=${agentId}`);
    expect(allData).toContain("AGENT_NAME=Test Echo");
    expect(allData).toContain("AGENT_TYPE=test-echo");
  });

  it("emits exit event and updates DB on process exit with code 0", async () => {
    const { agentId } = createTestEchoAgent('echo "done"');
    const exitEvents: AgentExitEvent[] = [];
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });
    // Exit event uses running.id (UUID) as agentId
    const handler = (e: AgentExitEvent) => {
      if (e.agentId === running.id) exitEvents.push(e);
    };
    eventBus.on("agent:exit", handler);

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

  it("sets idle status on non-zero exit (error is only for orchestration failures)", async () => {
    const { agentId } = createTestEchoAgent("exit 1");
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });
    await running.process.exited;
    await new Promise((r) => setTimeout(r, 100));

    const agent = manager.getAgent(agentId);
    expect(agent!.status).toBe("idle");
  });

  it("replaces an existing runtime when spawning the same agent twice", async () => {
    const { agentId } = createTestEchoAgent("sleep 10");
    const first = await manager.spawnAgent(agentId, { workingDir: "/tmp" });
    const firstPid = first.process.pid;

    const second = await manager.spawnAgent(agentId, { workingDir: "/tmp" });
    const secondPid = second.process.pid;

    expect(secondPid).not.toBe(firstPid);
    // Each spawn gets a new UUID, but getRunningAgent fallback finds by template ID
    expect(manager.getRunningAgent(agentId)?.process.pid).toBe(secondPid);
    // The first runtime was killed and removed; only the second remains
    expect(manager.getRunningAgents().size).toBe(1);
    // The map is keyed by runtimeId (UUID), not template ID
    expect(manager.getRunningAgents().has(second.id)).toBe(true);

    manager.killAgent(second.id);
    await manager.waitForExit(second.id, 10000);
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
      .all(running.id) as { data: string }[];
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
      .all(running.id) as { data: string }[];
    const allData = rows.map((r) => r.data).join("");
    expect(allData).toContain("sess-resume-xyz");
    expect(allData).not.toContain("base");
  });

  it("injects the initial prompt into inline-prompt args", async () => {
    const { agentId } = createInlinePromptAgent();
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp", initialPrompt: "inline hello" });
    await running.process.exited;
    await new Promise((r) => setTimeout(r, 100));

    const rows = db
      .prepare("SELECT data FROM terminal_outputs WHERE agent_id = ? AND stream = 'stdout'")
      .all(running.id) as { data: string }[];
    expect(rows.map((r) => r.data).join("")).toContain("inline hello");
  });
});

describe("processStdoutBuffer", () => {
  it("extracts complete lines from buffer", () => {
    const running: RunningAgent = {
      id: "test",
      templateAgentId: "test",
      taskId: null,
      parentInstanceId: null,
      rootInstanceId: "test",
      workingDir: "/tmp",
      process: null as any,
      stdin: null as any,
      stdoutBuffer: "line1\nline2\nincomplete",
      stderrBuffer: "",
      outputSequence: 0,
      sessionId: null,
      spawnSessionId: "sess",
      drainedStreams: 0,
      mcpCleanupPaths: [],
    };

    const lines = manager.processStdoutBuffer(running);
    expect(lines).toEqual(["line1", "line2"]);
    expect(running.stdoutBuffer).toBe("incomplete");
  });

  it("returns empty array when no complete lines", () => {
    const running: RunningAgent = {
      id: "test",
      templateAgentId: "test",
      taskId: null,
      parentInstanceId: null,
      rootInstanceId: "test",
      workingDir: "/tmp",
      process: null as any,
      stdin: null as any,
      stdoutBuffer: "no newline here",
      stderrBuffer: "",
      outputSequence: 0,
      sessionId: null,
      spawnSessionId: "sess",
      drainedStreams: 0,
      mcpCleanupPaths: [],
    };

    const lines = manager.processStdoutBuffer(running);
    expect(lines).toEqual([]);
    expect(running.stdoutBuffer).toBe("no newline here");
  });

  it("handles empty buffer", () => {
    const running: RunningAgent = {
      id: "test",
      templateAgentId: "test",
      taskId: null,
      parentInstanceId: null,
      rootInstanceId: "test",
      workingDir: "/tmp",
      process: null as any,
      stdin: null as any,
      stdoutBuffer: "",
      stderrBuffer: "",
      outputSequence: 0,
      sessionId: null,
      spawnSessionId: "sess",
      drainedStreams: 0,
      mcpCleanupPaths: [],
    };

    const lines = manager.processStdoutBuffer(running);
    expect(lines).toEqual([]);
  });

  it("handles buffer ending with newline", () => {
    const running: RunningAgent = {
      id: "test",
      templateAgentId: "test",
      taskId: null,
      parentInstanceId: null,
      rootInstanceId: "test",
      workingDir: "/tmp",
      process: null as any,
      stdin: null as any,
      stdoutBuffer: "line1\nline2\n",
      stderrBuffer: "",
      outputSequence: 0,
      sessionId: null,
      spawnSessionId: "sess",
      drainedStreams: 0,
      mcpCleanupPaths: [],
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

    // Send input using running.id (UUID) since sendInput does direct map lookup
    manager.sendInput(running.id, "hello-world", true);

    await running.process.exited;
    // Wait for stream reading to finish
    await new Promise((r) => setTimeout(r, 200));

    const rows = db
      .prepare(
        "SELECT * FROM terminal_outputs WHERE agent_id = ? AND stream = 'stdout'",
      )
      .all(running.id) as { data: string }[];
    const allData = rows.map((r) => r.data).join("");
    expect(allData).toContain("GOT:hello-world");
  });

  it("throws for inline-prompt providers because prompt must be passed at spawn", async () => {
    const { agentId } = createInlinePromptAgent();
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp", initialPrompt: "boot" });

    expect(() => manager.sendInput(running.id, "later")).toThrow(
      "Agent type test-inline-prompt requires prompt delivery at spawn time",
    );
  });

  // Regression: two parallel tasks on the same team share ONE template agent but
  // get distinct runtime instances. Callers (task-runner/phase/recovery/poke/
  // escalation) MUST sendInput to the specific spawned runtime id — NOT the
  // template id. sendInput(templateId) resolves an arbitrary sibling and writes
  // one task's prompt to the other's stdin, leaving the new claude-code --print
  // with no stdin ("Input must be provided..."). This locks per-instance routing.
  it("routes stdin to the exact instance under parallel same-team spawns", async () => {
    const { agentId } = createTestEchoAgent('read line && echo "GOT:$line"');
    db.prepare("INSERT INTO tasks (id, title) VALUES ('task-A', 'Parallel A')").run();
    db.prepare("INSERT INTO tasks (id, title) VALUES ('task-B', 'Parallel B')").run();

    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();
    const a = await manager.spawnAgentInstance(agentId, idA, {
      workingDir: "/tmp", taskId: "task-A", parentInstanceId: null, rootInstanceId: idA, attempt: 1,
    });
    const b = await manager.spawnAgentInstance(agentId, idB, {
      workingDir: "/tmp", taskId: "task-B", parentInstanceId: null, rootInstanceId: idB, attempt: 1,
    });

    await new Promise((r) => setTimeout(r, 50));

    // Deliver each task's prompt to ITS OWN runtime instance.
    manager.sendInput(a.id, "PROMPT_A", true);
    manager.sendInput(b.id, "PROMPT_B", true);

    await a.process.exited;
    await b.process.exited;
    await new Promise((r) => setTimeout(r, 200));

    const out = (rid: string): string =>
      (db.prepare("SELECT data FROM terminal_outputs WHERE agent_id = ? AND stream = 'stdout'").all(rid) as { data: string }[])
        .map((r) => r.data).join("");

    expect(out(a.id)).toContain("GOT:PROMPT_A");
    expect(out(a.id)).not.toContain("PROMPT_B");
    expect(out(b.id)).toContain("GOT:PROMPT_B");
    expect(out(b.id)).not.toContain("PROMPT_A");
  });
});

describe("killAgent", () => {
  it("returns false for nonexistent running agent", () => {
    expect(manager.killAgent("nonexistent")).toBe(false);
  });

  it("kills a running process", async () => {
    const { agentId } = createTestEchoAgent("sleep 30");
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });

    expect(manager.killAgent(running.id)).toBe(true);

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
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });

    expect(manager.getRunningAgents().size).toBe(1);
    // Map is keyed by runtimeId (UUID), not template ID
    expect(manager.getRunningAgents().has(running.id)).toBe(true);

    manager.killAgent(running.id);
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

  it("detects delegation complete signals", () => {
    const result = manager.parseAgentOutput(agentId, "[DELEGATE_COMPLETE] All tests pass");
    expect(result.type).toBe("delegate_complete");
    expect(result.content).toBe("All tests pass");
  });

  it("treats deprecated bracket signals as plain text", () => {
    expect(manager.parseAgentOutput(agentId, "[DELEGATE to:qa-agent] Review").type).toBe("text");
    expect(manager.parseAgentOutput(agentId, "[ESCALATE] Need help").type).toBe("text");
    expect(manager.parseAgentOutput(agentId, "[TASK_COMPLETE task:t1] Done").type).toBe("text");
    expect(manager.parseAgentOutput(agentId, "[PHASE_COMPLETE]").type).toBe("text");
    expect(manager.parseAgentOutput(agentId, "[PHASE_REGRESSION 1] QA bugs").type).toBe("text");
    expect(manager.parseAgentOutput(agentId, "[DELEGATE_BATCH] []").type).toBe("text");
    expect(manager.parseAgentOutput(agentId, "[CONSENSUS_PICK agent:abc]").type).toBe("text");
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
    // Persisted target row — session_id now lives on agent_instances (per-task).
    db.prepare("INSERT INTO tasks (id, title) VALUES ('task-json-sess', 'JSON sess')").run();
    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id) VALUES (?, 'task-json-sess', ?)",
    ).run(agent.id, agent.id);
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

    // Persisted eagerly to agent_instances (not agent_states — that table is
    // keyed by template id and would collide across parallel tasks).
    const row = db
      .prepare("SELECT session_id FROM agent_instances WHERE id = ?")
      .get(agent.id) as { session_id: string | null } | null;
    expect(row).not.toBeNull();
    expect(row!.session_id).toBe("sess-123");
  });

  it("captures thread_id from Codex JSON events for resume", () => {
    const agent = manager.createAgent({ name: "Test", type: "codex" });
    db.prepare("INSERT INTO tasks (id, title) VALUES ('task-json-thread', 'JSON thread')").run();
    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id) VALUES (?, 'task-json-thread', ?)",
    ).run(agent.id, agent.id);
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
      .prepare("SELECT session_id FROM agent_instances WHERE id = ?")
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

  it("deprecated bracket signals in JSON output are treated as json type", () => {
    const json: JsonEvent = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Done with work.\n[ESCALATE] need input" }],
      },
    };
    const result = manager.handleJsonOutput("agent-1", json, "{}");
    expect(result.type).toBe("json");
  });

  it("detects embedded delegate_complete signal in JSON output", () => {
    const json: JsonEvent = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "[DELEGATE_COMPLETE] All done" }],
      },
    };
    const result = manager.handleJsonOutput("agent-1", json, "{}");
    expect(result.type).toBe("delegate_complete");
    expect(result.content).toBe("All done");
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

  it("marks context compaction needed when turn input tokens are very large", () => {
    const agent = manager.createAgent({ name: "Big Context", type: "codex" });
    manager.handleJsonOutput(
      agent.id,
      { type: "turn.completed", usage: { input_tokens: 500_000, cached_input_tokens: 120_000, output_tokens: 1000 } },
      "{}",
    );

    const row = db
      .prepare(
        `SELECT
          json_extract(state_metadata, '$.context_compact_needed') as needed,
          json_extract(state_metadata, '$.last_input_tokens') as last_input_tokens
         FROM agent_states
         WHERE agent_id = ?`,
      )
      .get(agent.id) as { needed: number | null; last_input_tokens: number | null } | null;
    expect(row).not.toBeNull();
    expect(row!.needed).toBe(1);
    expect(row!.last_input_tokens).toBe(500000);
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

  it("extracts text from OpenCode text format", () => {
    const json: JsonEvent = {
      type: "text",
      sessionID: "ses_abc123",
      part: { type: "text", text: "Hello! How can I help you today?" },
    };
    expect(extractTextFromJsonEvent(json)).toBe("Hello! How can I help you today?");
  });

  it("returns null for OpenCode step_start events", () => {
    const json: JsonEvent = {
      type: "step_start",
      sessionID: "ses_abc123",
      part: { type: "step-start" },
    };
    expect(extractTextFromJsonEvent(json)).toBeNull();
  });

  it("returns null for OpenCode step_finish without text", () => {
    const json: JsonEvent = {
      type: "step_finish",
      sessionID: "ses_abc123",
      part: { type: "step-finish", reason: "stop", tokens: { total: 14846, input: 61, output: 44 } },
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
  it("persists session ID to agent_instances on process exit", async () => {
    const { agentId } = createTestEchoAgent('echo "done"');
    // spawnAgent only inserts an agent_instances row when there's a task
    // context, so seed one before the spawn.
    db.prepare("INSERT INTO tasks (id, title) VALUES ('task-persist-1', 'Persist test')").run();
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp", taskId: "task-persist-1" });

    // Manually set session ID (simulating JSON event capture)
    running.sessionId = "sess-abc-123";

    await running.process.exited;
    await new Promise((r) => setTimeout(r, 100));

    // session_id is per-instance — written to agent_instances, NOT agent_states
    // (the latter is keyed by template id and would collide across parallel tasks).
    const row = db
      .prepare("SELECT session_id FROM agent_instances WHERE id = ?")
      .get(running.id) as { session_id: string | null } | null;
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

  it("updates session_id on agent_instances for subsequent runs of the same instance", async () => {
    const { agentId } = createTestEchoAgent('echo "done"');
    db.prepare("INSERT INTO tasks (id, title) VALUES ('task-persist-2', 'Persist twice')").run();

    // First spawn — agent_instances row gets a session.
    const first = await manager.spawnAgent(agentId, { workingDir: "/tmp", taskId: "task-persist-2" });
    first.sessionId = "sess-initial";
    await first.process.exited;
    await new Promise((r) => setTimeout(r, 100));

    // Second spawn under same task writes its own session_id.
    const second = await manager.spawnAgent(agentId, { workingDir: "/tmp", taskId: "task-persist-2" });
    second.sessionId = "sess-second";
    await second.process.exited;
    await new Promise((r) => setTimeout(r, 100));

    const secondRow = db
      .prepare("SELECT session_id FROM agent_instances WHERE id = ?")
      .get(second.id) as { session_id: string | null } | null;
    expect(secondRow!.session_id).toBe("sess-second");
  });
});

describe("getSessionId", () => {
  it("returns session ID from running agent (memory-first)", async () => {
    const { agentId } = createTestEchoAgent("sleep 30");
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });
    running.sessionId = "sess-in-memory";

    // getSessionId does direct map lookup, so use running.id (UUID)
    const result = manager.getSessionId(running.id);
    expect(result).toBe("sess-in-memory");

    manager.killAgent(running.id);
  });

  it("falls back to agent_instances when agent not in memory", () => {
    // session_id lookup is now strictly per-instance via agent_instances.
    // agent_states is no longer consulted — it's keyed by template id and
    // would collide across parallel tasks running the same template.
    const agent = manager.createAgent({ name: "Offline Agent", type: "claude-code" });
    const instanceId = "instance-offline-1";
    db.prepare(
      "INSERT INTO tasks (id, title) VALUES ('task-offline', 'Offline task')",
    ).run();
    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, session_id) VALUES (?, 'task-offline', ?, ?)",
    ).run(instanceId, agent.id, "sess-from-db");

    const result = manager.getSessionId(instanceId);
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

  it("clearSessionId removes persisted session metadata", () => {
    const agent = manager.createAgent({ name: "Clear Session", type: "codex" });
    db.prepare(
      "INSERT INTO agent_states (agent_id, state, state_metadata) VALUES (?, 'working', ?)",
    ).run(agent.id, JSON.stringify({ session_id: "sess-old", context_compact_needed: 1, last_input_tokens: 123 }));

    manager.clearSessionId(agent.id);

    const row = db
      .prepare(
        `SELECT
          json_extract(state_metadata, '$.session_id') as session_id,
          json_extract(state_metadata, '$.context_compact_needed') as compact_needed
         FROM agent_states
         WHERE agent_id = ?`,
      )
      .get(agent.id) as { session_id: string | null; compact_needed: number | null } | null;
    expect(row).not.toBeNull();
    expect(row!.session_id).toBeNull();
    expect(row!.compact_needed).toBeNull();
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

  it("respawns agent with session ID from agent_instances", async () => {
    registerResumableType();
    const agent = manager.createAgent({ name: "Resumable", type: "resumable-agent" });

    // Seed a prior instance row so the per-instance session lookup finds it.
    db.prepare(
      "INSERT INTO tasks (id, title) VALUES ('task-resume-1', 'Resume test')",
    ).run();
    db.prepare(
      "INSERT INTO agent_instances (id, task_id, template_agent_id, session_id) VALUES (?, 'task-resume-1', ?, ?)",
    ).run(agent.id, agent.id, "sess-resume-123");

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
    // Exit event uses runtimeId (UUID), capture from initial spawn
    const handler = (e: AgentExitEvent) => {
      if (e.agentId === initial.id) exitEvents.push(e);
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

  it("starts a fresh session when context compaction is marked", async () => {
    registerResumableType();
    const agent = manager.createAgent({ name: "Compaction Agent", type: "resumable-agent" });
    db.prepare(
      "INSERT INTO agent_states (agent_id, state, state_metadata) VALUES (?, 'working', ?)",
    ).run(agent.id, JSON.stringify({ context_compact_needed: 1, last_input_tokens: 900000 }));

    await manager.sendResumeMessage(agent.id, "Continue after delegation");

    const running = manager.getRunningAgent(agent.id);
    expect(running).toBeDefined();

    const row = db
      .prepare(
        "SELECT json_extract(state_metadata, '$.context_compact_needed') as compact_needed FROM agent_states WHERE agent_id = ?",
      )
      .get(agent.id) as { compact_needed: number | null } | null;
    expect(row).not.toBeNull();
    expect(row!.compact_needed).toBeNull();

    manager.killAgent(running!.id);
  });

  it("resumes a stopped runtime instance by instance ID", async () => {
    registerResumableType();
    const agent = manager.createAgent({ name: "Runtime Resume", type: "resumable-agent" });
    const runtimeId = "runtime-parent-1";
    db.prepare("INSERT INTO teams (id, name, phases) VALUES (?, ?, ?)").run(
      "team-1",
      "Runtime Resume Team",
      JSON.stringify([]),
    );
    db.prepare("INSERT INTO tasks (id, title, status, team_id) VALUES (?, ?, ?, ?)").run(
      "task-1",
      "Runtime Resume Task",
      "running",
      "team-1",
    );

    await manager.spawnAgentInstance(agent.id, runtimeId, {
      workingDir: "/tmp",
      taskId: "task-1",
      parentInstanceId: null,
      rootInstanceId: runtimeId,
      attempt: 1,
    });

    db.prepare("UPDATE agent_instances SET session_id = ? WHERE id = ?").run("sess-runtime-123", runtimeId);
    manager.killAgent(runtimeId);
    await manager.waitForExit(runtimeId, 2000);

    await manager.sendResumeMessage(runtimeId, "Resume after delegation");

    const running = manager.getRunningAgent(runtimeId);
    expect(running).toBeDefined();
    expect(running!.templateAgentId).toBe(agent.id);
    expect(running!.sessionId).toBe("sess-runtime-123");
  });

  it("preserves runtime attempt when resuming a running runtime instance", async () => {
    registerResumableType();
    const agent = manager.createAgent({ name: "Runtime Attempt Preserve", type: "resumable-agent" });
    const runtimeId = "runtime-attempt-1";
    db.prepare("INSERT INTO teams (id, name, phases) VALUES (?, ?, ?)").run(
      "team-attempt-1",
      "Runtime Attempt Team",
      JSON.stringify([]),
    );
    db.prepare("INSERT INTO tasks (id, title, status, team_id) VALUES (?, ?, ?, ?)").run(
      "task-attempt-1",
      "Runtime Attempt Task",
      "running",
      "team-attempt-1",
    );

    await manager.spawnAgentInstance(agent.id, runtimeId, {
      workingDir: "/tmp",
      taskId: "task-attempt-1",
      parentInstanceId: "skipper",
      rootInstanceId: "skipper",
      attempt: 2,
      sessionId: "sess-runtime-attempt-123",
    });

    await manager.sendResumeMessage(runtimeId, "Resume with preserved attempt");

    const row = db
      .prepare("SELECT attempt FROM agent_instances WHERE id = ?")
      .get(runtimeId) as { attempt: number } | null;
    expect(row).not.toBeNull();
    expect(row!.attempt).toBe(2);

    manager.killAgent(runtimeId);
    await manager.waitForExit(runtimeId, 2000);
  });

  it("serializes concurrent resume calls for the same runtime instance", async () => {
    registerResumableType();
    const agent = manager.createAgent({ name: "Runtime Resume Lock", type: "resumable-agent" });
    const runtimeId = "runtime-resume-lock-1";
    db.prepare("INSERT INTO teams (id, name, phases) VALUES (?, ?, ?)").run(
      "team-resume-lock-1",
      "Runtime Resume Lock Team",
      JSON.stringify([]),
    );
    db.prepare("INSERT INTO tasks (id, title, status, team_id) VALUES (?, ?, ?, ?)").run(
      "task-resume-lock-1",
      "Runtime Resume Lock Task",
      "running",
      "team-resume-lock-1",
    );

    await manager.spawnAgentInstance(agent.id, runtimeId, {
      workingDir: "/tmp",
      taskId: "task-resume-lock-1",
      parentInstanceId: "skipper",
      rootInstanceId: "skipper",
      attempt: 2,
      sessionId: "sess-runtime-lock-123",
    });

    await Promise.all([
      manager.sendResumeMessage(runtimeId, "Resume request A"),
      manager.sendResumeMessage(runtimeId, "Resume request B"),
    ]);

    const running = manager.getRunningAgent(runtimeId);
    expect(running).toBeDefined();

    const row = db
      .prepare("SELECT attempt, status FROM agent_instances WHERE id = ?")
      .get(runtimeId) as { attempt: number; status: string } | null;
    expect(row).not.toBeNull();
    expect(row!.attempt).toBe(2);
    expect(row!.status).toBe("running");

    manager.killAgent(runtimeId);
    await manager.waitForExit(runtimeId, 2000);
  });

  it("appends synthetic output to the current spawn session", async () => {
    const { agentId } = createTestEchoAgent("sleep 5");
    const running = await manager.spawnAgent(agentId, { workingDir: "/tmp" });

    manager.appendSyntheticOutput(running.id, "[SKIPPER] synthetic note");

    const rows = db.prepare(
      "SELECT session_id, stream, data FROM terminal_outputs WHERE agent_id = ? ORDER BY sequence DESC LIMIT 1",
    ).all(running.id) as { session_id: string | null; stream: string; data: string }[];
    expect(rows[0].session_id).toBe(running.spawnSessionId);
    expect(rows[0].stream).toBe("stdout");
    expect(rows[0].data).toBe("[SKIPPER] synthetic note");

    manager.killAgent(running.id);
    await manager.waitForExit(running.id, 2000);
  });
});

describe("compactResumeMessage", () => {
  it("returns message unchanged when within limit", () => {
    const msg = "Hello, short message";
    expect(compactResumeMessage(msg, 200_000)).toBe(msg);
  });

  it("truncates delegation result content when message exceeds limit", () => {
    const resultContent = "x".repeat(300_000);
    const msg = `[DELEGATION_RESULT from:child-1]\n${resultContent}\n[END_DELEGATION_RESULT]`;
    const compacted = compactResumeMessage(msg, 200_000);
    expect(compacted.length).toBeLessThanOrEqual(200_000);
    expect(compacted).toContain("[DELEGATION_RESULT from:child-1]");
    expect(compacted).toContain("[END_DELEGATION_RESULT]");
    expect(compacted).toContain("[PROMPT TRUNCATED");
  });

  it("preserves content outside delegation result markers", () => {
    const prefix = "Important context before.\n";
    const resultContent = "y".repeat(300_000);
    const suffix = "\nImportant context after.";
    const msg = `${prefix}[DELEGATION_RESULT from:child-1]\n${resultContent}\n[END_DELEGATION_RESULT]${suffix}`;
    const compacted = compactResumeMessage(msg, 200_000);
    expect(compacted.length).toBeLessThanOrEqual(200_000);
    // Note: suffix is after END marker so it's part of the preserved suffix
    expect(compacted).toContain("[END_DELEGATION_RESULT]");
  });

  it("falls back to whole-message truncation when no delegation markers", () => {
    const msg = "a".repeat(300_000);
    const compacted = compactResumeMessage(msg, 200_000);
    expect(compacted.length).toBeLessThanOrEqual(200_000);
    expect(compacted).toContain("[PROMPT TRUNCATED");
  });

  it("truncates delegation batch payload content when message exceeds limit", () => {
    const resultContent = "x".repeat(300_000);
    const msg = `[DELEGATION_BATCH_RESULT id:g-1]\n${resultContent}\n[END_DELEGATION_BATCH_RESULT]`;
    const compacted = compactResumeMessage(msg, 200_000);
    expect(compacted.length).toBeLessThanOrEqual(200_000);
    expect(compacted).toContain("[DELEGATION_BATCH_RESULT id:g-1]");
    expect(compacted).toContain("[END_DELEGATION_BATCH_RESULT]");
    expect(compacted).toContain("[PROMPT TRUNCATED");
  });

  it("falls back to whole-message truncation when delegation overhead exceeds limit", () => {
    // Create a message where prefix + markers exceed the limit entirely
    const hugePrefix = "z".repeat(200_100);
    const msg = `${hugePrefix}[DELEGATION_RESULT from:child-1]\nsmall result\n[END_DELEGATION_RESULT]`;
    const compacted = compactResumeMessage(msg, 200_000);
    expect(compacted.length).toBeLessThanOrEqual(200_000);
    expect(compacted).toContain("[PROMPT TRUNCATED");
  });
});

describe("detectSignalsInText", () => {
  const agentId = "test-agent";

  it("detects DELEGATE_COMPLETE signal", () => {
    const result = detectSignalsInText(agentId, "[DELEGATE_COMPLETE] All done");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("delegate_complete");
    expect(result!.content).toBe("All done");
  });

  it("ignores deprecated bracket signals", () => {
    expect(detectSignalsInText(agentId, "[DELEGATE to:child-1] Do work")).toBeNull();
    expect(detectSignalsInText(agentId, "[ESCALATE] Need help")).toBeNull();
    expect(detectSignalsInText(agentId, "[PHASE_REGRESSION 2] Found bugs")).toBeNull();
    expect(detectSignalsInText(agentId, "[PHASE_COMPLETE]")).toBeNull();
    expect(detectSignalsInText(agentId, "[DELEGATE_BATCH] []")).toBeNull();
    expect(detectSignalsInText(agentId, "[CONSENSUS_PICK agent:abc]")).toBeNull();
  });

  it("returns null when no signals found", () => {
    const result = detectSignalsInText(agentId, "Just regular text\nNothing special here");
    expect(result).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(detectSignalsInText(agentId, "")).toBeNull();
  });

  it("captures multiline DELEGATE_COMPLETE content", () => {
    const results = detectAllSignalsInText(
      agentId,
      "[DELEGATE_COMPLETE]\n**File:** Handler.java\n**Output:** 3 pairs generated",
    );
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("delegate_complete");
    expect(results[0].content).toContain("Handler.java");
    expect(results[0].content).toContain("3 pairs generated");
  });

  it("detects conversation signals", () => {
    const results = detectAllSignalsInText(agentId, "[CREATE_TASK title:Test team:dev description:A test task]");
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("conversation_create_task");
  });
});


describe("internal sub-agent recording (subagent_usage)", () => {
  function seedInstance(type = "claude-code"): string {
    const taskId = crypto.randomUUID();
    const instanceId = crypto.randomUUID();
    const agent = manager.createAgent({ name: "Tmpl", type });
    db.prepare("INSERT INTO tasks (id, title) VALUES (?, 'Sub Task')").run(taskId);
    db.prepare("INSERT INTO agent_instances (id, task_id, template_agent_id, status) VALUES (?, ?, ?, 'running')").run(instanceId, taskId, agent.id);
    return instanceId;
  }

  it("registers a sub-agent from an Agent tool_use block and dedupes by tool_use_id (count)", () => {
    const inst = seedInstance();
    const line = JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "toolu_A", name: "Agent", input: { subagent_type: "Explore", description: "map repo" } },
    ] } });
    manager.parseAgentOutput(inst, line);
    manager.parseAgentOutput(inst, line); // re-emitted frame must not create a second row

    const row = db.prepare("SELECT * FROM subagent_usage WHERE tool_use_id='toolu_A'").get() as any;
    expect(row.subagent_type).toBe("Explore");
    expect(row.description).toBe("map repo");
    expect((db.prepare("SELECT COUNT(*) c FROM subagent_usage").get() as any).c).toBe(1);
  });

  it("takes MAX of the cumulative total_tokens, never sums", () => {
    const inst = seedInstance();
    for (const t of [12000, 15000, 40000, 39000]) { // last is lower (out-of-order frame)
      manager.parseAgentOutput(inst, JSON.stringify({ type: "system", subtype: "task_progress", tool_use_id: "toolu_B", subagent_type: "general-purpose", usage: { total_tokens: t, tool_uses: 3, duration_ms: 5000 } }));
    }
    const row = db.prepare("SELECT total_tokens, subagent_type FROM subagent_usage WHERE tool_use_id='toolu_B'").get() as any;
    expect(row.total_tokens).toBe(40000); // max, NOT 106000 sum
    expect(row.subagent_type).toBe("general-purpose");
  });

  it("spawn and progress frames compose on the same id", () => {
    const inst = seedInstance();
    manager.parseAgentOutput(inst, JSON.stringify({ type: "assistant", message: { content: [ { type: "tool_use", id: "toolu_C", name: "Agent", input: { subagent_type: "Explore", description: "d" } } ] } }));
    manager.parseAgentOutput(inst, JSON.stringify({ type: "system", subtype: "task_progress", tool_use_id: "toolu_C", usage: { total_tokens: 5000 } }));
    const row = db.prepare("SELECT * FROM subagent_usage WHERE tool_use_id='toolu_C'").get() as any;
    expect(row.subagent_type).toBe("Explore");
    expect(row.description).toBe("d");
    expect(row.total_tokens).toBe(5000);
    expect((db.prepare("SELECT COUNT(*) c FROM subagent_usage").get() as any).c).toBe(1);
  });

  it("does NOT record usage for non-allowlisted providers (gated to claude-code)", () => {
    const inst = seedInstance("codex");
    // Same frames a claude-code agent would emit — must be ignored for codex.
    manager.parseAgentOutput(inst, JSON.stringify({ type: "assistant", message: { content: [ { type: "tool_use", id: "toolu_X", name: "Agent", input: { subagent_type: "Explore" } } ] } }));
    manager.parseAgentOutput(inst, JSON.stringify({ type: "system", subtype: "task_progress", tool_use_id: "toolu_X", usage: { total_tokens: 9000 } }));
    expect((db.prepare("SELECT COUNT(*) c FROM subagent_usage").get() as any).c).toBe(0);
  });
});
