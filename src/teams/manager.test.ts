import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { TeamManager } from "./manager";
import { AgentManager } from "../agents/manager";
import { clearAgentTypeCache } from "../agents/types";
import { unlinkSync } from "fs";

const TEST_DB = "test-team-manager.db";

let db: Database;
let teamManager: TeamManager;
let agentManager: AgentManager;

beforeEach(() => {
  clearAgentTypeCache();
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  teamManager = new TeamManager(db);
  agentManager = new AgentManager(db);
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

describe("createTeam", () => {
  it("creates a team with name only", () => {
    const team = teamManager.createTeam({ name: "Test Team" });
    expect(team.id).toBeTruthy();
    expect(team.name).toBe("Test Team");
    expect(team.entrypoint_agent_id).toBe("skipper");
    expect(team.phases).toEqual([]);
    expect(team.goal).toBeNull();
  });

  it("creates a team with all fields", () => {
    const phases = [
      { name: "plan", prompt: "Plan the task" },
      { name: "execute", prompt: "Execute the plan" },
    ];
    const team = teamManager.createTeam({
      name: "Full Team",
      goal: "Build software",
      phases,
    });
    expect(team.goal).toBe("Build software");
    expect(team.phases).toEqual(phases);
  });
});

describe("getTeam", () => {
  it("returns a team by id", () => {
    const created = teamManager.createTeam({ name: "Team A" });
    const fetched = teamManager.getTeam(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
  });

  it("returns null for nonexistent id", () => {
    expect(teamManager.getTeam("nonexistent")).toBeNull();
  });
});

describe("listTeams", () => {
  it("returns empty array when no teams exist", () => {
    expect(teamManager.listTeams()).toEqual([]);
  });

  it("returns all created teams", () => {
    teamManager.createTeam({ name: "Team 1" });
    teamManager.createTeam({ name: "Team 2" });
    expect(teamManager.listTeams()).toHaveLength(2);
  });
});

describe("addAgent", () => {
  it("adds an agent to a team", () => {
    const agent = agentManager.createAgent({
      name: "Agent 1",
      type: "claude-code",
    });
    const team = teamManager.createTeam({ name: "Team" });

    const membership = teamManager.addAgent(team.id, {
      agent_id: agent.id,
      role: "developer",
    });

    expect(membership.team_id).toBe(team.id);
    expect(membership.agent_id).toBe(agent.id);
    expect(membership.role).toBe("developer");
    expect(membership.level).toBe(1); // Workers are forced to level >= 1
    expect(membership.max_complexity).toBe(10);
  });

  it("throws for nonexistent team", () => {
    const agent = agentManager.createAgent({
      name: "Agent",
      type: "claude-code",
    });
    expect(() =>
      teamManager.addAgent("nonexistent", { agent_id: agent.id }),
    ).toThrow("Team not found");
  });

  it("throws for nonexistent agent", () => {
    const team = teamManager.createTeam({ name: "Team" });
    expect(() =>
      teamManager.addAgent(team.id, { agent_id: "nonexistent" }),
    ).toThrow("Agent not found");
  });

  it("enforces unique team membership", () => {
    const agent = agentManager.createAgent({
      name: "Agent",
      type: "claude-code",
    });
    const team = teamManager.createTeam({ name: "Team" });
    teamManager.addAgent(team.id, { agent_id: agent.id });
    expect(() =>
      teamManager.addAgent(team.id, { agent_id: agent.id }),
    ).toThrow();
  });

  it("validates parent agent membership", () => {
    const agent = agentManager.createAgent({
      name: "Child",
      type: "claude-code",
    });
    const parent = agentManager.createAgent({
      name: "Parent",
      type: "claude-code",
    });
    const team = teamManager.createTeam({ name: "Team" });
    // Parent not added to team yet
    expect(() =>
      teamManager.addAgent(team.id, {
        agent_id: agent.id,
        parent_agent_id: parent.id,
      }),
    ).toThrow("Parent agent must be a member of the same team");
  });

  it("allows parent agent when parent is a team member", () => {
    const parent = agentManager.createAgent({
      name: "Parent",
      type: "claude-code",
    });
    const child = agentManager.createAgent({
      name: "Child",
      type: "claude-code",
    });
    const team = teamManager.createTeam({ name: "Team" });
    teamManager.addAgent(team.id, { agent_id: parent.id, role: "lead" });
    const membership = teamManager.addAgent(team.id, {
      agent_id: child.id,
      parent_agent_id: parent.id,
    });
    expect(membership.parent_agent_id).toBe(parent.id);
  });
});

describe("setEntrypoint", () => {
  it("allows setting Skipper as entrypoint (no-op)", () => {
    const team = teamManager.createTeam({ name: "Team" });
    // Setting Skipper is a no-op (it's always the entrypoint)
    teamManager.setEntrypoint(team.id, "skipper");
    const updated = teamManager.getTeam(team.id);
    expect(updated!.entrypoint_agent_id).toBe("skipper");
  });

  it("throws when trying to set a non-Skipper agent as entrypoint", () => {
    const agent = agentManager.createAgent({
      name: "Outsider",
      type: "claude-code",
    });
    const team = teamManager.createTeam({ name: "Team" });
    expect(() => teamManager.setEntrypoint(team.id, agent.id)).toThrow(
      "Skipper is always the entrypoint agent",
    );
  });
});

describe("getTeamAgents", () => {
  it("returns agents ordered by level", () => {
    const lead = agentManager.createAgent({
      name: "Lead",
      type: "claude-code",
    });
    const dev = agentManager.createAgent({
      name: "Dev",
      type: "claude-code",
    });
    const team = teamManager.createTeam({ name: "Team" });
    teamManager.addAgent(team.id, {
      agent_id: dev.id,
      level: 2,
    });
    teamManager.addAgent(team.id, {
      agent_id: lead.id,
      level: 1,
    });

    const agents = teamManager.getTeamAgents(team.id);
    // Skipper at level 0 + 2 workers
    expect(agents).toHaveLength(3);
    expect(agents[0].level).toBe(0); // Skipper
    expect(agents[0].agent_id).toBe("skipper");
    expect(agents[1].level).toBe(1);
    expect(agents[2].level).toBe(2);
  });
});

describe("updateTeamAgent", () => {
  it("updates role, level, and max complexity for a team member", () => {
    const agent = agentManager.createAgent({ name: "Agent", type: "claude-code" });
    const team = teamManager.createTeam({ name: "Team" });
    teamManager.addAgent(team.id, { agent_id: agent.id });

    const updated = teamManager.updateTeamAgent(team.id, agent.id, {
      role: "reviewer",
      level: 2,
      max_complexity: 8,
    });

    expect(updated.role).toBe("reviewer");
    expect(updated.level).toBe(2);
    expect(updated.max_complexity).toBe(8);
  });
});

describe("removeAgent", () => {
  it("removes a member from team", () => {
    const agent = agentManager.createAgent({ name: "Agent", type: "claude-code" });
    const team = teamManager.createTeam({ name: "Team" });
    teamManager.addAgent(team.id, { agent_id: agent.id });

    teamManager.removeAgent(team.id, agent.id);
    expect(teamManager.isTeamMember(team.id, agent.id)).toBe(false);
  });

  it("throws when trying to remove Skipper from team", () => {
    const team = teamManager.createTeam({ name: "Team" });
    expect(() => teamManager.removeAgent(team.id, "skipper")).toThrow(
      "Skipper cannot be removed from a team",
    );
  });
});

describe("getTeamForExecution", () => {
  it("always returns Skipper as entrypoint", () => {
    const team = teamManager.createTeam({ name: "Team" });
    const result = teamManager.getTeamForExecution(team.id);
    expect(result).not.toBeNull();
    expect(result!.entrypoint_agent_id).toBe("skipper");
  });

  it("returns null for nonexistent team", () => {
    expect(teamManager.getTeamForExecution("nonexistent")).toBeNull();
  });

  it("returns team with Skipper entrypoint and all agents", () => {
    const agent = agentManager.createAgent({
      name: "Worker",
      type: "claude-code",
    });
    const team = teamManager.createTeam({ name: "Team", goal: "Test" });
    teamManager.addAgent(team.id, { agent_id: agent.id });

    const result = teamManager.getTeamForExecution(team.id);
    expect(result).not.toBeNull();
    expect(result!.entrypoint_agent_id).toBe("skipper");
    expect(result!.team.goal).toBe("Test");
    expect(result!.agents).toHaveLength(2); // Skipper + worker
  });
});
