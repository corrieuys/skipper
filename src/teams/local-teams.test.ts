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
  isRealtimeTeam,
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
    { id: "dev", name: "Dev", type: pickAgentType(), model: "default", instruction: "write code", role: "worker", level: 1 },
    { id: "qa", name: "QA", type: pickAgentType(), model: "sonnet", instruction: "test code", role: "worker", level: 2 },
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

    // Membership is flat: every inline agent joins at level 1 under no parent.
    const team = getTeam("alpha")!;
    const devMember = team.members.find((m) => m.agent_id === devId)!;
    const qaMember = team.members.find((m) => m.agent_id === qaId)!;
    expect(devMember.level).toBe(1);
    expect(qaMember.level).toBe(1);
    expect(Object.keys(devMember)).not.toContain("parent_agent_id");
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
        { id: "dev", name: "Dev", type: pickAgentType(), model: "opus", instruction: "write better code", role: "worker", level: 1 },
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

describe("real-time team mode", () => {
  const realtimeInput = (): LocalTeamInput => ({
    id: "rt",
    name: "Voice Room",
    phases: [], // realtime teams carry no phases
    agents: [],
    config: {
      mode: "realtime",
      realtime: { summaryEnabled: true, summaryProvider: "claude-code", summaryModel: "claude-sonnet-4-6" },
    },
  });

  it("allows creating a realtime team with no phases", () => {
    const team = createLocalTeam(db, realtimeInput());
    expect(team.config.mode).toBe("realtime");
    expect(team.phases.length).toBe(0);
    expect(isRealtimeTeam(team)).toBe(true);
  });

  it("still requires >=1 phase for a regular team", () => {
    expect(() => createLocalTeam(db, { ...realtimeInput(), config: { mode: "regular" } })).toThrow();
    // absent mode defaults to regular -> phase required
    expect(() => createLocalTeam(db, { id: "r2", name: "R2", phases: [], agents: [] })).toThrow();
  });

  it("round-trips mode + summary config through the JSON blob", () => {
    createLocalTeam(db, realtimeInput());
    const rt = getLocalTeam(db, "rt")!.config.realtime!;
    expect(rt.summaryEnabled).toBe(true);
    expect(rt.summaryProvider).toBe("claude-code");
    expect(rt.summaryModel).toBe("claude-sonnet-4-6");
  });

  it("can toggle a regular team into realtime mode on update", () => {
    createLocalTeam(db, baseInput());
    expect(isRealtimeTeam(getLocalTeam(db, "alpha"))).toBe(false);
    // switching to realtime no longer needs phases
    const updated = updateLocalTeam(db, "alpha", { ...baseInput(), phases: [], config: { mode: "realtime" } });
    expect(isRealtimeTeam(updated)).toBe(true);
  });
});

describe("headless CLI agent references (live members)", () => {
  it("resolves a single:<id> member to the record's provider/model/prompt at flatten", () => {
    const { createSingleAgent, singleAgentRefType } = require("../single-agents/store");
    const sa = createSingleAgent(db, {
      name: "Researcher",
      agent_type: "claude-code",
      model: "claude-opus-5",
      instruction: "RESEARCH PROMPT",
      capabilities: ["web"],
      config: { customTools: [] },
    });
    createLocalTeam(db, {
      id: "reft",
      name: "Ref Team",
      phases: [{ name: "work", prompt: "do" }],
      agents: [{ id: "r1", name: "Researcher", type: singleAgentRefType(sa.id) }],
    });
    const shared = getAgent(namespacedAgentId("reft", "r1"));
    expect(shared?.type).toBe("claude-code");
    expect(shared?.model).toBe("claude-opus-5");
    expect(shared?.instruction).toBe("RESEARCH PROMPT");
    expect(shared?.capabilities).toEqual(["web"]);
  });

  it("propagates a record edit to referencing teams (live, not a snapshot)", () => {
    const { createSingleAgent, updateSingleAgent, singleAgentRefType } = require("../single-agents/store");
    const { reflattenTeamsReferencingAgentType } = require("./local-teams");
    const sa = createSingleAgent(db, { name: "R", agent_type: "claude-code", model: "claude-opus-5", instruction: "OLD" });
    createLocalTeam(db, {
      id: "reft",
      name: "Ref Team",
      phases: [{ name: "work", prompt: "do" }],
      agents: [{ id: "r1", name: "R", type: singleAgentRefType(sa.id) }],
    });
    updateSingleAgent(db, sa.id, { name: "R", agent_type: "claude-code", model: "claude-sonnet-5", instruction: "NEW" });
    reflattenTeamsReferencingAgentType(db, singleAgentRefType(sa.id));
    const shared = getAgent(namespacedAgentId("reft", "r1"));
    expect(shared?.model).toBe("claude-sonnet-5");
    expect(shared?.instruction).toBe("NEW");
  });

  it("teamsReferencingAgentType lists teams using the ref, and rejects a save with a dangling ref", () => {
    const { createSingleAgent, singleAgentRefType } = require("../single-agents/store");
    const { teamsReferencingAgentType } = require("./local-teams");
    const sa = createSingleAgent(db, { name: "R", agent_type: "claude-code", model: "default", instruction: "" });
    createLocalTeam(db, {
      id: "reft",
      name: "Ref Team",
      phases: [{ name: "work", prompt: "do" }],
      agents: [{ id: "r1", name: "R", type: singleAgentRefType(sa.id) }],
    });
    expect(teamsReferencingAgentType(db, singleAgentRefType(sa.id))).toEqual(["Ref Team"]);
    // a ref to a non-existent record is rejected on save
    expect(() => createLocalTeam(db, {
      id: "bad",
      name: "Bad",
      phases: [{ name: "work", prompt: "do" }],
      agents: [{ id: "x", name: "X", type: "single:nope" }],
    })).toThrow();
  });
});
