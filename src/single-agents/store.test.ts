import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { getTeam, getAgent, resetConfigStore } from "../config/store";
import { TeamManager } from "../teams/manager";
import {
  createSingleAgent,
  updateSingleAgent,
  deleteSingleAgent,
  getSingleAgent,
  listSingleAgents,
  findSingleAgentBySlashCommand,
  isSlackEnabledForSingleAgent,
  getSingleAgentByTeamId,
  singleAgentTeamId,
  singleAgentAgentId,
  isSingleAgentId,
  type SingleAgentInput,
} from "./store";

let db: Database;

const baseInput = (): SingleAgentInput => ({
  id: "researcher",
  name: "Researcher",
  agent_type: "claude-code",
  model: "claude-opus-4-8",
  instruction: "You research topics thoroughly.",
  capabilities: ["research"],
  config: { slackEnabled: true, slashCommand: "/researcher" },
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

describe("single agents persistence + projection", () => {
  it("create persists a row and round-trips", () => {
    createSingleAgent(db, baseInput());
    const list = listSingleAgents(db);
    expect(list.length).toBe(1);
    const sa = getSingleAgent(db, "researcher")!;
    expect(sa.name).toBe("Researcher");
    expect(sa.model).toBe("claude-opus-4-8");
    expect(sa.config.slackEnabled).toBe(true);
    expect(sa.config.slashCommand).toBe("/researcher");
  });

  it("projects a skipper-free team-of-one with the agent as entrypoint", () => {
    createSingleAgent(db, baseInput());
    const team = getTeam(singleAgentTeamId("researcher"));
    expect(team).toBeTruthy();
    expect(team!.entrypoint_agent_id).toBe(singleAgentAgentId("researcher"));
    expect(team!.phases.length).toBe(0);
    // Exactly one member (the agent itself); NO skipper lead.
    expect(team!.members.length).toBe(1);
    expect(team!.members[0]!.agent_id).toBe(singleAgentAgentId("researcher"));
    expect(team!.members.some((m) => m.agent_id === "skipper")).toBe(false);

    const agent = getAgent(singleAgentAgentId("researcher"));
    expect(agent).toBeTruthy();
    expect(agent!.type).toBe("claude-code");
    expect(agent!.model).toBe("claude-opus-4-8");
    expect(agent!.instruction).toBe("You research topics thoroughly.");
  });

  it("round-trips a chosen identity and projects it onto the solo agent", () => {
    createSingleAgent(db, { ...baseInput(), config: { color: "#e0a458", character: "slug" } });
    const sa = getSingleAgent(db, "researcher")!;
    expect(sa.config.color).toBe("#e0a458");
    expect(sa.config.character).toBe("slug");
    // The projected shared agent carries the identity in its config blob.
    const agent = getAgent(singleAgentAgentId("researcher"))!;
    expect(agent.color).toBe("#e0a458");
    expect(agent.character).toBe("slug");
  });

  it("resolves through getTeamForExecution as a runnable team", () => {
    createSingleAgent(db, baseInput());
    const exec = new TeamManager(db).getTeamForExecution(singleAgentTeamId("researcher"));
    expect(exec).toBeTruthy();
    expect(exec!.entrypoint_agent_id).toBe(singleAgentAgentId("researcher"));
  });

  it("update re-projects; delete removes the projection", () => {
    createSingleAgent(db, baseInput());
    updateSingleAgent(db, "researcher", { ...baseInput(), name: "Deep Researcher", model: "claude-sonnet-4-6" });
    expect(getAgent(singleAgentAgentId("researcher"))!.name).toBe("Deep Researcher");
    expect(getAgent(singleAgentAgentId("researcher"))!.model).toBe("claude-sonnet-4-6");

    expect(deleteSingleAgent(db, "researcher")).toBe(true);
    expect(getTeam(singleAgentTeamId("researcher"))).toBeUndefined();
    expect(getAgent(singleAgentAgentId("researcher"))).toBeUndefined();
  });

  it("rejects a bad provider and a missing name", () => {
    expect(() => createSingleAgent(db, { ...baseInput(), agent_type: "no-such-provider" })).toThrow();
    expect(() => createSingleAgent(db, { ...baseInput(), name: "" })).toThrow();
  });

  it("slack + slash-command helpers key off the projected id", () => {
    createSingleAgent(db, baseInput());
    expect(isSingleAgentId(singleAgentTeamId("researcher"))).toBe(true);
    expect(isSingleAgentId("some-team")).toBe(false);
    expect(getSingleAgentByTeamId(db, singleAgentTeamId("researcher"))!.id).toBe("researcher");
    expect(isSlackEnabledForSingleAgent(db, singleAgentTeamId("researcher"))).toBe(true);
    expect(findSingleAgentBySlashCommand(db, "/researcher")!.id).toBe("researcher");
    expect(findSingleAgentBySlashCommand(db, "/nope")).toBeNull();
  });
});
