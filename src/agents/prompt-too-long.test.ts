import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { AgentManager } from "./manager";
import { clearAgentTypeCache } from "./types";
import { eventBus } from "../events/bus";
import type { AgentExitEvent } from "../events/bus";
import { unlinkSync } from "fs";

const TEST_DB = "test-prompt-too-long.db";

describe("Prompt too long detection in stderr", () => {
  let db: Database;
  let manager: AgentManager;

  beforeEach(() => {
    clearAgentTypeCache();
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);
    manager = new AgentManager(db);

    db.prepare(
      `INSERT OR REPLACE INTO agent_types (name, command, args, model_flag, available_models, env_vars, supports_stdin, supports_resume, resume_flag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("test-stderr", "bash", JSON.stringify(["-c", 'echo "Prompt is too long" >&2; exit 1']),
      null, JSON.stringify([]), JSON.stringify({}), 1, 0, null);
  });

  afterEach(() => {
    for (const [id] of manager.getRunningAgents()) {
      try { manager.killAgent(id); } catch {}
    }
    manager.getRunningAgents().clear();
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it("includes stderrSnippet in exit event", async () => {
    const agent = manager.createAgent({ name: "Test", type: "test-stderr" });

    const exitPromise = new Promise<AgentExitEvent>((resolve) => {
      eventBus.once("agent:exit", resolve);
    });

    await manager.spawnAgent(agent.id, { workingDir: process.cwd() });
    const event = await exitPromise;

    expect(event.code).not.toBe(0);
    expect(event.stderrSnippet).toContain("Prompt is too long");
  });

  it("has empty stderrSnippet when no stderr output", async () => {
    // Use a clean exit agent
    db.prepare("UPDATE agent_types SET args = ? WHERE name = 'test-stderr'").run(
      JSON.stringify(["-c", "exit 0"]),
    );

    const agent = manager.createAgent({ name: "Test", type: "test-stderr" });

    const exitPromise = new Promise<AgentExitEvent>((resolve) => {
      eventBus.once("agent:exit", resolve);
    });

    await manager.spawnAgent(agent.id, { workingDir: process.cwd() });
    const event = await exitPromise;

    expect(event.stderrSnippet).toBe("");
  });
});

describe("Prompt too long pattern matching", () => {
  const pattern = /prompt.*(too long|too large)|context.*(too long|exceeded|overflow)|token.*limit.*exceeded/i;

  it("matches 'Prompt is too long'", () => {
    expect(pattern.test("Error: Prompt is too long")).toBe(true);
  });

  it("matches 'prompt too large'", () => {
    expect(pattern.test("prompt too large for context")).toBe(true);
  });

  it("matches 'context length exceeded'", () => {
    expect(pattern.test("context length exceeded")).toBe(true);
  });

  it("matches 'token limit exceeded'", () => {
    expect(pattern.test("token limit exceeded")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(pattern.test("Agent exited with code 1")).toBe(false);
    expect(pattern.test("Permission denied")).toBe(false);
  });
});
