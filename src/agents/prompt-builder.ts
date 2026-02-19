import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { getAgentTypeDefinition } from "./types";

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
  goal?: string;
}

export interface TeamMember {
  id: string;
  name: string;
  role: string | null;
  skills: string[];
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

    // Agent goal
    if (options.agent.goal) {
      parts.push(`GOAL: ${options.agent.goal}`);
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
      parts.push("--- PHASE REGRESSION NOTICE ---");
      parts.push("This phase is being RE-RUN. A later phase rejected the work.");
      parts.push(`Reason: ${options.regressionReason}`);
      parts.push("Address the issues described above before completing this phase.");
      parts.push("--- END REGRESSION NOTICE ---");
      parts.push("");
    }

    // Phase complete instruction (streaming agents only)
    if (options.isStreaming) {
      if (options.phase) {
        parts.push("When you have completed this phase, output [PHASE_COMPLETE] on its own line.");
      } else {
        parts.push("When you have completed this task, output [PHASE_COMPLETE] on its own line.");
      }
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
    const roster = this.getTeamRoster(agentId);
    if (roster.length > 0) {
      parts.push("TEAM ROSTER (use agent IDs for delegation):");
      for (const member of roster) {
        const skills = member.skills.length > 0 ? member.skills.join(", ") : "none";
        parts.push(
          `- ID: ${member.id} | Name: ${member.name} | Role: ${member.role ?? "unassigned"} | Skills: ${skills}`,
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
      parts.push(
        "- To delegate work to a team member: [DELEGATE to:<agent-id>] description of work",
      );
    }

    parts.push("- To ask the human user a question: [ESCALATE] your question here");
    parts.push(
      "- To record an important note for other agents: [NOTE] short note about sharp edges or critical context",
    );

    return parts.join("\n");
  }

  buildDelegationPrompt(options: DelegationPromptOptions): string {
    const parts: string[] = [];

    // Child agent role
    if (options.childAgent.goal) {
      parts.push(`ROLE: ${options.childAgent.goal}`);
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
    const roster = this.getTeamRoster(options.childAgent.id);
    if (roster.length > 0) {
      parts.push("TEAM ROSTER (use agent IDs for delegation):");
      for (const member of roster) {
        const skills = member.skills.length > 0 ? member.skills.join(", ") : "none";
        parts.push(
          `- ID: ${member.id} | Name: ${member.name} | Role: ${member.role ?? "unassigned"} | Skills: ${skills}`,
        );
      }
      parts.push("");
    }

    // Available commands
    parts.push("AVAILABLE COMMANDS:");
    const otherMembers = roster.filter((m) => m.id !== options.childAgent.id);
    if (otherMembers.length > 0 && this.agentSupportsDelegation(options.childAgent.id)) {
      parts.push(
        "- To delegate work to a team member: [DELEGATE to:<agent-id>] description of work",
      );
    }
    parts.push("- To ask the human user a question: [ESCALATE] your question here");
    parts.push(
      "- To record an important note for other agents: [NOTE] short note about sharp edges or critical context",
    );

    return parts.join("\n");
  }

  private getTeamRoster(agentId: string): TeamMember[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.name, ta.role, ta.skills
         FROM team_agents ta
         JOIN agents a ON ta.agent_id = a.id
         WHERE ta.team_id IN (
           SELECT team_id FROM team_agents WHERE agent_id = ?
         )
         ORDER BY ta.level, a.name`,
      )
      .all(agentId) as { id: string; name: string; role: string | null; skills: string }[];

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      skills: JSON.parse(r.skills),
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
