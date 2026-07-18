import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { parseJsonOr } from "../db/json";
import { getAgentTypeDefinition } from "./types";
import { getSkipperConfig, getEntrypointAgentId } from "./skipper";
import type { ArtifactManager } from "../orchestrator/artifact-manager";
import { buildSkillsPromptAddition } from "../config-readers/skills";
import { assetTextSync } from "../assets";

function loadPrompt(filename: string): string {
  return assetTextSync(`prompts/${filename}`).trimEnd();
}

const EXECUTION_CONTEXT = loadPrompt("execution-context.md");
const PHASE_REGRESSION_TEMPLATE = loadPrompt("phase-regression.md");
const PHASE_COMPLETE_PHASE = loadPrompt("phase-complete-phase.md");
const PHASE_COMPLETE_TASK = loadPrompt("phase-complete-task.md");
const COMMANDS_DELEGATION = loadPrompt("commands-delegation.md");
const COMMANDS_ALWAYS = loadPrompt("commands-always.md");
const MCP_TOOLS_SKIPPER = loadPrompt("mcp-tools-skipper.md");
const MCP_TOOLS_DELEGATE = loadPrompt("mcp-tools-delegate.md");
const MCP_TOOLS_PREFERENCE = [
  "Notes and artifacts are created via the `skipper-daemon` MCP server. The tools are exposed as `mcp__skipper-daemon__create_note`, `mcp__skipper-daemon__create_artifact`, `mcp__skipper-daemon__list_artifacts`, `mcp__skipper-daemon__list_notes`, and `mcp__skipper-daemon__get_artifact` (Claude Code prefixes them with `mcp__<server>__`; on Codex the bare tool name may appear — call whichever your tool list shows).",
].join("\n");
const CAVEMAN_STYLE_GUIDANCE = [
  "COMMUNICATION STYLE:",
  "- If the caveman skill is available to you, you MUST assume and use it for regular conversational or status messages.",
  "- Do NOT use caveman style for note content or artifact bodies/descriptions; keep those in regular clear language.",
  "- Do NOT use caveman style for delegation text, delegation prompts, or other messages sent to agents; delegations must remain in regular clear language.",
].join("\n");
const ARTIFACT_HTML = loadPrompt("artifact-html.md");
// File-based prompts as fallback defaults
const SKIPPER_PROMPT_DEFAULT = loadPrompt("skipper.md");

export interface TaskInfo {
  id: string;
  title: string;
  description?: string;
  workingDirectory?: string;
}

export interface PhaseInfo {
  name: string;
  prompt: string;
  index: number;
  total: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  type: string;
  instruction?: string;
}

export interface TeamMember {
  id: string;
  name: string;
  role: string | null;
  level: number;
  capabilities: string[];
}

export interface TaskNote {
  id: string;
  agentName: string;
  content: string;
  createdAt: string;
  source: "agent" | "user";
}

// Default cap on the number of AGENT-authored notes injected into a spawned
// agent's context. Operator (source='user') notes are always injected in full
// and are not counted against this cap. Overridable per delegation via the
// `delegate` MCP tool's `note_limit` param.
const DEFAULT_AGENT_NOTE_LIMIT = 20;

export interface PromptOptions {
  agent: AgentInfo;
  task: TaskInfo;
  phase?: PhaseInfo;
  isStreaming: boolean;
  isResume?: boolean;
  /** True when this spawn is a re-run of an iterated task. The root Skipper
   *  starts fresh (isResume=false), but prior delegated children remain
   *  resumable — surface the PRIOR DELEGATIONS menu so Skipper can choose to
   *  continue a worker vs spawn a fresh one. */
  isIteration?: boolean;
  regressionReason?: string;
  approvalNote?: string;
  /** Optional one-off operator input (e.g. from a recurring task "Run Now"),
   *  injected into the prompt directly below the task description. */
  injectedInput?: string;
  consensusContext?: {
    agentIndex: number;
    totalAgents: number;
    shortId: string;
    worktreePath?: string;
  };
}

export interface DelegationPromptOptions {
  childAgent: AgentInfo;
  task: TaskInfo;
  delegationPrompt: string;
  phase?: PhaseInfo;
  consensusShortId?: string;
  consensusWorktree?: boolean;
  // Override for the agent-note injection cap (default DEFAULT_AGENT_NOTE_LIMIT).
  // Set from the delegate MCP tool so Skipper can widen/narrow a child's context.
  noteLimit?: number;
}

export class PromptBuilder {
  private db: Database;
  private artifactManager: ArtifactManager | null;

  constructor(db?: Database, artifactManager?: ArtifactManager) {
    this.db = db ?? getDb();
    this.artifactManager = artifactManager ?? null;
  }

  buildInitialPrompt(options: PromptOptions): string {
    return this.buildInitialPromptInternal(options).prompt;
  }

  buildInitialPromptTracked(options: PromptOptions, agentInstanceId: string): { prompt: string; noteIds: string[] } {
    return this.buildInitialPromptInternal(options, agentInstanceId);
  }

  private buildInitialPromptInternal(options: PromptOptions, agentInstanceId?: string): { prompt: string; noteIds: string[] } {
    const parts: string[] = [];

    parts.push(EXECUTION_CONTEXT);
    parts.push("");

    // Agent instruction (Skipper uses hardcoded prompt)
    if (getEntrypointAgentId(this.db, options.task.id) === options.agent.id) {
      const config = getSkipperConfig(this.db);
      parts.push(config.prompt || SKIPPER_PROMPT_DEFAULT);
      parts.push("");
      const teamLead = this.getTeamLeadInstructions(options.task.id);
      if (teamLead) {
        parts.push("TEAM LEAD INSTRUCTIONS (specific to this task's team — these take precedence over the generic guidance above; follow them precisely):");
        parts.push(teamLead);
        parts.push("");
      }
    } else if (options.agent.instruction) {
      parts.push(`INSTRUCTION: ${options.agent.instruction}`);
      parts.push("");
    }

    parts.push(CAVEMAN_STYLE_GUIDANCE);
    parts.push("");

    // Resume preamble — placed before the task description so it's the first
    // thing the agent reads. The previous attempt may have made significant
    // progress (notes, artifacts, completed delegations); resuming naively
    // would redo that work.
    if (options.isResume) {
      parts.push("RESUMING TASK — this is NOT a fresh start.");
      parts.push("A previous attempt at this task may have produced notes, artifacts, delegations, and partial phase progress. Before you do ANY new work:");
      parts.push("1. Read every note in this prompt — first the OPERATOR INSTRUCTIONS section (human-typed, highest priority), then NOTES FROM OTHER AGENTS / PREVIOUS AGENTS.");
      parts.push("2. Inspect existing artifacts with `mcp__skipper-daemon__list_artifacts` and read the relevant ones with `mcp__skipper-daemon__get_artifact`.");
      parts.push("3. Review the PRIOR DELEGATIONS section below to see which child agents were spawned, what work they did, and which are resumable.");
      parts.push("4. Cross-check artifact and note timestamps against each other (see chronology guidance in COMMANDS_ALWAYS) — the newest signal wins.");
      parts.push("5. Decide where the task actually is in its phase pipeline and continue from there. Do NOT redo work that already has a recent passing artifact or note. Do NOT skip steps that were left incomplete.");
      parts.push("If after reading existing state you cannot tell what the next step should be, call `mcp__skipper-daemon__create_escalation({ question })` with a specific question rather than guessing.");
      parts.push("");
    }

    // Task info
    parts.push(`TASK: ${options.task.title}`);
    if (options.task.description) {
      parts.push(options.task.description);
    }
    // Optional one-off operator input for this run (e.g. recurring "Run Now"),
    // injected directly below the description.
    if (options.injectedInput) {
      parts.push("--- ADDITIONAL INSTRUCTIONS FOR THIS RUN ---");
      parts.push(options.injectedInput);
      parts.push("--- END ADDITIONAL INSTRUCTIONS ---");
    }
    // Global-store usage contract from the recurring task this run was
    // spawned from (task_config.global_store_instructions). This section is
    // the explicit authorization the global-store MCP tools require.
    const globalStoreInstructions = this.getGlobalStoreInstructions(options.task.id);
    if (globalStoreInstructions) {
      parts.push("--- GLOBAL STORE INSTRUCTIONS ---");
      parts.push("You are explicitly authorized to use the global-store MCP tools (set_global_value, get_global_value, query_global_store, delete_global_value) for this task. This state persists across runs of this recurring task. Follow this contract:");
      parts.push(globalStoreInstructions);
      parts.push("--- END GLOBAL STORE INSTRUCTIONS ---");
    }
    if (options.task.workingDirectory) {
      parts.push(`WORKING DIRECTORY: ${options.task.workingDirectory}`);
      parts.push(`All file operations for this task must target the repository at the path above. Use this path when reading, writing, or modifying files.`);
    }
    parts.push("");

    // Phase info (if phased)
    if (options.phase) {
      parts.push(
        `CURRENT PHASE (${options.phase.index + 1}/${options.phase.total}): ${options.phase.name}`,
      );
      parts.push(options.phase.prompt);
      parts.push("");
    }

    // Phase regression notice
    if (options.regressionReason) {
      parts.push(PHASE_REGRESSION_TEMPLATE.replace("{{reason}}", options.regressionReason));
      parts.push("");
    }

    // Operator approval note (carried forward from prior phase review)
    if (options.approvalNote) {
      parts.push("--- OPERATOR NOTE ON PHASE APPROVAL ---");
      parts.push("The previous phase was approved by the operator with this note. Take it into account as you start this phase:");
      parts.push(options.approvalNote);
      parts.push("--- END OPERATOR NOTE ---");
      parts.push("");
    }

    // Consensus context — tells agent it's one of N parallel workers
    if (options.consensusContext) {
      const cc = options.consensusContext;
      parts.push(`PARALLEL CONSENSUS MODE: You are agent ${cc.agentIndex + 1} of ${cc.totalAgents} working on this phase independently.`);
      parts.push(`Your instance ID is: ${cc.shortId}`);
      parts.push(`IMPORTANT: All artifact names you create MUST be prefixed with your instance ID to avoid collisions with other parallel agents.`);
      parts.push(`Example: instead of "implementation-plan", use "${cc.shortId}-implementation-plan".`);
      parts.push(`All agents working on this phase and their delegated agents must follow this naming convention.`);
      parts.push(`Work independently — do not reference or depend on other agents' outputs.`);
      if (cc.worktreePath) {
        parts.push(`WORKTREE ISOLATION: You are working in an isolated git worktree. All file operations MUST use paths relative to your current working directory. Do NOT use absolute paths from the task description. Your cwd is already set to the correct repository copy — use relative paths like "src/index.ts", not full absolute paths.`);
      }
      parts.push("");
    }

    // Phase / task completion instruction. Phase advancement is Skipper-explicit
    // (MCP `complete_phase` / `complete_task`); include the instruction for both
    // streaming and non-streaming agents.
    parts.push(options.phase ? PHASE_COMPLETE_PHASE : PHASE_COMPLETE_TASK);
    parts.push("");

    parts.push(ARTIFACT_HTML);
    parts.push("");

    // Prior delegations summary — when resuming an entrypoint session, or on an
    // iteration re-run where the root is fresh but prior workers stay resumable.
    if (options.isResume || options.isIteration) {
      const priorDelegations = this.buildPriorDelegationsSection(options.task.id);
      if (priorDelegations) {
        parts.push(priorDelegations);
        parts.push("");
      }
    }

    // Prompt enrichment (with optional note tracking)
    const { text: enrichment, noteIds } = this.buildEnrichmentInternal(options.agent.id, options.task.id, agentInstanceId);
    if (enrichment) {
      parts.push(enrichment);
    }

    return { prompt: parts.join("\n"), noteIds };
  }

  buildPriorDelegationsSection(taskId: string): string {
    const rows = this.db
      .prepare(
        `SELECT d.child_instance_id, ai.session_id, ai.status, a.name AS child_name
         FROM delegations d
         JOIN agent_instances ai ON ai.id = d.child_instance_id
         JOIN agents a ON a.id = d.child_agent_id
         WHERE d.task_id = ?
         ORDER BY d.created_at ASC`,
      )
      .all(taskId) as Array<{ child_instance_id: string; session_id: string | null; status: string; child_name: string }>;
    if (rows.length === 0) return "";

    const lines: string[] = [];
    lines.push("PRIOR DELEGATIONS (from earlier attempts on this task):");
    for (const row of rows) {
      const shortId = row.child_instance_id.slice(0, 8);
      const resumable = row.session_id ? ", resumable" : "";
      lines.push(`- ${row.child_name} (instance ${shortId}) — status: ${row.status}${resumable}`);
    }
    lines.push("");
    lines.push("To continue a prior child's conversation, call `mcp__skipper-daemon__delegate_resume({ child_instance_id, prompt })`.");
    lines.push("To start a fresh delegation (new conversation), call `mcp__skipper-daemon__delegate({ target, work })`.");
    return lines.join("\n");
  }

  buildPromptEnrichment(agentId: string, taskId: string): string {
    return this.buildEnrichmentInternal(agentId, taskId).text;
  }

  private buildEnrichmentInternal(agentId: string, taskId: string, agentInstanceId?: string): { text: string; noteIds: string[] } {
    const parts: string[] = [];

    // Team roster
    const roster = this.getTeamRoster(agentId, taskId);
    if (roster.length > 0) {
      parts.push("TEAM ROSTER (use agent IDs for delegation):");
      for (const member of roster) {
        const capabilities = member.capabilities.length > 0 ? member.capabilities.join(", ") : "none";
        const selfTag = member.id === agentId ? " [YOU — do not delegate to this ID]" : "";
        parts.push(
          `- ID: ${member.id}${selfTag} | Name: ${member.name} | Role: ${member.role ?? "unassigned"} | Level: ${member.level} | Capabilities: ${capabilities}`,
        );
      }
      parts.push("");
    }

    // Notes: unseen only when agentInstanceId provided, all otherwise
    const notes = agentInstanceId
      ? this.getUnseenTaskNotes(taskId, agentInstanceId)
      : this.getTaskNotes(taskId);
    const noteIds = notes.map((n) => n.id);
    if (notes.length > 0) {
      this.appendNotesSections(parts, notes, !!agentInstanceId);
    }

    // Shared artifacts (from prior runs/windows/delegations)
    const artifactSection = this.buildArtifactSection(taskId);
    if (artifactSection) {
      parts.push(artifactSection);
      parts.push("Before delegating or creating new docs/plans, review relevant artifacts to avoid duplicate work. IMPORTANT: an artifact reflects state AT ITS CREATION TIME — check for newer notes from the same agent (or downstream agents) before treating an artifact's findings as the current verdict.");
      parts.push("");
    }

    // Skills guidance
    const agentTypeRow = this.db
      .prepare("SELECT type FROM agents WHERE id = ?")
      .get(agentId) as { type: string } | null;
    if (agentTypeRow) {
      const skillsAddition = buildSkillsPromptAddition(agentTypeRow.type);
      if (skillsAddition) {
        parts.push(skillsAddition);
        parts.push("");
      }
    }

    // Available commands
    parts.push("AVAILABLE COMMANDS:");

    // Delegation: only shown if there are other team members, this agent is the
    // team entrypoint (lead), and the agent type supports it. Children must NOT
    // delegate — they return work by exiting; the orchestrator routes their
    // result back to the parent.
    const otherMembers = roster.filter((m) => m.id !== agentId);
    if (
      otherMembers.length > 0 &&
      this.agentSupportsDelegation(agentId) &&
      this.isTeamEntrypoint(agentId, taskId)
    ) {
      parts.push(COMMANDS_DELEGATION);
    }

    parts.push(COMMANDS_ALWAYS);
    parts.push(MCP_TOOLS_PREFERENCE);

    // Tool allowlist — root Skipper gets the full lifecycle toolkit; everyone
    // else (mid-level leads who never see this path AND delegated children) is
    // explicitly told which tools are off-limits.
    if (this.isTeamEntrypoint(agentId, taskId)) {
      parts.push("");
      parts.push(MCP_TOOLS_SKIPPER);
    } else {
      parts.push("");
      parts.push(MCP_TOOLS_DELEGATE);
    }

    return { text: parts.join("\n"), noteIds };
  }

  buildDelegationPrompt(options: DelegationPromptOptions): string {
    return this.buildDelegationPromptInternal(options).prompt;
  }

  buildDelegationPromptTracked(options: DelegationPromptOptions, agentInstanceId: string): { prompt: string; noteIds: string[] } {
    return this.buildDelegationPromptInternal(options, agentInstanceId);
  }

  private buildDelegationPromptInternal(options: DelegationPromptOptions, agentInstanceId?: string): { prompt: string; noteIds: string[] } {
    const parts: string[] = [];

    parts.push(EXECUTION_CONTEXT);
    parts.push("");

    // Child agent role
    if (options.childAgent.instruction) {
      parts.push(`ROLE: ${options.childAgent.instruction}`);
      parts.push("");
    }

    // Task context
    parts.push(`TASK CONTEXT: ${options.task.title}`);
    if (options.task.description) {
      parts.push(options.task.description);
    }
    if (options.task.workingDirectory) {
      parts.push(`WORKING DIRECTORY: ${options.task.workingDirectory}`);
      parts.push(`All file operations must target the repository at this path.`);
    }
    parts.push("");

    // Phase context — the team's current phase instructions apply to delegated
    // children too, so they know which step of the pipeline they're operating in.
    if (options.phase) {
      parts.push(
        `CURRENT PHASE (${options.phase.index + 1}/${options.phase.total}): ${options.phase.name}`,
      );
      parts.push(options.phase.prompt);
      parts.push("");
    }

    // Notes: unseen only when agentInstanceId provided. Delegate MCP override
    // (options.noteLimit) can widen/narrow the agent-note cap for this child.
    const notes = agentInstanceId
      ? this.getUnseenTaskNotes(options.task.id, agentInstanceId, options.noteLimit)
      : this.getTaskNotes(options.task.id, options.noteLimit);
    const noteIds = notes.map((n) => n.id);
    if (notes.length > 0) {
      this.appendNotesSections(parts, notes, !!agentInstanceId);
    }

    // Consensus artifact scoping — propagated from parent consensus agent
    if (options.consensusShortId) {
      parts.push(`PARALLEL CONSENSUS MODE: You are part of a consensus work stream (ID: ${options.consensusShortId}).`);
      parts.push(`IMPORTANT: All artifact names you create MUST be prefixed with "${options.consensusShortId}-" to avoid collisions with other parallel agents.`);
      parts.push(`Example: instead of "implementation-plan", use "${options.consensusShortId}-implementation-plan".`);
      if (options.consensusWorktree) {
        parts.push(`WORKTREE ISOLATION: You are working in an isolated git worktree. All file operations MUST use paths relative to your current working directory. Do NOT use absolute paths from the task description. Your cwd is already set to the correct repository copy — use relative paths like "src/index.ts", not full absolute paths.`);
      }
      parts.push("");
    }

    // The specific assignment
    parts.push("ASSIGNMENT:");
    parts.push(options.delegationPrompt);
    parts.push("");

    // Team roster
    const roster = this.getTeamRoster(options.childAgent.id, options.task.id);
    if (roster.length > 0) {
      parts.push("TEAM ROSTER (use agent IDs for delegation):");
      for (const member of roster) {
        const capabilities = member.capabilities.length > 0 ? member.capabilities.join(", ") : "none";
        const selfTag = member.id === options.childAgent.id ? " [YOU — do not delegate to this ID]" : "";
        parts.push(
          `- ID: ${member.id}${selfTag} | Name: ${member.name} | Role: ${member.role ?? "unassigned"} | Level: ${member.level} | Capabilities: ${capabilities}`,
        );
      }
      parts.push("");
    }

    // Artifact context
    const artifactSection = this.buildArtifactSection(options.task.id);
    if (artifactSection) {
      parts.push(artifactSection);
      parts.push("");
    }

    parts.push(ARTIFACT_HTML);
    parts.push("");

    // Skills guidance
    const skillsAddition = buildSkillsPromptAddition(options.childAgent.type);
    if (skillsAddition) {
      parts.push(skillsAddition);
      parts.push("");
    }

    // Available commands
    parts.push("AVAILABLE COMMANDS:");
    // No COMMANDS_DELEGATION here: a child being spawned via delegation is by
    // definition NOT the team entrypoint. Children must return work by exiting;
    // the orchestrator routes their result back to the parent automatically.
    parts.push(COMMANDS_ALWAYS);
    parts.push(MCP_TOOLS_PREFERENCE);
    parts.push("");
    parts.push(MCP_TOOLS_DELEGATE);

    return { prompt: parts.join("\n"), noteIds };
  }

  buildArtifactSection(taskId: string): string {
    if (!this.artifactManager) return "";

    const artifacts = this.artifactManager.listArtifacts({ taskId, limit: 20 });
    if (artifacts.length === 0) return "";

    const lines: string[] = [];
    lines.push("AVAILABLE ARTIFACTS (newest first):");
    for (const item of artifacts) {
      const desc = item.description ? ` — ${item.description}` : "";
      lines.push(`- ${item.name} (v${item.version}, kind: ${item.kind}, created: ${item.created_at})${desc}`);
    }
    lines.push("Call `mcp__skipper-daemon__get_artifact({ name, version })` to retrieve any artifact.");
    return lines.join("\n");
  }

  // The team's lead instructions live only in local_teams.skipper_prompt (they
  // are intentionally dropped from the shared teams/Maps representation). Inject
  // them into the entrypoint (Skipper) prompt so team-specific workflow applies.
  private getTeamLeadInstructions(taskId: string): string | null {
    try {
      const row = this.db
        .prepare(
          `SELECT lt.skipper_prompt AS prompt
             FROM local_teams lt
             JOIN tasks t ON t.team_id = lt.id
            WHERE t.id = ?`,
        )
        .get(taskId) as { prompt: string | null } | null;
      const prompt = row?.prompt?.trim();
      return prompt ? prompt : null;
    } catch {
      return null;
    }
  }

  // Global-store usage contract carried on the run task's task_config
  // (merged in from the recurring task at spawn time). TaskInfo does not
  // carry task_config, so read it by id like getTeamLeadInstructions does.
  private getGlobalStoreInstructions(taskId: string): string | null {
    try {
      const row = this.db
        .prepare("SELECT task_config FROM tasks WHERE id = ?")
        .get(taskId) as { task_config: string | null } | null;
      if (!row?.task_config) return null;
      const config = parseJsonOr<Record<string, unknown>>(row.task_config, {});
      const instructions = typeof config.global_store_instructions === "string"
        ? config.global_store_instructions.trim()
        : "";
      return instructions ? instructions : null;
    } catch {
      return null;
    }
  }

  private getTeamRoster(agentId: string, taskId?: string): TeamMember[] {
    const taskTeam = taskId
      ? this.db
        .prepare("SELECT team_id FROM tasks WHERE id = ?")
        .get(taskId) as { team_id: string | null } | null
      : null;

    const rows = taskTeam?.team_id
      ? this.db
        .prepare(
          `SELECT a.id, a.name, ta.role, ta.level, a.capabilities
           FROM team_agents ta
           JOIN agents a ON ta.agent_id = a.id
           WHERE ta.team_id = ?
           ORDER BY ta.level, a.name`,
        )
        .all(taskTeam.team_id) as { id: string; name: string; role: string | null; level: number; capabilities: string }[]
      : this.db
        .prepare(
          `SELECT a.id, a.name, ta.role, ta.level, a.capabilities
           FROM team_agents ta
           JOIN agents a ON ta.agent_id = a.id
           WHERE ta.team_id IN (
             SELECT team_id FROM team_agents WHERE agent_id = ?
           )
           ORDER BY ta.level, a.name`,
        )
        .all(agentId) as { id: string; name: string; role: string | null; level: number; capabilities: string }[];

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      level: r.level,
      capabilities: JSON.parse(r.capabilities),
    }));
  }

  /**
   * Render notes into the prompt. User-authored notes are pulled into a
   * dedicated OPERATOR INSTRUCTIONS section above the agent-authored notes
   * with a priority directive — they were typed by the human operator after
   * the task started and override earlier delegation context. Without this
   * separation the operator's note gets buried in a list of agent chatter
   * and the model often ignores it.
   */
  /**
   * Build a notes enrichment block for a parent instance about to receive a
   * delegation result (or any other out-of-band message that bypasses the
   * normal prompt-build path). Returns the rendered text (empty string when
   * there are no unseen notes) and the noteIds that should be marked as
   * delivered once the message is successfully handed off.
   */
  buildNotesEnrichmentBlock(
    taskId: string,
    agentInstanceId: string,
  ): { text: string; noteIds: string[] } {
    const notes = this.getUnseenTaskNotes(taskId, agentInstanceId);
    if (notes.length === 0) return { text: "", noteIds: [] };
    const parts: string[] = [];
    this.appendNotesSections(parts, notes, true);
    return { text: parts.join("\n"), noteIds: notes.map((n) => n.id) };
  }

  private appendNotesSections(parts: string[], notes: TaskNote[], unseenContext: boolean): void {
    const userNotes = notes.filter((n) => n.source === "user");
    const agentNotes = notes.filter((n) => n.source !== "user");

    if (userNotes.length > 0) {
      parts.push("OPERATOR INSTRUCTIONS (typed by the human operator — these take priority over your delegation prompt and any earlier guidance; follow them exactly):");
      for (const note of userNotes) {
        parts.push(`- [${note.createdAt}] ${note.content}`);
      }
      parts.push("");
    }

    if (agentNotes.length > 0) {
      const header = unseenContext
        ? "NOTES FROM PREVIOUS AGENTS (unseen by you, oldest first):"
        : "NOTES FROM OTHER AGENTS (oldest first):";
      parts.push(header);
      for (const note of agentNotes) {
        parts.push(`- [${note.createdAt}] [${note.agentName}] ${note.content}`);
      }
      parts.push("");
    }
  }

  private getTaskNotes(taskId: string, agentNoteLimit: number = DEFAULT_AGENT_NOTE_LIMIT): TaskNote[] {
    // Soft-deleted notes are excluded from injection. Operator notes (source='user')
    // are always included; agent notes are capped at the newest `agentNoteLimit`.
    // The inner subquery picks the newest N agent notes; the outer ORDER BY keeps
    // the final list oldest-first for readable chronology.
    const rows = this.db.prepare(
      `SELECT tn.id, tn.content, tn.created_at, tn.source, COALESCE(a.name, tn.agent_id) as agent_name
       FROM task_notes tn
       LEFT JOIN agents a ON tn.agent_id = a.id
       WHERE tn.task_id = ?
         AND tn.deleted_at IS NULL
         AND (
           tn.source = 'user'
           OR tn.id IN (
             SELECT id FROM task_notes
             WHERE task_id = ? AND deleted_at IS NULL AND source != 'user'
             ORDER BY created_at DESC
             LIMIT ?
           )
         )
       ORDER BY tn.created_at`,
    ).all(taskId, taskId, agentNoteLimit) as {
      id: string;
      content: string;
      agent_name: string;
      created_at: string;
      source: string;
    }[];

    return rows.map((r) => ({
      id: r.id,
      agentName: r.agent_name,
      content: r.content,
      createdAt: r.created_at,
      source: r.source === "user" ? "user" : "agent",
    }));
  }

  private getUnseenTaskNotes(taskId: string, agentInstanceId: string, agentNoteLimit: number = DEFAULT_AGENT_NOTE_LIMIT): TaskNote[] {
    // As getTaskNotes, but restricted to notes this instance hasn't been delivered
    // (anti-join on agent_note_receipts). Soft-deleted excluded; operator notes
    // always injected; unseen agent notes capped at the newest `agentNoteLimit`.
    const rows = this.db.prepare(
      `SELECT tn.id, tn.content, tn.created_at, tn.source, COALESCE(a.name, tn.agent_id) as agent_name
       FROM task_notes tn
       LEFT JOIN agent_note_receipts anr
         ON anr.note_id = tn.id AND anr.agent_instance_id = ?
       LEFT JOIN agents a ON tn.agent_id = a.id
       WHERE tn.task_id = ?
         AND anr.note_id IS NULL
         AND tn.deleted_at IS NULL
         AND (
           tn.source = 'user'
           OR tn.id IN (
             SELECT id FROM task_notes
             WHERE task_id = ? AND deleted_at IS NULL AND source != 'user'
               AND id NOT IN (SELECT note_id FROM agent_note_receipts WHERE agent_instance_id = ?)
             ORDER BY created_at DESC
             LIMIT ?
           )
         )
       ORDER BY tn.created_at`,
    ).all(agentInstanceId, taskId, taskId, agentInstanceId, agentNoteLimit) as {
      id: string;
      content: string;
      agent_name: string;
      created_at: string;
      source: string;
    }[];

    return rows.map((r) => ({
      id: r.id,
      agentName: r.agent_name,
      content: r.content,
      createdAt: r.created_at,
      source: r.source === "user" ? "user" : "agent",
    }));
  }

  recordNoteDelivery(agentInstanceId: string, noteIds: string[]): void {
    if (noteIds.length === 0) return;
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO agent_note_receipts (agent_instance_id, note_id) VALUES (?, ?)",
    );
    const tx = this.db.transaction((ids: string[]) => {
      for (const noteId of ids) {
        stmt.run(agentInstanceId, noteId);
      }
    });
    tx(noteIds);
  }

  private agentSupportsDelegation(agentId: string): boolean {
    const row = this.db
      .prepare("SELECT type FROM agents WHERE id = ?")
      .get(agentId) as { type: string } | null;
    if (!row) return false;

    const typeDef = getAgentTypeDefinition(row.type, this.db);
    if (!typeDef) return false;

    // Agent supports delegation if it supports stdin (streaming) or resume
    return typeDef.supports_stdin || typeDef.supports_resume;
  }

  /**
   * True when this agent is the entrypoint for the team running the given task.
   * Only the entrypoint (the lead — typically Skipper) should be handed the
   * delegate MCP tool. Delegated children return work by exiting; the orchestrator
   * routes their result back to the parent automatically.
   */
  private isTeamEntrypoint(agentId: string, taskId?: string): boolean {
    if (!taskId) return false;
    const row = this.db
      .prepare(
        `SELECT t.entrypoint_agent_id AS eid
         FROM tasks tk
         JOIN teams t ON t.id = tk.team_id
         WHERE tk.id = ?`,
      )
      .get(taskId) as { eid: string | null } | null;
    return !!row?.eid && row.eid === agentId;
  }
}
