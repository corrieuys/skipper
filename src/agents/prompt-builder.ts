import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../db/connection";
import { getAgentTypeDefinition } from "./types";
import { isSkipperAgent } from "./skipper";

const PROMPTS_DIR = join(import.meta.dir, "../../prompts");

function loadPrompt(filename: string): string {
  return readFileSync(join(PROMPTS_DIR, filename), "utf-8").trimEnd();
}

const EXECUTION_CONTEXT = loadPrompt("execution-context.md");
const PHASE_REGRESSION_TEMPLATE = loadPrompt("phase-regression.md");
const PHASE_COMPLETE_PHASE = loadPrompt("phase-complete-phase.md");
const PHASE_COMPLETE_TASK = loadPrompt("phase-complete-task.md");
const COMMANDS_DELEGATION = loadPrompt("commands-delegation.md");
const COMMANDS_ALWAYS = loadPrompt("commands-always.md");
const SKIPPER_PROMPT = loadPrompt("skipper.md");

export interface TaskInfo {
  id: string;
  title: string;
  description?: string;
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
  agentName: string;
  content: string;
}

export interface PromptOptions {
  agent: AgentInfo;
  task: TaskInfo;
  phase?: PhaseInfo;
  isStreaming: boolean;
  regressionReason?: string;
}

export interface DelegationPromptOptions {
  childAgent: AgentInfo;
  task: TaskInfo;
  delegationPrompt: string;
}

export class PromptBuilder {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDb();
  }

  buildInitialPrompt(options: PromptOptions): string {
    const parts: string[] = [];

    parts.push(EXECUTION_CONTEXT);
    parts.push("");

    // Agent instruction (Skipper uses hardcoded prompt)
    if (isSkipperAgent(options.agent.id)) {
      parts.push(SKIPPER_PROMPT);
      parts.push("");
    } else if (options.agent.instruction) {
      parts.push(`INSTRUCTION: ${options.agent.instruction}`);
      parts.push("");
    }

    // Task info
    parts.push(`TASK: ${options.task.title}`);
    if (options.task.description) {
      parts.push(options.task.description);
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

    // Phase complete instruction (streaming agents only)
    if (options.isStreaming) {
      parts.push(options.phase ? PHASE_COMPLETE_PHASE : PHASE_COMPLETE_TASK);
      parts.push("");
    }

    // Prompt enrichment
    const enrichment = this.buildPromptEnrichment(options.agent.id, options.task.id);
    if (enrichment) {
      parts.push(enrichment);
    }

    return parts.join("\n");
  }

  buildPromptEnrichment(agentId: string, taskId: string): string {
    const parts: string[] = [];

    // Team roster
    const roster = this.getTeamRoster(agentId, taskId);
    if (roster.length > 0) {
      parts.push("TEAM ROSTER (use agent IDs for delegation):");
      for (const member of roster) {
        const capabilities = member.capabilities.length > 0 ? member.capabilities.join(", ") : "none";
        parts.push(
          `- ID: ${member.id} | Name: ${member.name} | Role: ${member.role ?? "unassigned"} | Level: ${member.level} | Capabilities: ${capabilities}`,
        );
      }
      parts.push("");
    }

    // Notes from other agents
    const notes = this.getTaskNotes(taskId, agentId);
    if (notes.length > 0) {
      parts.push("NOTES FROM OTHER AGENTS:");
      for (const note of notes) {
        parts.push(`- [${note.agentName}] ${note.content}`);
      }
      parts.push("");
    }

    // Available commands
    parts.push("AVAILABLE COMMANDS:");

    // Delegation: only shown if there are other team members AND agent supports it
    const otherMembers = roster.filter((m) => m.id !== agentId);
    if (otherMembers.length > 0 && this.agentSupportsDelegation(agentId)) {
      parts.push(COMMANDS_DELEGATION);
    }

    parts.push(COMMANDS_ALWAYS);

    return parts.join("\n");
  }

  buildDelegationPrompt(options: DelegationPromptOptions): string {
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
    parts.push("");

    // Notes from other agents
    const notes = this.getTaskNotes(options.task.id, options.childAgent.id);
    if (notes.length > 0) {
      parts.push("NOTES FROM OTHER AGENTS:");
      for (const note of notes) {
        parts.push(`- [${note.agentName}] ${note.content}`);
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
        parts.push(
          `- ID: ${member.id} | Name: ${member.name} | Role: ${member.role ?? "unassigned"} | Level: ${member.level} | Capabilities: ${capabilities}`,
        );
      }
      parts.push("");
    }

    // Available commands
    parts.push("AVAILABLE COMMANDS:");
    const otherMembers = roster.filter((m) => m.id !== options.childAgent.id);
    if (otherMembers.length > 0 && this.agentSupportsDelegation(options.childAgent.id)) {
      parts.push(COMMANDS_DELEGATION);
    }
    parts.push(COMMANDS_ALWAYS);

    return parts.join("\n");
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

  private getTaskNotes(taskId: string, excludeAgentId?: string): TaskNote[] {
    let query = `SELECT tn.content, a.name as agent_name
                 FROM task_notes tn
                 JOIN agents a ON tn.agent_id = a.id
                 WHERE tn.task_id = ?`;
    const params: string[] = [taskId];

    if (excludeAgentId) {
      query += " AND tn.agent_id != ?";
      params.push(excludeAgentId);
    }

    query += " ORDER BY tn.created_at";

    const rows = this.db.prepare(query).all(...params) as {
      content: string;
      agent_name: string;
    }[];

    return rows.map((r) => ({
      agentName: r.agent_name,
      content: r.content,
    }));
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
}
