import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { AgentManager } from "./manager";
import { clearAgentTypeCache } from "./types";
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
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

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
