import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { getTeam, getAgent, resetConfigStore } from "../config/store";
import {
  createLocalTeam,
  updateLocalTeam,
  deleteLocalTeam,
  listLocalTeams,
  getLocalTeam,
  namespacedAgentId,
  type LocalTeamInput,
} from "./local-teams";

let db: Database;

function pickAgentType(): string {
  // Use whatever the first inline-capable agent type the JSON config exposes.
  // claude-code is always present in config/agent_types.json.
  return "claude-code";
}

const baseInput = (): LocalTeamInput => ({
  id: "alpha",
  name: "Alpha Team",
  goal: "ship it",
  skipper_prompt: "lead the team",
  phases: [{ name: "build", prompt: "do the work" }],
  agents: [
    { id: "dev", name: "Dev", type: pickAgentType(), model: "default", instruction: "write code", role: "worker", level: 1, parent_agent_id: "skipper" },
    { id: "qa", name: "QA", type: pickAgentType(), model: "sonnet", instruction: "test code", role: "worker", level: 2, parent_agent_id: "dev" },
  ],
});

beforeEach(() => {
  resetConfigStore();
  db = new Database(":memory:");
  initializeDatabase(db);
});

afterEach(() => {
  db.close();
  resetConfigStore();
});

describe("local teams persistence + flatten", () => {
  it("create persists a local_teams row", () => {
    createLocalTeam(db, baseInput());
    const rows = listLocalTeams(db);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("alpha");
    expect(rows[0].agents.length).toBe(2);
    expect(getLocalTeam(db, "alpha")?.name).toBe("Alpha Team");
  });

  it("create makes the team resolvable with skipper as level-0 member", () => {
    createLocalTeam(db, baseInput());
    const team = getTeam("alpha");
    expect(team).toBeTruthy();
    expect(team!.entrypoint_agent_id).toBe("skipper");
    const skipperMember = team!.members.find((m) => m.agent_id === "skipper");
    expect(skipperMember).toBeTruthy();
    expect(skipperMember!.level).toBe(0);
  });

  it("each inline agent present under its namespaced id with correct fields", () => {
    createLocalTeam(db, baseInput());
    const devId = namespacedAgentId("alpha", "dev");
    const qaId = namespacedAgentId("alpha", "qa");
    expect(devId).toBe("alpha:dev");

    const dev = getAgent(devId);
    expect(dev).toBeTruthy();
    expect(dev!.instruction).toBe("write code");
    expect(dev!.model).toBe("default");

    const qa = getAgent(qaId);
    expect(qa!.instruction).toBe("test code");
    expect(qa!.model).toBe("sonnet");

    // parent ref namespacing: dev -> skipper stays skipper; qa -> dev namespaced
    const team = getTeam("alpha")!;
    const devMember = team.members.find((m) => m.agent_id === devId)!;
    const qaMember = team.members.find((m) => m.agent_id === qaId)!;
    expect(devMember.parent_agent_id).toBe("skipper");
    expect(qaMember.parent_agent_id).toBe(devId);
  });

  it("flatten reaches the config tables (delegation legality query returns a row)", () => {
    createLocalTeam(db, baseInput());
    const devId = namespacedAgentId("alpha", "dev");
    const qaId = namespacedAgentId("alpha", "qa");
    // Two inline agents sharing a team_agents.team_id => delegation legal.
    const row = db
      .prepare(
        `SELECT p.team_id
           FROM team_agents p
           JOIN team_agents c ON c.team_id = p.team_id
          WHERE p.agent_id = ? AND c.agent_id = ?`,
      )
      .get(devId, qaId) as { team_id: string } | null;
    expect(row).toBeTruthy();
    expect(row!.team_id).toBe("alpha");

    // skipper member also present in config tables
    const skipperRow = db
      .prepare("SELECT agent_id FROM team_agents WHERE team_id = ? AND agent_id = 'skipper'")
      .get("alpha");
    expect(skipperRow).toBeTruthy();

    // inline agent present in shared agents table with the right instruction
    const agentRow = db.prepare("SELECT config FROM agents WHERE id = ?").get(devId) as { config: string };
    expect(JSON.parse(agentRow.config).instruction).toBe("write code");
  });

  it("update refreshes shared state (rename inline agent, change instruction)", () => {
    createLocalTeam(db, baseInput());
    const updated: LocalTeamInput = {
      ...baseInput(),
      agents: [
        { id: "dev", name: "Dev", type: pickAgentType(), model: "opus", instruction: "write better code", role: "worker", level: 1, parent_agent_id: "skipper" },
      ],
    };
    updateLocalTeam(db, "alpha", updated);

    const devId = namespacedAgentId("alpha", "dev");
    expect(getAgent(devId)!.model).toBe("opus");
    expect(getAgent(devId)!.instruction).toBe("write better code");

    // qa removed both from Maps and config tables
    const qaId = namespacedAgentId("alpha", "qa");
    expect(getAgent(qaId)).toBeUndefined();
    const qaRow = db.prepare("SELECT id FROM agents WHERE id = ?").get(qaId);
    expect(qaRow).toBeNull();
    const qaMember = db.prepare("SELECT id FROM team_agents WHERE agent_id = ?").get(qaId);
    expect(qaMember).toBeNull();

    // team still has skipper + dev only
    const team = getTeam("alpha")!;
    expect(team.members.map((m) => m.agent_id).sort()).toEqual(["alpha:dev", "skipper"]);
  });

  it("delete removes the team from persistence and shared state", () => {
    createLocalTeam(db, baseInput());
    const devId = namespacedAgentId("alpha", "dev");
    expect(deleteLocalTeam(db, "alpha")).toBe(true);

    expect(getLocalTeam(db, "alpha")).toBeNull();
    expect(getTeam("alpha")).toBeUndefined();
    expect(getAgent(devId)).toBeUndefined();
    const teamRow = db.prepare("SELECT id FROM teams WHERE id = ?").get("alpha");
    expect(teamRow).toBeNull();
    const memberRows = db.prepare("SELECT id FROM team_agents WHERE team_id = ?").all("alpha");
    expect(memberRows.length).toBe(0);
  });

  it("validation rejects empty name, empty phases, bad type, dup ids, and skipper id", () => {
    expect(() => createLocalTeam(db, { ...baseInput(), name: "" })).toThrow();
    expect(() => createLocalTeam(db, { ...baseInput(), phases: [] })).toThrow();
    expect(() =>
      createLocalTeam(db, { ...baseInput(), agents: [{ id: "x", name: "X", type: "nope-type", model: "default" }] }),
    ).toThrow();
    expect(() =>
      createLocalTeam(db, {
        ...baseInput(),
        agents: [
          { id: "dup", name: "A", type: pickAgentType(), model: "default" },
          { id: "dup", name: "B", type: pickAgentType(), model: "default" },
        ],
      }),
    ).toThrow();
    expect(() =>
      createLocalTeam(db, { ...baseInput(), agents: [{ id: "skipper", name: "S", type: pickAgentType(), model: "default" }] }),
    ).toThrow();
  });
});
