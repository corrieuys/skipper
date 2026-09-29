import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { startServer } from "../server";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { resetConfigStore } from "../config/store";
import { createLocalTeam, getLocalTeam } from "../teams/local-teams";
import { readLiveTarget, stageImprovement, type ImprovementTarget } from "../improvements/manager";
import { registerImprovementRoutes } from "./improvements";

// The Improvements page end to end: list, approve (card self-swap), the second
// proposal on the same text going into conflict, and an edit resolving it.

let server: Server<unknown>;
let baseUrl: string;
const PHASE: ImprovementTarget = { kind: "phase_prompt", teamId: "alpha", phaseIndex: 0, phaseName: "plan" };

beforeAll(() => {
  process.argv.push("--experimental");
  resetDb();
  resetConfigStore();
  initializeDatabase(getDb(":memory:"));
  createLocalTeam(getDb(), { id: "alpha", name: "Alpha", phases: [{ name: "plan", prompt: "Plan it." }], agents: [] });
  registerImprovementRoutes();
  server = startServer(0);
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  resetDb();
  resetConfigStore();
  const i = process.argv.indexOf("--experimental");
  if (i >= 0) process.argv.splice(i, 1);
});

function stage(text: string) {
  const live = readLiveTarget(getDb(), PHASE)!;
  return stageImprovement(getDb(), { target: PHASE, proposedText: text, revision: live.revision, reason: "evidence" });
}

function post(path: string, form?: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "HX-Request": "true" },
    body: new URLSearchParams(form ?? {}).toString(),
  });
}

describe("Improvements page", () => {
  it("approves, flags the sibling as a conflict, and an edit resolves it", async () => {
    const first = stage("Plan it. List risks.");
    const second = stage("Plan it. Name owners.");

    const page = await (await fetch(`${baseUrl}/improvements`)).text();
    expect(page).toContain(`id="imp-${first.id}"`);
    expect(page).toContain(`id="imp-${second.id}"`);

    const approved = await (await post(`/api/improvements/${first.id}/approve`)).text();
    expect(approved).toContain(`id="imp-${first.id}"`);
    expect(approved).toContain("Approved");
    expect(getLocalTeam(getDb(), "alpha")!.phases[0]!.prompt).toBe("Plan it. List risks.");

    const conflict = await (await fetch(`${baseUrl}/fragments/improvements/${second.id}`)).text();
    expect(conflict).toContain("Conflict");
    const refused = await (await post(`/api/improvements/${second.id}/approve`)).text();
    expect(refused).toContain("live text changed");

    const edited = await (await post(`/api/improvements/${second.id}/edit`, { proposed_text: "Plan it. List risks. Name owners." })).text();
    expect(edited).not.toContain("Conflict");
    await post(`/api/improvements/${second.id}/approve`);
    expect(getLocalTeam(getDb(), "alpha")!.phases[0]!.prompt).toBe("Plan it. List risks. Name owners.");
  });

  it("rejects without touching the team", async () => {
    const imp = stage("Plan it badly.");
    const before = getLocalTeam(getDb(), "alpha")!.phases[0]!.prompt;
    const html = await (await post(`/api/improvements/${imp.id}/reject`)).text();
    expect(html).toContain("Rejected");
    expect(getLocalTeam(getDb(), "alpha")!.phases[0]!.prompt).toBe(before);
  });
});
