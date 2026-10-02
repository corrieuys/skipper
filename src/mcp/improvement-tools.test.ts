import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { clearAgentTypeCache } from "../agents/types";
import { resetConfigStore } from "../config/store";
import { createLocalTeam, getLocalTeam } from "../teams/local-teams";
import { TaskScheduler } from "../tasks/scheduler";
import { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import { listImprovements, setImprovementsAutoApprove, setImprovementsEnabled } from "../improvements/manager";
import { registerImprovementTools } from "./improvement-tools";
import type { InternalAgentIdentity } from "./auth";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

let db: Database;

function register(taskId: string): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  const server = {
    tool: (name: string, ...rest: unknown[]) => {
      tools.set(name, rest[rest.length - 1] as Handler);
    },
  };
  const identity: InternalAgentIdentity = { type: "internal", runtimeId: "rt", templateAgentId: "skipper", taskId };
  registerImprovementTools(server as never, db, () => identity);
  return tools;
}

async function call(tools: Map<string, Handler>, name: string, args: Record<string, unknown> = {}) {
  const res = await tools.get(name)!(args);
  const text = res.content[0]!.text;
  return text.startsWith("Error:") ? { error: text } : JSON.parse(text);
}

function makeTeam(id: string): void {
  createLocalTeam(db, {
    id,
    name: id,
    skipper_prompt: "lead",
    phases: [{ name: "plan", prompt: "Plan it." }],
    agents: [{ id: "dev", name: "Dev", type: "claude-code", model: "default", instruction: "code" }],
  });
}

function makeTask(teamId: string, recurring = false): string {
  const scheduler = new TaskScheduler(db);
  const task = scheduler.createTask({ title: "run", teamId, workingDirectory: "/tmp" });
  if (recurring) {
    const sched = new ScheduledTaskScheduler(db);
    const rec = sched.createScheduledTask({ title: "Daily", description: "Do the daily thing.", teamId, workingDirectory: "/tmp" });
    db.prepare("UPDATE tasks SET source_scheduled_task_id = ? WHERE id = ?").run(rec.id, task.id);
  }
  return task.id;
}

beforeEach(() => {
  resetConfigStore();
  clearAgentTypeCache();
  db = new Database(":memory:");
  initializeDatabase(db);
  makeTeam("alpha");
});

afterEach(() => {
  db.close();
  resetConfigStore();
});

describe("registration", () => {
  it("a local team gets the team tools; a recurring run adds the description tool", () => {
    expect([...register(makeTask("alpha")).keys()].sort()).toEqual(
      ["get_team_config", "list_improvements", "propose_agent_instruction", "propose_phase_prompt", "propose_skill_change"],
    );
    expect([...register(makeTask("alpha", true)).keys()]).toContain("propose_recurring_description");
  });

  it("a remote team gets no team tools; its recurring run keeps the description tool", () => {
    makeTeam("remote-x");
    db.prepare("INSERT INTO remote_team_links (team_id, repo_id, source_path) VALUES ('remote-x', 'r', 'teams/x.json')").run();
    expect([...register(makeTask("remote-x")).keys()]).toEqual([]);
    const names = [...register(makeTask("remote-x", true)).keys()];
    expect(names).toContain("propose_recurring_description");
    expect(names).not.toContain("propose_phase_prompt");
    expect(names).not.toContain("propose_agent_instruction");
  });
});

describe("improvements switched off", () => {
  it("registers no tools, and a session opened before the switch is refused", async () => {
    const taskId = makeTask("alpha", true);
    const before = register(taskId);
    setImprovementsEnabled(db, false);
    expect([...register(taskId).keys()]).toEqual([]);
    expect(await call(before, "get_team_config")).toEqual({ error: "Error: Improvements are turned off. Do not stage changes." });
    setImprovementsEnabled(db, true);
    expect([...register(taskId).keys()]).toContain("propose_phase_prompt");
  });
});

describe("tools", () => {
  it("stages from get_team_config revisions without changing the team, and lists what is pending", async () => {
    const tools = register(makeTask("alpha", true));
    const config = await call(tools, "get_team_config");
    expect(config.phases[0]).toMatchObject({ index: 0, name: "plan", prompt: "Plan it." });
    expect(config.agents[0]).toMatchObject({ agent_id: "dev", instruction: "code" });
    expect(config.lead_instructions.text).toBe("lead");
    expect(config.recurring_task.description).toBe("Do the daily thing.");

    const staged = await call(tools, "propose_phase_prompt", {
      phase_index: 0, phase_name: "plan", prompt: "Plan it. List risks.", revision: config.phases[0].revision, reason: "risks were missed",
    });
    expect(staged.status).toBe("staged");
    expect(staged.note).toMatch(/not applied/i);
    expect(getLocalTeam(db, "alpha")!.phases[0]!.prompt).toBe("Plan it.");

    // A second proposal on the same target is allowed.
    const again = await call(tools, "propose_phase_prompt", {
      phase_index: 0, phase_name: "plan", prompt: "Plan it. Name owners.", revision: config.phases[0].revision, reason: "no owners",
    });
    expect(again.status).toBe("staged");

    await call(tools, "propose_agent_instruction", { agent_id: "skipper", instruction: "lead firmly", revision: config.lead_instructions.revision, reason: "r" });
    await call(tools, "propose_recurring_description", { description: "Do the daily thing by 9am.", revision: config.recurring_task.revision, reason: "r" });

    const pending = await call(tools, "list_improvements");
    expect(pending.length).toBe(4);
    expect(pending.every((p: { status: string; conflict: boolean }) => p.status === "pending" && p.conflict === false)).toBe(true);
    expect(listImprovements(db, { status: "pending" }).map((i) => i.kind).sort()).toEqual(
      ["lead_instructions", "phase_prompt", "phase_prompt", "recurring_description"],
    );
  });

  it("refuses an unknown agent and a stale revision", async () => {
    const tools = register(makeTask("alpha"));
    expect((await call(tools, "propose_agent_instruction", { agent_id: "ghost", instruction: "x", revision: "r", reason: "r" })).error).toMatch(/no team member/);
    expect((await call(tools, "propose_agent_instruction", { agent_id: "dev", instruction: "x", revision: "old", reason: "r" })).error).toMatch(/changed since you read it/);
  });

  it("reports applied when auto-approve is on", async () => {
    setImprovementsAutoApprove(db, true);
    const tools = register(makeTask("alpha"));
    const config = await call(tools, "get_team_config");
    const res = await call(tools, "propose_agent_instruction", { agent_id: "dev", instruction: "code with tests", revision: config.agents[0].revision, reason: "r" });
    expect(res.status).toBe("applied");
    expect(getLocalTeam(db, "alpha")!.agents[0]!.instruction).toBe("code with tests");
  });
});
