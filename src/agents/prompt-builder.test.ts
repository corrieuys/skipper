import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { PromptBuilder } from "./prompt-builder";
import { clearAgentTypeCache } from "./types";
import { unlinkSync } from "fs";

const TEST_DB = "test-prompt-builder.db";

let db: Database;
let builder: PromptBuilder;

beforeEach(() => {
  clearAgentTypeCache();
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  builder = new PromptBuilder(db);
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

// Helper: create an agent and return its id
function createAgent(name: string, type = "claude-code", instruction?: string): string {
  const id = crypto.randomUUID();
  const config = instruction ? JSON.stringify({ instruction }) : "{}";
  db.prepare(
    "INSERT INTO agents (id, name, type, config, capabilities) VALUES (?, ?, ?, ?, '[]')",
  ).run(id, name, type, config);
  return id;
}

// Helper: create a team, add agents, return team id
function createTeamWithAgents(
  agents: { id: string; role?: string; capabilities?: string[]; level?: number }[],
): string {
  const teamId = crypto.randomUUID();
  db.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run(teamId, "Test Team");

  for (const agent of agents) {
    if (agent.capabilities) {
      db.prepare("UPDATE agents SET capabilities = ? WHERE id = ?")
        .run(JSON.stringify(agent.capabilities), agent.id);
    }
    const taId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES (?, ?, ?, ?, ?)",
    ).run(taId, teamId, agent.id, agent.role ?? null, agent.level ?? 0);
  }

  return teamId;
}

// Helper: add a task note
function addTaskNote(taskId: string, agentId: string, content: string): void {
  const noteId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO task_notes (id, task_id, agent_id, content) VALUES (?, ?, ?, ?)",
  ).run(noteId, taskId, agentId, content);
}

describe("buildInitialPrompt", () => {
  it("builds a simple task prompt without phases", () => {
    const agentId = createAgent("Dev Agent", "claude-code", "Build great software");
    const prompt = builder.buildInitialPrompt({
      agent: { id: agentId, name: "Dev Agent", type: "claude-code", instruction: "Build great software" },
      task: { id: "task-1", title: "Implement login", description: "Add user authentication" },
      isStreaming: true,
    });

    expect(prompt).toContain("INSTRUCTION: Build great software");
    expect(prompt).toContain("TASK: Implement login");
    expect(prompt).toContain("Add user authentication");
    expect(prompt).toContain("[PHASE_COMPLETE]");
    expect(prompt).toContain("When you have completed this task");
  });

  it("builds a phased task prompt", () => {
    const agentId = createAgent("Dev Agent", "claude-code", "Build software");
    const prompt = builder.buildInitialPrompt({
      agent: { id: agentId, name: "Dev Agent", type: "claude-code", instruction: "Build software" },
      task: { id: "task-1", title: "Build feature", description: "Full feature" },
      phase: { name: "Planning", prompt: "Create a plan", index: 0, total: 3 },
      isStreaming: true,
    });

    expect(prompt).toContain("CURRENT PHASE (1/3): Planning");
    expect(prompt).toContain("Create a plan");
    expect(prompt).toContain("When you have completed this phase");
  });

  it("omits PHASE_COMPLETE instruction for non-streaming agents", () => {
    const agentId = createAgent("Dev Agent", "codex");
    const prompt = builder.buildInitialPrompt({
      agent: { id: agentId, name: "Dev Agent", type: "codex" },
      task: { id: "task-1", title: "Do work" },
      isStreaming: false,
    });

    expect(prompt).not.toContain("[PHASE_COMPLETE]");
  });

  it("includes regression notice when provided", () => {
    const agentId = createAgent("Dev Agent", "claude-code");
    const prompt = builder.buildInitialPrompt({
      agent: { id: agentId, name: "Dev Agent", type: "claude-code" },
      task: { id: "task-1", title: "Fix bugs" },
      phase: { name: "Implementation", prompt: "Implement the fix", index: 0, total: 2 },
      isStreaming: true,
      regressionReason: "QA found 3 critical bugs",
    });

    expect(prompt).toContain("--- PHASE REGRESSION NOTICE ---");
    expect(prompt).toContain("This phase is being RE-RUN");
    expect(prompt).toContain("Reason: QA found 3 critical bugs");
    expect(prompt).toContain("--- END REGRESSION NOTICE ---");
  });

  it("omits instruction section when agent has no instruction", () => {
    const agentId = createAgent("Dev Agent", "claude-code");
    const prompt = builder.buildInitialPrompt({
      agent: { id: agentId, name: "Dev Agent", type: "claude-code" },
      task: { id: "task-1", title: "Simple task" },
      isStreaming: true,
    });

    expect(prompt).not.toContain("INSTRUCTION:");
  });

  it("omits description when task has none", () => {
    const agentId = createAgent("Dev Agent", "claude-code");
    const prompt = builder.buildInitialPrompt({
      agent: { id: agentId, name: "Dev Agent", type: "claude-code" },
      task: { id: "task-1", title: "Quick task" },
      isStreaming: true,
    });

    expect(prompt).toContain("TASK: Quick task");
    // The line after TASK should be empty (no description)
    const lines = prompt.split("\n");
    const taskLineIdx = lines.findIndex((l) => l === "TASK: Quick task");
    expect(lines[taskLineIdx + 1]).toBe("");
  });
});

describe("buildPromptEnrichment", () => {
  it("includes team roster when agent is in a team", () => {
    const agent1 = createAgent("Dev Agent", "claude-code");
    const agent2 = createAgent("QA Agent", "claude-code");
    createTeamWithAgents([
      { id: agent1, role: "developer", capabilities: ["coding", "testing"] },
      { id: agent2, role: "quality-assurance", capabilities: ["testing", "code-review"] },
    ]);

    const enrichment = builder.buildPromptEnrichment(agent1, "task-1");

    expect(enrichment).toContain("TEAM ROSTER");
    expect(enrichment).toContain(`ID: ${agent1}`);
    expect(enrichment).toContain("Name: Dev Agent");
    expect(enrichment).toContain("Role: developer");
    expect(enrichment).toContain("Skills: coding, testing");
    expect(enrichment).toContain(`ID: ${agent2}`);
    expect(enrichment).toContain("Name: QA Agent");
  });

  it("includes notes from other agents", () => {
    const agent1 = createAgent("Dev Agent", "claude-code");
    const agent2 = createAgent("QA Agent", "claude-code");
    const taskId = "task-1";

    // Create a dummy task
    db.prepare("INSERT INTO teams (id, name) VALUES ('t1', 'Team')").run();
    db.prepare(
      "INSERT INTO tasks (id, title, team_id) VALUES (?, 'Test Task', 't1')",
    ).run(taskId);

    addTaskNote(taskId, agent2, "Config is in /etc/app.conf");

    const enrichment = builder.buildPromptEnrichment(agent1, taskId);

    expect(enrichment).toContain("NOTES FROM OTHER AGENTS:");
    expect(enrichment).toContain("[QA Agent] Config is in /etc/app.conf");
  });

  it("excludes current agent's own notes", () => {
    const agent1 = createAgent("Dev Agent", "claude-code");
    const taskId = "task-1";

    db.prepare("INSERT INTO teams (id, name) VALUES ('t1', 'Team')").run();
    db.prepare(
      "INSERT INTO tasks (id, title, team_id) VALUES (?, 'Test Task', 't1')",
    ).run(taskId);

    addTaskNote(taskId, agent1, "My own note");

    const enrichment = builder.buildPromptEnrichment(agent1, taskId);

    expect(enrichment).not.toContain("My own note");
  });

  it("shows DELEGATE command when other team members exist and agent supports it", () => {
    const agent1 = createAgent("Dev Agent", "claude-code");
    const agent2 = createAgent("QA Agent", "claude-code");
    createTeamWithAgents([
      { id: agent1, role: "developer" },
      { id: agent2, role: "qa" },
    ]);

    const enrichment = builder.buildPromptEnrichment(agent1, "task-1");

    expect(enrichment).toContain("[DELEGATE to:<agent-id>]");
  });

  it("hides DELEGATE when agent is alone in team", () => {
    const agent1 = createAgent("Solo Agent", "claude-code");
    createTeamWithAgents([{ id: agent1, role: "developer" }]);

    const enrichment = builder.buildPromptEnrichment(agent1, "task-1");

    expect(enrichment).not.toContain("[DELEGATE");
  });

  it("hides DELEGATE for custom agents that don't support it", () => {
    const agent1 = createAgent("Custom Agent", "custom");
    const agent2 = createAgent("Other Agent", "claude-code");
    createTeamWithAgents([
      { id: agent1, role: "worker" },
      { id: agent2, role: "helper" },
    ]);

    const enrichment = builder.buildPromptEnrichment(agent1, "task-1");

    expect(enrichment).not.toContain("[DELEGATE");
  });

  it("always includes ESCALATE and NOTE commands", () => {
    const agentId = createAgent("Agent", "claude-code");
    const enrichment = builder.buildPromptEnrichment(agentId, "task-1");

    expect(enrichment).toContain("[ESCALATE]");
    expect(enrichment).toContain("[NOTE]");
  });

  it("handles agent not in any team", () => {
    const agentId = createAgent("Lone Agent", "claude-code");
    const enrichment = builder.buildPromptEnrichment(agentId, "task-1");

    expect(enrichment).not.toContain("TEAM ROSTER");
    expect(enrichment).toContain("AVAILABLE COMMANDS:");
  });
});

describe("buildDelegationPrompt", () => {
  it("builds delegation prompt with full context", () => {
    const parentId = createAgent("Lead Dev", "claude-code", "Lead the project");
    const childId = createAgent("QA Agent", "claude-code", "Ensure quality");
    const taskId = "task-1";

    db.prepare("INSERT INTO teams (id, name) VALUES ('t1', 'Team')").run();
    db.prepare(
      "INSERT INTO tasks (id, title, description, team_id) VALUES (?, 'Build Auth', 'Implement OAuth2', 't1')",
    ).run(taskId);

    createTeamWithAgents([
      { id: parentId, role: "lead", capabilities: ["coding"] },
      { id: childId, role: "qa", capabilities: ["testing"] },
    ]);

    addTaskNote(taskId, parentId, "Using OAuth2 with PKCE");

    const prompt = builder.buildDelegationPrompt({
      childAgent: { id: childId, name: "QA Agent", type: "claude-code", instruction: "Ensure quality" },
      task: { id: taskId, title: "Build Auth", description: "Implement OAuth2" },
      delegationPrompt: "Review the auth implementation for security issues",
    });

    expect(prompt).toContain("ROLE: Ensure quality");
    expect(prompt).toContain("TASK CONTEXT: Build Auth");
    expect(prompt).toContain("Implement OAuth2");
    expect(prompt).toContain("NOTES FROM OTHER AGENTS:");
    expect(prompt).toContain("[Lead Dev] Using OAuth2 with PKCE");
    expect(prompt).toContain("ASSIGNMENT:");
    expect(prompt).toContain("Review the auth implementation for security issues");
    expect(prompt).toContain("TEAM ROSTER");
    expect(prompt).toContain("AVAILABLE COMMANDS:");
  });

  it("omits role when child has no instruction", () => {
    const childId = createAgent("Worker", "claude-code");

    const prompt = builder.buildDelegationPrompt({
      childAgent: { id: childId, name: "Worker", type: "claude-code" },
      task: { id: "task-1", title: "Simple Task" },
      delegationPrompt: "Do this work",
    });

    expect(prompt).not.toContain("ROLE:");
    expect(prompt).toContain("TASK CONTEXT: Simple Task");
    expect(prompt).toContain("ASSIGNMENT:");
    expect(prompt).toContain("Do this work");
  });
});
