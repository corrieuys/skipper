import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { PromptBuilder } from "./prompt-builder";
import { ArtifactManager } from "../orchestrator/artifact-manager";
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
  } catch { }
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
  entrypointAgentId?: string,
): string {
  const teamId = crypto.randomUUID();
  db.prepare("INSERT INTO teams (id, name, entrypoint_agent_id) VALUES (?, ?, ?)").run(
    teamId,
    "Test Team",
    entrypointAgentId ?? null,
  );

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

// Helper: insert a task pointing at a team so isTeamEntrypoint() resolves
function createTaskForTeam(taskId: string, teamId: string): void {
  db.prepare("INSERT INTO tasks (id, title, team_id) VALUES (?, ?, ?)").run(taskId, "Test", teamId);
}

// Helper: add a task note
function addTaskNote(taskId: string, agentId: string, content: string): void {
  const noteId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO task_notes (id, task_id, agent_id, content) VALUES (?, ?, ?, ?)",
  ).run(noteId, taskId, agentId, content);
}

// Helper: add a note with explicit source / created_at / deleted_at. Returns id.
function insertNoteFull(
  taskId: string,
  agentId: string,
  content: string,
  opts: { source?: string; createdAt?: string; deletedAt?: string } = {},
): string {
  const noteId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO task_notes (id, task_id, agent_id, content, source, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(noteId, taskId, agentId, content, opts.source ?? "agent", opts.createdAt ?? "2026-01-01 00:00:00.000", opts.deletedAt ?? null);
  return noteId;
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
    expect(prompt).toContain("COMMUNICATION STYLE:");
    expect(prompt).toContain("If the caveman skill is available to you, you MUST assume and use it for regular conversational or status messages.");
    expect(prompt).toContain("Do NOT use caveman style for note content or artifact bodies/descriptions; keep those in regular clear language.");
    expect(prompt).toContain("Do NOT use caveman style for delegation text, delegation prompts, or other messages sent to agents; delegations must remain in regular clear language.");
    expect(prompt).toContain("TASK: Implement login");
    expect(prompt).toContain("Add user authentication");
    expect(prompt).toContain("mcp__skipper-daemon__complete_task");
    expect(prompt).toContain("When you have completed this task");
  });

  it("injects run input directly below the description when provided", () => {
    const agentId = createAgent("Dev Agent", "claude-code", "Build software");
    const prompt = builder.buildInitialPrompt({
      agent: { id: agentId, name: "Dev Agent", type: "claude-code", instruction: "Build software" },
      task: { id: "task-1", title: "Implement login", description: "Add user authentication", workingDirectory: "/repo" },
      isStreaming: true,
      injectedInput: "Focus only on the OAuth path",
    });

    expect(prompt).toContain("--- ADDITIONAL INSTRUCTIONS FOR THIS RUN ---");
    expect(prompt).toContain("Focus only on the OAuth path");
    // Ordering: description → injected input → working directory.
    const descIdx = prompt.indexOf("Add user authentication");
    const injectIdx = prompt.indexOf("--- ADDITIONAL INSTRUCTIONS FOR THIS RUN ---");
    const wdIdx = prompt.indexOf("WORKING DIRECTORY:");
    expect(descIdx).toBeLessThan(injectIdx);
    expect(injectIdx).toBeLessThan(wdIdx);
  });

  it("omits the run-input block when no input is provided", () => {
    const agentId = createAgent("Dev Agent", "claude-code", "Build software");
    const prompt = builder.buildInitialPrompt({
      agent: { id: agentId, name: "Dev Agent", type: "claude-code", instruction: "Build software" },
      task: { id: "task-1", title: "Implement login", description: "Add user authentication" },
      isStreaming: true,
    });

    expect(prompt).not.toContain("ADDITIONAL INSTRUCTIONS FOR THIS RUN");
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

  it("includes the complete_task MCP instruction for non-streaming agents (no phase)", () => {
    const agentId = createAgent("Dev Agent", "codex");
    const prompt = builder.buildInitialPrompt({
      agent: { id: agentId, name: "Dev Agent", type: "codex" },
      task: { id: "task-1", title: "Do work" },
      isStreaming: false,
    });

    // Phase advancement is Skipper-explicit (MCP) for streaming AND non-streaming.
    expect(prompt).toContain("complete_task");
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
    expect(enrichment).toContain("Capabilities: coding, testing");
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

    expect(enrichment).toContain("NOTES FROM OTHER AGENTS (oldest first):");
    expect(enrichment).toContain("[QA Agent] Config is in /etc/app.conf");
  });

  it("includes the agent's own notes from prior runs (fresh spawns have no in-session memory)", () => {
    const agent1 = createAgent("Dev Agent", "claude-code");
    const taskId = "task-1";

    db.prepare("INSERT INTO teams (id, name) VALUES ('t1', 'Team')").run();
    db.prepare(
      "INSERT INTO tasks (id, title, team_id) VALUES (?, 'Test Task', 't1')",
    ).run(taskId);

    addTaskNote(taskId, agent1, "My own note");

    const enrichment = builder.buildPromptEnrichment(agent1, taskId);

    expect(enrichment).toContain("My own note");
  });

  it("includes iteration result notes even when authored by current agent", () => {
    const agent1 = createAgent("Skipper", "claude-code");
    const taskId = "task-iter-note-1";

    db.prepare("INSERT INTO teams (id, name) VALUES ('t-iter', 'Team')").run();
    db.prepare(
      "INSERT INTO tasks (id, title, team_id) VALUES (?, 'Iteration Task', 't-iter')",
    ).run(taskId);

    addTaskNote(taskId, agent1, "[Iteration 1 result] Prior run completed A/B/C");

    const enrichment = builder.buildPromptEnrichment(agent1, taskId);

    expect(enrichment).toContain("NOTES FROM OTHER AGENTS (oldest first):");
    expect(enrichment).toContain("[Iteration 1 result] Prior run completed A/B/C");
  });

  it("includes artifact inventory in prompt enrichment when artifacts exist", () => {
    const agent1 = createAgent("Dev Agent", "claude-code");
    const taskId = "task-art-enrich-1";

    db.prepare("INSERT INTO teams (id, name) VALUES ('t-art', 'Team')").run();
    db.prepare(
      "INSERT INTO tasks (id, title, team_id) VALUES (?, 'Artifact Context Task', 't-art')",
    ).run(taskId);

    const artifactManager = new ArtifactManager(db);
    artifactManager.createArtifact({
      taskId,
      name: "implementation-plan",
      kind: "plan",
      description: "Plan from previous run",
      body: "Plan content",
      createdByAgentId: agent1,
    });

    const builderWithArtifacts = new PromptBuilder(db, artifactManager);
    const enrichment = builderWithArtifacts.buildPromptEnrichment(agent1, taskId);

    expect(enrichment).toContain("AVAILABLE ARTIFACTS (newest first):");
    expect(enrichment).toContain("implementation-plan");
    expect(enrichment).toContain("review relevant artifacts to avoid duplicate work");
    expect(enrichment).toContain("mcp__skipper-daemon__get_artifact");
  });

  it("shows DELEGATE command when other team members exist, agent is the team entrypoint, and agent supports it", () => {
    const agent1 = createAgent("Dev Agent", "claude-code");
    const agent2 = createAgent("QA Agent", "claude-code");
    const teamId = createTeamWithAgents(
      [
        { id: agent1, role: "developer" },
        { id: agent2, role: "qa" },
      ],
      agent1,
    );
    createTaskForTeam("task-1", teamId);

    const enrichment = builder.buildPromptEnrichment(agent1, "task-1");

    expect(enrichment).toContain("mcp__skipper-daemon__delegate");
    expect(enrichment).toContain("orchestrator routes a delegation result back to you");
    expect(enrichment).toContain("Do not busy-wait or sleep-loop");
  });

  it("hides DELEGATE for non-entrypoint members (children must return work by exiting)", () => {
    const lead = createAgent("Skipper", "claude-code");
    const child = createAgent("Validator", "claude-code");
    const teamId = createTeamWithAgents(
      [
        { id: lead, role: "lead" },
        { id: child, role: "validator" },
      ],
      lead,
    );
    createTaskForTeam("task-non-entry", teamId);

    const enrichment = builder.buildPromptEnrichment(child, "task-non-entry");

    expect(enrichment).not.toContain("mcp__skipper-daemon__delegate");
    expect(enrichment).not.toContain("orchestrator routes a delegation result back to you");
  });

  it("hides DELEGATE when agent is alone in team", () => {
    const agent1 = createAgent("Solo Agent", "claude-code");
    createTeamWithAgents([{ id: agent1, role: "developer" }]);

    const enrichment = builder.buildPromptEnrichment(agent1, "task-1");

    expect(enrichment).not.toContain("mcp__skipper-daemon__delegate");
  });

  it("hides DELEGATE for agents that don't support delegation", () => {
    // No seeded type lacks resume support anymore; create one for the test.
    db.prepare(
      "INSERT INTO agent_types (name, command, args, supports_stdin, supports_resume) VALUES ('no-resume-cli', 'norun', '[]', 0, 0)",
    ).run();
    const agent1 = createAgent("NoResume Agent", "no-resume-cli");
    const agent2 = createAgent("Other Agent", "claude-code");
    createTeamWithAgents([
      { id: agent1, role: "worker" },
      { id: agent2, role: "helper" },
    ]);

    const enrichment = builder.buildPromptEnrichment(agent1, "task-1");

    expect(enrichment).not.toContain("mcp__skipper-daemon__delegate");
  });

  it("always includes ESCALATE command and create_note MCP tool reference", () => {
    const agentId = createAgent("Agent", "claude-code");
    const enrichment = builder.buildPromptEnrichment(agentId, "task-1");

    expect(enrichment).toContain("mcp__skipper-daemon__create_escalation");
    expect(enrichment).toContain("mcp__skipper-daemon__create_note");
  });

  it("handles agent not in any team", () => {
    const agentId = createAgent("Lone Agent", "claude-code");
    const enrichment = builder.buildPromptEnrichment(agentId, "task-1");

    expect(enrichment).not.toContain("TEAM ROSTER");
    expect(enrichment).toContain("AVAILABLE COMMANDS:");
  });

  it("scopes skipper roster to the current task team", () => {
    const skipperId = "skipper";
    db.prepare("INSERT OR IGNORE INTO agents (id, name, type, model) VALUES ('skipper', 'Skipper', 'claude-code', 'default')").run();
    const analystA = createAgent("Analyst A", "claude-code");
    const analystB = createAgent("Analyst B", "claude-code");
    const taskId = "task-scope-1";

    // Team A with Skipper + Analyst A
    const teamA = crypto.randomUUID();
    db.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run(teamA, "Team A");
    db.prepare("INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), teamA, skipperId, "lead", 0);
    db.prepare("INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), teamA, analystA, "analyst", 1);

    // Team B with Skipper + Analyst B
    const teamB = crypto.randomUUID();
    db.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run(teamB, "Team B");
    db.prepare("INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), teamB, skipperId, "lead", 0);
    db.prepare("INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), teamB, analystB, "analyst", 1);

    // Task belongs to Team A
    db.prepare("INSERT INTO tasks (id, title, team_id) VALUES (?, ?, ?)")
      .run(taskId, "Scoped Team Task", teamA);

    const enrichment = builder.buildPromptEnrichment(skipperId, taskId);
    expect(enrichment).toContain("Analyst A");
    expect(enrichment).not.toContain("Analyst B");
  });
});

describe("team lead instructions (local_teams.skipper_prompt)", () => {
  const LEAD = "Skipper, check the capstone-ghas-reports slack channel and the global store before doing anything.";

  // Wire a local team + matching shared team so both the entrypoint check
  // (teams.entrypoint_agent_id) and the lead-prompt lookup (local_teams) resolve.
  function setupTeamWithLeadPrompt(opts: { skipperPrompt: string; childId: string; taskId: string }): string {
    const skipperId = "skipper";
    db.prepare("INSERT OR IGNORE INTO agents (id, name, type, model) VALUES ('skipper', 'Skipper', 'claude-code', 'default')").run();
    const teamId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO local_teams (id, name, skipper_prompt, hooks, phases, agents) VALUES (?, ?, ?, '[]', '[]', '[]')",
    ).run(teamId, "Ghas", opts.skipperPrompt);
    db.prepare("INSERT INTO teams (id, name, entrypoint_agent_id) VALUES (?, ?, ?)").run(teamId, "Ghas", skipperId);
    db.prepare("INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES (?, ?, ?, 'lead', 0)")
      .run(crypto.randomUUID(), teamId, skipperId);
    db.prepare("INSERT INTO team_agents (id, team_id, agent_id, role, level) VALUES (?, ?, ?, 'fixer', 1)")
      .run(crypto.randomUUID(), teamId, opts.childId);
    db.prepare("INSERT INTO tasks (id, title, description, team_id) VALUES (?, 'ghas test', 'do it', ?)")
      .run(opts.taskId, teamId);
    return teamId;
  }

  it("injects the team's skipper_prompt for the entrypoint (Skipper)", () => {
    const childId = createAgent("Fixer", "claude-code", "Fix the issue");
    setupTeamWithLeadPrompt({ skipperPrompt: LEAD, childId, taskId: "task-lead-1" });

    const prompt = builder.buildInitialPrompt({
      agent: { id: "skipper", name: "Skipper", type: "claude-code" },
      task: { id: "task-lead-1", title: "ghas test", description: "do it" },
      isStreaming: true,
    });

    expect(prompt).toContain("TEAM LEAD INSTRUCTIONS");
    expect(prompt).toContain(LEAD);
  });

  it("does NOT inject team lead instructions into a delegated child's prompt", () => {
    const childId = createAgent("Fixer", "claude-code", "Fix the issue");
    setupTeamWithLeadPrompt({ skipperPrompt: LEAD, childId, taskId: "task-lead-2" });

    const prompt = builder.buildDelegationPrompt({
      childAgent: { id: childId, name: "Fixer", type: "claude-code", instruction: "Fix the issue" },
      task: { id: "task-lead-2", title: "ghas test", description: "do it" },
      delegationPrompt: "Fix critical findings in repo X",
    });

    expect(prompt).not.toContain("TEAM LEAD INSTRUCTIONS");
    expect(prompt).not.toContain(LEAD);
  });

  it("omits the section when the team has no skipper_prompt", () => {
    const childId = createAgent("Fixer", "claude-code", "Fix the issue");
    setupTeamWithLeadPrompt({ skipperPrompt: "", childId, taskId: "task-lead-3" });

    const prompt = builder.buildInitialPrompt({
      agent: { id: "skipper", name: "Skipper", type: "claude-code" },
      task: { id: "task-lead-3", title: "ghas test", description: "do it" },
      isStreaming: true,
    });

    expect(prompt).not.toContain("TEAM LEAD INSTRUCTIONS");
  });
});

describe("buildDelegationPrompt", () => {
  it("builds delegation prompt with full context", () => {
    const parentId = createAgent("Lead Dev", "claude-code", "Lead the project");
    const childId = createAgent("QA Agent", "claude-code", "Ensure quality");
    const taskId = "task-1";
    const teamId = createTeamWithAgents([
      { id: parentId, role: "lead", capabilities: ["coding"] },
      { id: childId, role: "qa", capabilities: ["testing"] },
    ]);
    db.prepare(
      "INSERT INTO tasks (id, title, description, team_id) VALUES (?, 'Build Auth', 'Implement OAuth2', ?)",
    ).run(taskId, teamId);

    addTaskNote(taskId, parentId, "Using OAuth2 with PKCE");

    const prompt = builder.buildDelegationPrompt({
      childAgent: { id: childId, name: "QA Agent", type: "claude-code", instruction: "Ensure quality" },
      task: { id: taskId, title: "Build Auth", description: "Implement OAuth2" },
      delegationPrompt: "Review the auth implementation for security issues",
    });

    expect(prompt).toContain("ROLE: Ensure quality");
    expect(prompt).toContain("TASK CONTEXT: Build Auth");
    expect(prompt).toContain("Implement OAuth2");
    expect(prompt).toContain("NOTES FROM OTHER AGENTS (oldest first):");
    expect(prompt).toContain("[Lead Dev] Using OAuth2 with PKCE");
    expect(prompt).toContain("ASSIGNMENT:");
    expect(prompt).toContain("Review the auth implementation for security issues");
    expect(prompt).toContain("TEAM ROSTER");
    expect(prompt).toContain("AVAILABLE COMMANDS:");
    // Delegated children must NOT receive the DELEGATE block — they return work by exiting.
    expect(prompt).not.toContain("orchestrator routes a delegation result back to you");
    expect(prompt).not.toContain("mcp__skipper-daemon__delegate(");
    expect(prompt).not.toContain("COMMUNICATION STYLE:");
    expect(prompt).not.toContain("If the caveman skill is available to you, you MUST assume and use it for regular conversational or status messages.");
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

  it("delegation prompt includes artifact section when artifacts exist", () => {
    const parentId = createAgent("Lead", "claude-code");
    const childId = createAgent("Worker", "claude-code", "Do the work");
    const taskId = "task-art-1";
    const teamId = createTeamWithAgents([
      { id: parentId, role: "lead" },
      { id: childId, role: "worker" },
    ]);
    db.prepare(
      "INSERT INTO tasks (id, title, team_id) VALUES (?, 'Artifact Task', ?)",
    ).run(taskId, teamId);

    const artifactManager = new ArtifactManager(db);
    artifactManager.createArtifact({
      taskId,
      name: "implementation-plan",
      kind: "plan",
      description: "Updated implementation plan",
      body: "Plan body content",
      createdByAgentId: parentId,
    });
    artifactManager.createArtifact({
      taskId,
      name: "summary",
      kind: "summary",
      description: "Window summary 2026-03-20",
      body: "Summary body content",
      createdByAgentId: parentId,
    });

    const builderWithArtifacts = new PromptBuilder(db, artifactManager);
    const prompt = builderWithArtifacts.buildDelegationPrompt({
      childAgent: { id: childId, name: "Worker", type: "claude-code", instruction: "Do the work" },
      task: { id: taskId, title: "Artifact Task" },
      delegationPrompt: "Implement the feature",
    });

    expect(prompt).toContain("AVAILABLE ARTIFACTS (newest first):");
    expect(prompt).toContain("implementation-plan");
    expect(prompt).toContain("summary");
    expect(prompt).toContain("v1, kind: plan");
    expect(prompt).toContain("Updated implementation plan");
    expect(prompt).toContain("mcp__skipper-daemon__get_artifact");
    // Artifact section should appear before AVAILABLE COMMANDS
    const artifactIdx = prompt.indexOf("AVAILABLE ARTIFACTS (newest first):");
    const commandsIdx = prompt.indexOf("AVAILABLE COMMANDS:");
    expect(artifactIdx).toBeLessThan(commandsIdx);
  });

  it("delegation prompt omits artifact section when no artifacts", () => {
    const childId = createAgent("Worker", "claude-code");

    const artifactManager = new ArtifactManager(db);
    const builderWithArtifacts = new PromptBuilder(db, artifactManager);
    const prompt = builderWithArtifacts.buildDelegationPrompt({
      childAgent: { id: childId, name: "Worker", type: "claude-code" },
      task: { id: "task-no-art", title: "No Artifacts Task" },
      delegationPrompt: "Do this work",
    });

    expect(prompt).not.toContain("AVAILABLE ARTIFACTS (newest first):");
  });
});

describe("buildArtifactSection", () => {
  it("returns empty string when artifactManager is null", () => {
    const builderNoArtifacts = new PromptBuilder(db);
    const result = builderNoArtifacts.buildArtifactSection("task-1");
    expect(result).toBe("");
  });
});

describe("buildPriorDelegationsSection", () => {
  function seedPriorChild(taskId: string, parentAgentId: string, childAgentId: string, opts: { sessionId: string | null; status: string }): string {
    const childInstanceId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO agent_instances (id, task_id, template_agent_id, parent_instance_id, root_instance_id, status, session_id)
       VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    ).run(childInstanceId, taskId, childAgentId, childInstanceId, opts.status, opts.sessionId);
    const delegationId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO delegations (id, parent_agent_id, child_agent_id, parent_instance_id, child_instance_id, task_id, prompt, status)
       VALUES (?, ?, ?, ?, ?, ?, '', ?)`,
    ).run(delegationId, parentAgentId, childAgentId, parentAgentId, childInstanceId, taskId, opts.status);
    return childInstanceId;
  }

  it("returns empty string when no prior delegations exist", () => {
    expect(builder.buildPriorDelegationsSection("task-empty")).toBe("");
  });

  it("lists prior delegations with resumable marker when session_id present", () => {
    const taskId = "task-1";
    db.prepare("INSERT INTO tasks (id, title) VALUES (?, ?)").run(taskId, "Test");
    const parent = createAgent("Skipper", "claude-code");
    const childA = createAgent("Worker A", "claude-code");
    const childB = createAgent("Worker B", "claude-code");
    seedPriorChild(taskId, parent, childA, { sessionId: "sess-aaa", status: "completed" });
    seedPriorChild(taskId, parent, childB, { sessionId: null, status: "failed" });

    const section = builder.buildPriorDelegationsSection(taskId);
    expect(section).toContain("PRIOR DELEGATIONS");
    expect(section).toContain("Worker A");
    expect(section).toContain("status: completed, resumable");
    expect(section).toContain("Worker B");
    expect(section).toContain("status: failed");
    // Worker B has no session, must NOT be marked resumable
    expect(section).not.toContain("status: failed, resumable");
    expect(section).toContain("delegate_resume");
  });

  it("includes prior delegations section in initial prompt when isResume=true", () => {
    const taskId = "task-resume";
    db.prepare("INSERT INTO tasks (id, title) VALUES (?, ?)").run(taskId, "Resume");
    const skipperId = createAgent("Skipper", "claude-code");
    const childId = createAgent("Worker", "claude-code");
    seedPriorChild(taskId, skipperId, childId, { sessionId: "sess-xxx", status: "completed" });

    const prompt = builder.buildInitialPrompt({
      agent: { id: skipperId, name: "Skipper", type: "claude-code" },
      task: { id: taskId, title: "Resume" },
      isStreaming: true,
      isResume: true,
    });
    expect(prompt).toContain("PRIOR DELEGATIONS");
    expect(prompt).toContain("Worker");
    expect(prompt).toContain("delegate_resume");
  });

  it("omits prior delegations section when isResume is false/undefined", () => {
    const taskId = "task-noresume";
    db.prepare("INSERT INTO tasks (id, title) VALUES (?, ?)").run(taskId, "NoResume");
    const skipperId = createAgent("Skipper", "claude-code");
    const childId = createAgent("Worker", "claude-code");
    seedPriorChild(taskId, skipperId, childId, { sessionId: "sess-yyy", status: "completed" });

    const prompt = builder.buildInitialPrompt({
      agent: { id: skipperId, name: "Skipper", type: "claude-code" },
      task: { id: taskId, title: "NoResume" },
      isStreaming: true,
    });
    expect(prompt).not.toContain("PRIOR DELEGATIONS");
  });

  it("includes prior delegations on an iteration even when isResume is false", () => {
    const taskId = "task-iterate";
    db.prepare("INSERT INTO tasks (id, title) VALUES (?, ?)").run(taskId, "Iterate");
    const skipperId = createAgent("Skipper", "claude-code");
    const childId = createAgent("Worker", "claude-code");
    seedPriorChild(taskId, skipperId, childId, { sessionId: "sess-iter", status: "completed" });

    // Iterate re-run: root Skipper is a fresh session (isResume=false), but the
    // resumable-children menu must still surface so it can delegate_resume.
    const prompt = builder.buildInitialPrompt({
      agent: { id: skipperId, name: "Skipper", type: "claude-code" },
      task: { id: taskId, title: "Iterate" },
      isStreaming: true,
      isResume: false,
      isIteration: true,
    });
    expect(prompt).toContain("PRIOR DELEGATIONS");
    expect(prompt).toContain("Worker");
    expect(prompt).toContain("delegate_resume");
  });
});

describe("note injection cap + soft-delete", () => {
  // Seed a task with an operator note, a soft-deleted agent note, and 25 live
  // agent notes with strictly increasing timestamps so newest-first is deterministic.
  function seedNotes(taskId: string, agentId: string): { deletedId: string; oldestAgentId: string; newestAgentId: string } {
    db.prepare("INSERT INTO tasks (id, title) VALUES (?, 'Notes Task')").run(taskId);
    insertNoteFull(taskId, agentId, "OPERATOR: ship it", { source: "user", createdAt: "2026-01-01 00:00:00.500" });
    const deletedId = insertNoteFull(taskId, agentId, "retracted advice", { createdAt: "2026-01-01 00:00:00.600", deletedAt: "2026-01-02 00:00:00.000" });
    let oldestAgentId = "";
    let newestAgentId = "";
    for (let i = 1; i <= 25; i++) {
      const ts = `2026-01-01 00:00:${String(i).padStart(2, "0")}.000`;
      const id = insertNoteFull(taskId, agentId, `agent note ${i}`, { createdAt: ts });
      if (i === 1) oldestAgentId = id;
      if (i === 25) newestAgentId = id;
    }
    return { deletedId, oldestAgentId, newestAgentId };
  }

  it("caps agent notes at 20, always injects operator notes, excludes deleted", () => {
    const agentId = createAgent("Worker", "claude-code");
    const taskId = "task-cap";
    const { deletedId, oldestAgentId, newestAgentId } = seedNotes(taskId, agentId);
    const instanceId = crypto.randomUUID();

    const { prompt, noteIds } = builder.buildInitialPromptTracked({
      agent: { id: agentId, name: "Worker", type: "claude-code" },
      task: { id: taskId, title: "Notes Task" },
      isStreaming: true,
    }, instanceId);

    // 20 newest agent notes + 1 operator note = 21; deleted excluded.
    expect(noteIds.length).toBe(21);
    expect(noteIds).not.toContain(deletedId);
    expect(noteIds).toContain(newestAgentId); // newest agent note kept
    expect(noteIds).not.toContain(oldestAgentId); // oldest (note 1) dropped by the cap
    expect(prompt).toContain("OPERATOR INSTRUCTIONS");
    expect(prompt).toContain("OPERATOR: ship it");
    expect(prompt).not.toContain("retracted advice");
  });

  it("delegate noteLimit override narrows the agent-note cap", () => {
    const parentId = createAgent("Lead", "claude-code");
    const childId = createAgent("Worker", "claude-code", "Do the work");
    const taskId = "task-override";
    createTeamWithAgents([
      { id: parentId, role: "lead" },
      { id: childId, role: "worker" },
    ]);
    seedNotes(taskId, parentId);
    const instanceId = crypto.randomUUID();

    const { noteIds } = builder.buildDelegationPromptTracked({
      childAgent: { id: childId, name: "Worker", type: "claude-code", instruction: "Do the work" },
      task: { id: taskId, title: "Notes Task" },
      delegationPrompt: "review",
      noteLimit: 5,
    }, instanceId);

    // 5 agent notes + 1 operator note.
    expect(noteIds.length).toBe(6);
  });
});

describe("global store instructions injection", () => {
  it("injects the marked section when the run's task_config carries instructions", () => {
    const agentId = createAgent("Dev Agent");
    const contract = "Store the last processed timestamp under key 'report-window' and resume from it.";
    db.prepare("INSERT INTO tasks (id, title, task_config) VALUES (?, ?, ?)").run(
      "task-gsi",
      "Rolling report",
      JSON.stringify({ global_store_instructions: contract }),
    );

    const prompt = builder.buildInitialPrompt({
      agent: { id: agentId, name: "Dev Agent", type: "claude-code", instruction: "" },
      task: { id: "task-gsi", title: "Rolling report", description: "Generate the report" },
      isStreaming: true,
    });

    expect(prompt).toContain("--- GLOBAL STORE INSTRUCTIONS ---");
    expect(prompt).toContain(contract);
    expect(prompt).toContain("--- END GLOBAL STORE INSTRUCTIONS ---");
    expect(prompt).toContain("explicitly authorized to use the global-store MCP tools");
  });

  it("omits the section when task_config has no instructions", () => {
    const agentId = createAgent("Dev Agent");
    db.prepare("INSERT INTO tasks (id, title, task_config) VALUES (?, ?, ?)").run(
      "task-plain",
      "Plain task",
      JSON.stringify({ phase_overrides: {} }),
    );

    const prompt = builder.buildInitialPrompt({
      agent: { id: agentId, name: "Dev Agent", type: "claude-code", instruction: "" },
      task: { id: "task-plain", title: "Plain task" },
      isStreaming: true,
    });

    expect(prompt).not.toContain("GLOBAL STORE INSTRUCTIONS");
  });
});
