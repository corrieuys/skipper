import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { clearAgentTypeCache } from "../agents/types";
import { getAgent, resetConfigStore } from "../config/store";
import { eventBus } from "../events/bus";
import { createLocalTeam, getLocalTeam, namespacedAgentId, updateLocalTeam } from "../teams/local-teams";
import { createSingleAgent, getSingleAgent, singleAgentRefType } from "../single-agents/store";
import { createCustomAgent, customAgentTypeName, getCustomAgent } from "../custom-agents/store";
import { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import {
  approveImprovement,
  editImprovement,
  getImprovement,
  improvementState,
  listImprovements,
  readLiveTarget,
  rejectImprovement,
  stageImprovement,
  setImprovementsAutoApprove,
  stageSkillSuggestion,
  submitImprovement,
  textRevision,
  type ImprovementTarget,
} from "./manager";

let db: Database;
const events: Array<{ name: string; payload: unknown }> = [];
const off: Array<() => void> = [];

function listen(name: "improvement:changed" | "team:changed" | "recurring:changed"): void {
  const fn = (payload: unknown) => events.push({ name, payload });
  eventBus.on(name, fn as never);
  off.push(() => eventBus.off(name, fn as never));
}

function makeTeam(): void {
  createLocalTeam(db, {
    id: "alpha",
    name: "Alpha",
    skipper_prompt: "lead well",
    phases: [
      { name: "plan", prompt: "Write a plan." },
      { name: "build", prompt: "Build it.\nRun the tests." },
    ],
    agents: [{ id: "dev", name: "Dev", type: "claude-code", model: "default", instruction: "write code" }],
  });
}

const PHASE: ImprovementTarget = { kind: "phase_prompt", teamId: "alpha", phaseIndex: 1, phaseName: "build" };

function stagePhase(text: string) {
  const live = readLiveTarget(db, PHASE)!;
  return stageImprovement(db, { target: PHASE, proposedText: text, revision: live.revision, reason: "evidence" });
}

beforeEach(() => {
  resetConfigStore();
  clearAgentTypeCache();
  db = new Database(":memory:");
  initializeDatabase(db);
  makeTeam();
  events.length = 0;
  listen("improvement:changed");
  listen("team:changed");
  listen("recurring:changed");
});

afterEach(() => {
  for (const f of off.splice(0)) f();
  db.close();
  resetConfigStore();
});

describe("staging", () => {
  it("stores the proposal without touching the team, and emits improvement:changed", () => {
    const imp = stagePhase("Build it.\nRun the tests.\nReport coverage.");
    expect(imp.status).toBe("pending");
    expect(imp.before_text).toBe("Build it.\nRun the tests.");
    expect(imp.base_revision).toBe(textRevision("Build it.\nRun the tests."));
    expect(imp.target_label).toBe('Team "Alpha" › Phase 2 "build"');
    expect(getLocalTeam(db, "alpha")!.phases[1]!.prompt).toBe("Build it.\nRun the tests.");
    expect(events).toEqual([{ name: "improvement:changed", payload: { improvementId: imp.id, change: "created" } }]);
  });

  it("refuses a stale revision, a no-op and a phase name that does not match the index", () => {
    expect(() => stageImprovement(db, { target: PHASE, proposedText: "x", revision: "nope", reason: "r" })).toThrow(/changed since you read it/);
    expect(() => stagePhase("Build it.\nRun the tests.")).toThrow(/same as the current text/);
    const wrong: ImprovementTarget = { kind: "phase_prompt", teamId: "alpha", phaseIndex: 1, phaseName: "plan" };
    expect(() => stageImprovement(db, { target: wrong, proposedText: "x", revision: "r", reason: "r" })).toThrow(/Target not found/);
  });

  it("refuses a team that comes from a remote repository", () => {
    db.prepare("INSERT INTO remote_team_links (team_id, repo_id, source_path) VALUES ('alpha', 'r1', 'teams/alpha.json')").run();
    expect(() => stagePhase("new")).toThrow(/remote repository/);
  });
});

describe("several proposals on one target", () => {
  it("allows both; approving one puts the other in conflict until an edit rebases it", () => {
    const first = stagePhase("Build it.\nRun ALL the tests.");
    const second = stagePhase("Build it.\nRun the tests.\nWrite a summary.");
    expect(listImprovements(db, { status: "pending" }).length).toBe(2);
    expect(improvementState(db, first).state).toBe("ready");
    expect(improvementState(db, second).state).toBe("ready");

    approveImprovement(db, first.id);
    expect(getLocalTeam(db, "alpha")!.phases[1]!.prompt).toBe("Build it.\nRun ALL the tests.");
    expect(events.some((e) => e.name === "team:changed")).toBe(true);
    expect(getImprovement(db, first.id)!.status).toBe("approved");

    const stale = getImprovement(db, second.id)!;
    expect(improvementState(db, stale).state).toBe("conflict");
    expect(() => approveImprovement(db, second.id)).toThrow(/live text changed/);

    const merged = editImprovement(db, second.id, "Build it.\nRun ALL the tests.\nWrite a summary.");
    expect(merged.before_text).toBe("Build it.\nRun ALL the tests.");
    expect(merged.edited_at).not.toBeNull();
    expect(improvementState(db, merged).state).toBe("ready");
    approveImprovement(db, second.id);
    expect(getLocalTeam(db, "alpha")!.phases[1]!.prompt).toBe("Build it.\nRun ALL the tests.\nWrite a summary.");
  });

  it("a manual team edit also puts a pending proposal in conflict", () => {
    const imp = stagePhase("changed");
    const team = getLocalTeam(db, "alpha")!;
    updateLocalTeam(db, "alpha", { ...team, phases: team.phases.map((p, i) => (i === 1 ? { ...p, prompt: "edited by hand" } : p)) });
    expect(improvementState(db, getImprovement(db, imp.id)!).state).toBe("conflict");
  });

  it("marks the target missing when the phase is renamed", () => {
    const imp = stagePhase("changed");
    const team = getLocalTeam(db, "alpha")!;
    updateLocalTeam(db, "alpha", { ...team, phases: team.phases.map((p, i) => (i === 1 ? { ...p, name: "implement" } : p)) });
    expect(improvementState(db, getImprovement(db, imp.id)!).state).toBe("missing");
    expect(() => approveImprovement(db, imp.id)).toThrow(/no longer exists/);
    expect(rejectImprovement(db, imp.id).status).toBe("rejected");
  });
});

describe("targets", () => {
  it("inline agent instruction and lead instructions write the team", () => {
    const agent: ImprovementTarget = { kind: "agent_instruction", teamId: "alpha", agentRef: "dev" };
    const a = stageImprovement(db, { target: agent, proposedText: "write tested code", revision: textRevision("write code"), reason: "r" });
    approveImprovement(db, a.id);
    expect(getLocalTeam(db, "alpha")!.agents[0]!.instruction).toBe("write tested code");
    expect(getAgent(namespacedAgentId("alpha", "dev"))!.instruction).toBe("write tested code");

    const lead: ImprovementTarget = { kind: "lead_instructions", teamId: "alpha" };
    const l = stageImprovement(db, { target: lead, proposedText: "lead better", revision: textRevision("lead well"), reason: "r" });
    approveImprovement(db, l.id);
    expect(getLocalTeam(db, "alpha")!.skipper_prompt).toBe("lead better");
  });

  it("a library agent's instruction writes the library record and re-projects its teams", () => {
    const sa = createSingleAgent(db, { name: "Researcher", agent_type: "claude-code", model: "default", instruction: "research" });
    const team = getLocalTeam(db, "alpha")!;
    updateLocalTeam(db, "alpha", { ...team, agents: [...team.agents, { id: "r1", name: "Researcher", type: singleAgentRefType(sa.id), model: "" }] });

    const target: ImprovementTarget = { kind: "agent_instruction", teamId: "alpha", agentRef: singleAgentRefType(sa.id) };
    const live = readLiveTarget(db, target)!;
    expect(live.usedByTeams).toBe(1);
    expect(live.key).toBe(`agent:${singleAgentRefType(sa.id)}`);
    const imp = stageImprovement(db, { target, proposedText: "research with sources", revision: live.revision, reason: "r" });
    approveImprovement(db, imp.id);
    expect(getSingleAgent(db, sa.id)!.instruction).toBe("research with sources");
    expect(getAgent(namespacedAgentId("alpha", "r1"))!.instruction).toBe("research with sources");
  });

  it("a custom library agent's system prompt is written and its other settings kept", () => {
    const ca = createCustomAgent(db, {
      name: "Analyst", description: "", baseUrl: "https://api.example.com/v1", modelId: "m", apiKey: "secret",
      headers: {}, queryParams: {}, systemPrompt: "Analyse.", enabledTools: ["read_file"], enabledMcpTools: ["create_note"],
      enabledServerTools: [], enabledCustomTools: [], enabledSkills: [], maxSteps: 10, temperature: null, color: null, character: null,
    });
    const target: ImprovementTarget = { kind: "agent_instruction", teamId: "alpha", agentRef: customAgentTypeName(ca.id) };
    const imp = stageImprovement(db, { target, proposedText: "Analyse with numbers.", revision: textRevision("Analyse."), reason: "r" });
    approveImprovement(db, imp.id);
    const after = getCustomAgent(db, ca.id)!;
    expect(after.systemPrompt).toBe("Analyse with numbers.");
    expect(after.apiKey).toBe("secret");
    expect(after.enabledTools).toEqual(["read_file"]);
  });

  it("a recurring task's description is written while the series stays approved", () => {
    const sched = new ScheduledTaskScheduler(db);
    const rec = sched.createScheduledTask({ title: "Daily", description: "Check the logs.", teamId: "alpha", workingDirectory: "/tmp" });
    sched.approveScheduledTask(rec.id);
    const target: ImprovementTarget = { kind: "recurring_description", scheduledTaskId: rec.id };
    const imp = stageImprovement(db, { target, proposedText: "Check the error logs.", revision: textRevision("Check the logs."), reason: "r" });
    approveImprovement(db, imp.id);
    const after = sched.getScheduledTask(rec.id)!;
    expect(after.description).toBe("Check the error logs.");
    expect(after.status).toBe("approved");
    expect(events.some((e) => e.name === "recurring:changed")).toBe(true);
  });

  it("a skill suggestion is only acknowledged or dismissed", () => {
    const imp = stageSkillSuggestion(db, { teamId: "alpha", skillName: "pdf", agentRef: "dev", agentLabel: "Dev", problem: "p", suggestion: "s" });
    expect(improvementState(db, imp).state).toBe("suggestion");
    const edited = editImprovement(db, imp.id, "better s");
    expect(edited.proposed_text).toBe("better s");
    expect(approveImprovement(db, imp.id).status).toBe("approved");
    expect(() => rejectImprovement(db, imp.id)).toThrow(/already approved/);
  });
});

describe("auto-approve", () => {
  it("off: submit only stages; on: it applies at once, and a skill suggestion still waits", () => {
    const live = () => readLiveTarget(db, PHASE)!;
    const staged = submitImprovement(db, { target: PHASE, proposedText: "one", revision: live().revision, reason: "r" });
    expect(staged.applied).toBe(false);
    expect(staged.improvement.status).toBe("pending");

    setImprovementsAutoApprove(db, true);
    const applied = submitImprovement(db, { target: PHASE, proposedText: "two", revision: live().revision, reason: "r" });
    expect(applied.applied).toBe(true);
    expect(applied.improvement.status).toBe("approved");
    expect(getLocalTeam(db, "alpha")!.phases[1]!.prompt).toBe("two");
    // The earlier staged one is now in conflict with the applied text.
    expect(improvementState(db, getImprovement(db, staged.improvement.id)!).state).toBe("conflict");

    const skill = stageSkillSuggestion(db, { teamId: "alpha", skillName: "pdf", problem: "p", suggestion: "s" });
    expect(skill.status).toBe("pending");
  });
});
