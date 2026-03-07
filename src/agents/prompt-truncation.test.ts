import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { AgentManager, truncateToByteLimit } from "./manager";
import { clearAgentTypeCache } from "./types";
import { unlinkSync } from "fs";

const TEST_DB = "test-prompt-truncation.db";

describe("truncateToByteLimit", () => {
  it("returns original string when within limit", () => {
    const text = "Hello, world!";
    expect(truncateToByteLimit(text, 100)).toBe(text);
  });

  it("truncates string exceeding byte limit", () => {
    const text = "a".repeat(200);
    const result = truncateToByteLimit(text, 100);
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(100);
  });

  it("handles multi-byte characters without splitting them", () => {
    // Each emoji is 4 bytes in UTF-8
    const text = "🎉".repeat(30); // 120 bytes
    const result = truncateToByteLimit(text, 50);
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(50);
    // Should produce valid UTF-8 (no broken multi-byte sequences)
    const roundTripped = Buffer.from(result, "utf-8").toString("utf-8");
    expect(roundTripped).toBe(result);
    // Each emoji in JS is 2 chars (surrogate pair), result should only contain whole emojis
    for (const char of result) {
      expect(char.codePointAt(0)).toBeDefined();
    }
  });

  it("prefers cutting at newline boundary when near end", () => {
    // Build text where a newline falls in the last 20% of the truncation point
    const line = "x".repeat(80);
    const text = `${line}\n${line}\n${line}\n${line}\n${line}`;
    const limit = Buffer.byteLength(`${line}\n${line}\n${line}\n${line}`, "utf-8") + 10;
    const result = truncateToByteLimit(text, limit);
    // Should cut at a newline boundary
    expect(result.endsWith("\n" + line) || result.endsWith(line)).toBe(true);
  });

  it("returns empty-ish string for very small limit", () => {
    const text = "Hello, world!";
    const result = truncateToByteLimit(text, 5);
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(5);
  });
});

describe("sendInput prompt truncation", () => {
  let db: Database;
  let manager: AgentManager;

  beforeEach(() => {
    clearAgentTypeCache();
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);
    manager = new AgentManager(db);

    // Register test agent type
    db.prepare(
      `INSERT OR REPLACE INTO agent_types (name, command, args, model_flag, available_models, env_vars, supports_stdin, supports_resume, resume_flag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("test-cat", "bash", JSON.stringify(["-c", "cat > /dev/null && exit 0"]), null, JSON.stringify([]), JSON.stringify({}), 1, 0, null);
  });

  afterEach(() => {
    for (const [id] of manager.getRunningAgents()) {
      try { manager.killAgent(id); } catch {}
    }
    manager.getRunningAgents().clear();
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it("logs truncation when prompt exceeds limit", async () => {
    const agent = manager.createAgent({ name: "Test", type: "test-cat" });
    await manager.spawnAgent(agent.id, { workingDir: process.cwd() });

    // Send a very large prompt (> 100KB)
    const largePrompt = "x".repeat(150_000);
    manager.sendInput(agent.id, largePrompt);

    // Check error_log for truncation entry
    const logEntry = db.prepare(
      "SELECT * FROM error_log WHERE category = 'agent.prompt_truncated' ORDER BY created_at DESC LIMIT 1",
    ).get() as any;

    expect(logEntry).toBeTruthy();
    const context = JSON.parse(logEntry.context);
    expect(context.agentId).toBe(agent.id);
    expect(context.originalBytes).toBe(150_000);
  });

  it("does not truncate prompts within limit", async () => {
    const agent = manager.createAgent({ name: "Test", type: "test-cat" });
    await manager.spawnAgent(agent.id, { workingDir: process.cwd() });

    const normalPrompt = "Hello, agent!";
    manager.sendInput(agent.id, normalPrompt);

    const logEntry = db.prepare(
      "SELECT * FROM error_log WHERE category = 'agent.prompt_truncated'",
    ).get();

    expect(logEntry).toBeNull();
  });
});
