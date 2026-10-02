import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { clearAgentTypeCache } from "../agents/types";
import { resetConfigStore } from "../config/store";
import { eventBus } from "../events/bus";
import { createLocalTeam, getLocalTeam, updateLocalTeam } from "../teams/local-teams";
import { createSingleAgent, getSingleAgent, singleAgentRefType, updateSingleAgent } from "../single-agents/store";
import {
  readLiveTarget,
  stageImprovement,
  stageSkillSuggestion,
  type ImprovementTarget,
} from "../improvements/manager";
import { handleImprovementsRequest, type ImprovementDetailItem, type ImprovementSummaryItem } from "./improvements";
import { handleResourceRequest, type ResourceDeps } from "./resources";
import { subscribeConnectEvents } from "./events";

const origArgv = [...process.argv];

interface Frame {
  event: string;
  payload: Record<string, unknown>;
}

let frames: Frame[];
let cleanup: (() => void) | null;

const PHASE: ImprovementTarget = { kind: "phase_prompt", teamId: "alpha", phaseIndex: 1, phaseName: "build" };

function stagePhase(text: string, reason = "evidence") {
  const db = getDb();
  const live = readLiveTarget(db, PHASE)!;
  return stageImprovement(db, { target: PHASE, proposedText: text, revision: live.revision, reason });
}

function req(action: string, params: Record<string, unknown> = {}) {
  return handleImprovementsRequest(getDb(), action, params);
}

function data<T>(result: ReturnType<typeof req>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data as T;
}

beforeEach(() => {
  process.argv = [...origArgv, "--experimental"];
  resetConfigStore();
  clearAgentTypeCache();
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);
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
  frames = [];
  cleanup = null;
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  process.argv = [...origArgv];
  resetDb();
  resetConfigStore();
});

describe("improvements resource", () => {
  it("refuses every action without --experimental", () => {
    process.argv = origArgv.filter((a) => a !== "--experimental");
    expect(req("list")).toEqual({ ok: false, error: "Improvements require the daemon --experimental flag" });
  });

  it("list returns text-free summaries, pending by default, newest first", () => {
    const first = stagePhase("Build it.\nRun the tests.\nReport coverage.", "r".repeat(400));
    const second = stagePhase("Build it.");
    const rows = data<ImprovementSummaryItem[]>(req("list"));
    expect(rows.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(rows[1]).toMatchObject({
      kind: "phase_prompt",
      status: "pending",
      state: "ready",
      teamId: "alpha",
      teamName: "Alpha",
      phaseIndex: 1,
      phaseName: "build",
      usedByTeams: null,
    });
    expect(rows[1]!.reason.length).toBe(280);
    expect(rows[1]!.liveRevision).toBe(rows[1]!.baseRevision);
    expect(rows[1]).not.toContainKeys(["proposedText", "beforeText", "liveText", "diff"]);
  });

  it("read returns the detail with a live diff; approve replies decided with a before diff", () => {
    const imp = stagePhase("Build it.\nRun the tests.\nReport coverage.");
    const detail = data<ImprovementDetailItem>(req("read", { id: imp.id }));
    expect(detail.diffBase).toBe("live");
    expect(detail.liveText).toBe("Build it.\nRun the tests.");
    expect(detail.diff).toEqual([
      { op: "same", text: "Build it." },
      { op: "same", text: "Run the tests." },
      { op: "add", text: "Report coverage." },
    ]);

    const approved = data<ImprovementDetailItem>(req("approve", { id: imp.id }));
    expect(approved).toMatchObject({ status: "approved", state: "decided", diffBase: "before", liveText: null, liveRevision: null });
    expect(approved.diff!.filter((d) => d.op === "add").map((d) => d.text)).toEqual(["Report coverage."]);
    expect(getLocalTeam(getDb(), "alpha")!.phases[1]!.prompt).toBe("Build it.\nRun the tests.\nReport coverage.");
  });

  it("a conflicting approve errors; edit rebases it, then approve applies", () => {
    const a = stagePhase("Build it well.\nRun the tests.");
    const b = stagePhase("Build it.\nRun all the tests.");
    data(req("approve", { id: a.id }));
    expect(data<ImprovementDetailItem>(req("read", { id: b.id })).state).toBe("conflict");
    const refused = req("approve", { id: b.id });
    expect(refused.ok).toBe(false);

    const edited = data<ImprovementDetailItem>(req("edit", { id: b.id, text: "Build it well.\nRun all the tests." }));
    expect(edited.state).toBe("ready");
    expect(edited.editedAt).not.toBeNull();
    data(req("approve", { id: b.id }));
    expect(getLocalTeam(getDb(), "alpha")!.phases[1]!.prompt).toBe("Build it well.\nRun all the tests.");
  });

  it("list decided / all, reject, and skill suggestions carry no diff", () => {
    const a = stagePhase("Build it.");
    const skill = stageSkillSuggestion(getDb(), { teamId: "alpha", skillName: "deploy", problem: "wrong path", suggestion: "use ./bin" });
    data(req("reject", { id: a.id }));
    expect(data<ImprovementSummaryItem[]>(req("list", { status: "decided" })).map((r) => r.id)).toEqual([a.id]);
    expect(data<ImprovementSummaryItem[]>(req("list", { status: "all" }))).toHaveLength(2);

    const detail = data<ImprovementDetailItem>(req("read", { id: skill.id }));
    expect(detail).toMatchObject({ state: "suggestion", diff: null, diffBase: null, baseRevision: null, proposedText: "use ./bin" });
    expect(data<ImprovementDetailItem>(req("approve", { id: skill.id })).status).toBe("approved");
  });

  it("settings round-trip and require `on`", () => {
    expect(data(req("settings"))).toEqual({ autoApprove: false, enabled: true });
    expect(data(req("set-auto-approve", { on: true }))).toEqual({ autoApprove: true });
    expect(data(req("settings"))).toEqual({ autoApprove: true, enabled: true });
    expect(req("set-auto-approve", {})).toEqual({ ok: false, error: "on is required" });
  });

  it("is reachable through handleResourceRequest and counted in the snapshot", async () => {
    stagePhase("Build it.");
    const deps = {} as unknown as ResourceDeps;
    const listed = await handleResourceRequest("improvements", "list", {}, deps);
    expect(listed.ok).toBe(true);
    const snap = await handleResourceRequest("state", "snapshot", {}, deps);
    const snapshot = (snap as { ok: true; data: { features: string[]; counts: Record<string, number> } }).data;
    expect(snapshot.features).toContain("improvements");
    expect(snapshot.counts.pendingImprovements).toBe(1);
  });
});

describe("improvement fat events", () => {
  function capture(frame: string): void {
    const f = JSON.parse(frame) as Frame;
    frames.push({ event: f.event, payload: f.payload });
  }

  it("capabilities list improvements under --experimental only", () => {
    cleanup = subscribeConnectEvents(capture);
    expect(frames[0]!.payload.features).toContain("improvements");
    cleanup();
    process.argv = origArgv.filter((a) => a !== "--experimental");
    frames = [];
    cleanup = subscribeConnectEvents(capture);
    expect(frames[0]!.payload.features).not.toContain("improvements");
  });

  it("improvement:changed carries the summary and the other pending rows on the target", () => {
    const a = stagePhase("Build it well.\nRun the tests.");
    const b = stagePhase("Build it.\nRun all the tests.");
    cleanup = subscribeConnectEvents(capture);
    frames = [];
    data(req("approve", { id: a.id }));
    const changed = frames.find((f) => f.event === "improvement:changed")!;
    expect((changed.payload.improvement as ImprovementSummaryItem)).toMatchObject({ id: a.id, status: "approved", state: "decided" });
    expect(changed.payload.siblings).toEqual([expect.objectContaining({ id: b.id, state: "conflict" })]);
  });

  it("team:changed carries the scoped pending summaries, also on delete", () => {
    const a = stagePhase("Build it.");
    cleanup = subscribeConnectEvents(capture);
    frames = [];
    const db = getDb();
    const team = getLocalTeam(db, "alpha")!;
    updateLocalTeam(db, "alpha", {
      id: team.id,
      name: team.name,
      skipper_prompt: team.skipper_prompt,
      hooks: team.hooks,
      phases: team.phases.map((p, i) => (i === 1 ? { ...p, prompt: "Changed by hand." } : p)),
      agents: team.agents,
      config: team.config,
    });
    const teamEvent = frames.find((f) => f.event === "team:changed")!;
    expect(teamEvent.payload.team).toBeTruthy();
    expect(teamEvent.payload.improvements).toEqual([expect.objectContaining({ id: a.id, state: "conflict" })]);

    frames = [];
    eventBus.emit("team:changed", { teamId: "alpha", change: "deleted" });
    const deleted = frames.find((f) => f.event === "team:changed")!;
    expect(deleted.payload.team).toBeUndefined();
    expect(deleted.payload.improvements).toHaveLength(1);
  });

  it("a library agent edit emits library_agent:changed with its pending summaries", () => {
    const db = getDb();
    const sa = createSingleAgent(db, { name: "Writer", agent_type: "claude-code", instruction: "write" });
    const ref = singleAgentRefType(sa.id);
    const target: ImprovementTarget = { kind: "agent_instruction", teamId: "alpha", agentRef: ref };
    const imp = stageImprovement(db, { target, proposedText: "write clearly", revision: readLiveTarget(db, target)!.revision, reason: "vague" });

    cleanup = subscribeConnectEvents(capture);
    frames = [];
    const rec = getSingleAgent(db, sa.id)!;
    updateSingleAgent(db, sa.id, { name: rec.name, agent_type: rec.agent_type, model: rec.model, instruction: "write tersely", capabilities: rec.capabilities, config: rec.config });
    const ev = frames.find((f) => f.event === "library_agent:changed")!;
    expect(ev.payload).toMatchObject({ agentType: ref, change: "updated" });
    expect(ev.payload.improvements).toEqual([expect.objectContaining({ id: imp.id, state: "conflict" })]);
  });

  it("the auto-approve switch is forwarded", () => {
    cleanup = subscribeConnectEvents(capture);
    frames = [];
    data(req("set-auto-approve", { on: true }));
    expect(frames.find((f) => f.event === "improvements:settings_changed")!.payload).toEqual({ autoApprove: true, enabled: true });
  });
});
