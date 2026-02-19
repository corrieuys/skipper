import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import {
  getAgentTypeDefinition,
  listAgentTypes,
  clearAgentTypeCache,
} from "./types";
import { unlinkSync } from "fs";

const TEST_DB = "test-agent-types.db";

let db: Database;

beforeEach(() => {
  clearAgentTypeCache();
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

describe("getAgentTypeDefinition", () => {
  it("returns claude-code type with correct fields", () => {
    const def = getAgentTypeDefinition("claude-code", db);
    expect(def).not.toBeNull();
    expect(def!.name).toBe("claude-code");
    expect(def!.command).toBe("claude");
    expect(def!.args).toContain("--print");
    expect(def!.args).toContain("--output-format");
    expect(def!.args).toContain("stream-json");
    expect(def!.model_flag).toBe("--model");
    expect(def!.available_models).toContain("claude-sonnet-4-6");
    expect(def!.available_models).toContain("claude-opus-4-6");
    expect(def!.supports_stdin).toBe(false);
    expect(def!.supports_resume).toBe(true);
    expect(def!.resume_flag).toBe("--resume");
    expect(def!.resume_args).toBeNull();
  });

  it("returns codex type with correct fields", () => {
    const def = getAgentTypeDefinition("codex", db);
    expect(def).not.toBeNull();
    expect(def!.command).toBe("codex");
    expect(def!.supports_resume).toBe(true);
    expect(def!.resume_flag).toBeNull();
    expect(def!.resume_args).toEqual(["exec", "resume", "{{session_id}}", "--json", "--dangerously-bypass-approvals-and-sandbox", "-"]);
    expect(def!.model_flag).toBeNull();
  });

  it("returns opencode type with correct fields", () => {
    const def = getAgentTypeDefinition("opencode", db);
    expect(def).not.toBeNull();
    expect(def!.name).toBe("opencode");
    expect(def!.command).toBe("opencode");
    expect(def!.args).toEqual(["run", "{{prompt}}", "--format", "json"]);
    expect(def!.model_flag).toBe("-m");
    expect(def!.available_models).toContain("opencode/big-pickle");
    expect(def!.available_models).toContain("opencode/gpt-5-nano");
    expect(def!.supports_stdin).toBe(false);
    expect(def!.supports_resume).toBe(true);
    expect(def!.resume_flag).toBeNull();
    expect(def!.resume_args).toEqual(["run", "{{prompt}}", "--format", "json", "--session", "{{session_id}}"]);
  });

  it("returns oz type with correct fields", () => {
    const def = getAgentTypeDefinition("oz", db);
    expect(def).not.toBeNull();
    expect(def!.name).toBe("oz");
    expect(def!.command).toBe("oz");
    expect(def!.args).toEqual(["agent", "run", "--output-format", "json", "--prompt", "{{prompt}}"]);
    expect(def!.model_flag).toBe("--model");
    expect(def!.available_models).toContain("auto");
    expect(def!.available_models).toContain("gpt-5-4-medium");
    expect(def!.supports_stdin).toBe(false);
    expect(def!.supports_resume).toBe(false);
    expect(def!.resume_flag).toBeNull();
    expect(def!.resume_args).toBeNull();
  });

  it("returns null for nonexistent type", () => {
    const def = getAgentTypeDefinition("nonexistent", db);
    expect(def).toBeNull();
  });

  it("caches results in memory", () => {
    const first = getAgentTypeDefinition("claude-code", db);
    // Delete from DB to prove cache is used (clear FKs first)
    db.prepare("DELETE FROM team_agents").run();
    db.prepare("DELETE FROM teams").run();
    db.prepare("DELETE FROM agents WHERE type = ?").run("claude-code");
    db.prepare("DELETE FROM agent_types WHERE name = ?").run("claude-code");
    const second = getAgentTypeDefinition("claude-code", db);
    expect(second).toEqual(first);
  });

  it("returns fresh data after cache clear", () => {
    getAgentTypeDefinition("claude-code", db);
    clearAgentTypeCache();
    // Update DB
    db.prepare("UPDATE agent_types SET command = ? WHERE name = ?").run(
      "modified-claude",
      "claude-code",
    );
    const def = getAgentTypeDefinition("claude-code", db);
    expect(def!.command).toBe("modified-claude");
  });
});

describe("listAgentTypes", () => {
  it("returns all seeded agent types", () => {
    const types = listAgentTypes(db);
    expect(types).toHaveLength(5);
    const names = types.map((t) => t.name);
    expect(names).toContain("claude-code");
    expect(names).toContain("codex");
    expect(names).toContain("opencode");
    expect(names).toContain("oz");
    // conversation-skipper type still seeded but agents now use claude-code
    expect(names).toContain("conversation-skipper");
  });

  it("returns types sorted by name", () => {
    const types = listAgentTypes(db);
    const names = types.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });

  it("populates cache for all types", () => {
    listAgentTypes(db);
    // Delete from DB to prove cache is populated (clear FKs first)
    db.prepare("DELETE FROM team_agents").run();
    db.prepare("DELETE FROM teams").run();
    db.prepare("DELETE FROM agents").run();
    db.prepare("DELETE FROM agent_types").run();
    const def = getAgentTypeDefinition("codex", db);
    expect(def).not.toBeNull();
    expect(def!.command).toBe("codex");
  });

  it("parses JSON fields correctly", () => {
    const types = listAgentTypes(db);
    const claudeCode = types.find((t) => t.name === "claude-code")!;
    expect(Array.isArray(claudeCode.args)).toBe(true);
    expect(Array.isArray(claudeCode.available_models)).toBe(true);
    expect(typeof claudeCode.env_vars).toBe("object");
    expect(claudeCode.env_vars).toEqual({});
  });
});
