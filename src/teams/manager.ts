import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";

export interface Team {
  id: string;
  name: string;
  entrypoint_agent_id: string | null;
  phases: Phase[];
  goal: string | null;
  created_at: string;
  updated_at: string;
}

export interface Phase {
  name: string;
  prompt: string;
}

export interface TeamAgent {
  id: string;
  team_id: string;
  agent_id: string;
  role: string | null;
  level: number;
  parent_agent_id: string | null;
  skills: string[];
  max_complexity: number;
  created_at: string;
}

interface TeamRow {
  id: string;
  name: string;
  entrypoint_agent_id: string | null;
  phases: string;
  goal: string | null;
  created_at: string;
  updated_at: string;
}

interface TeamAgentRow {
  id: string;
  team_id: string;
  agent_id: string;
  role: string | null;
  level: number;
  parent_agent_id: string | null;
  skills: string;
  max_complexity: number;
  created_at: string;
}

function rowToTeam(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    entrypoint_agent_id: row.entrypoint_agent_id,
    phases: JSON.parse(row.phases),
    goal: row.goal,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToTeamAgent(row: TeamAgentRow): TeamAgent {
  return {
    id: row.id,
    team_id: row.team_id,
    agent_id: row.agent_id,
    role: row.role,
    level: row.level,
    parent_agent_id: row.parent_agent_id,
    skills: JSON.parse(row.skills),
    max_complexity: row.max_complexity,
    created_at: row.created_at,
  };
}

export interface CreateTeamInput {
  name: string;
  goal?: string;
  phases?: Phase[];
}

export interface AddTeamAgentInput {
  agent_id: string;
  role?: string;
  level?: number;
  parent_agent_id?: string;
  skills?: string[];
  max_complexity?: number;
}

export interface TeamForExecution {
  team: Team;
  entrypoint_agent_id: string;
  agents: TeamAgent[];
}

export class TeamManager {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDb();
  }

  createTeam(input: CreateTeamInput): Team {
    const id = crypto.randomUUID();

    this.db
      .prepare(
        `INSERT INTO teams (id, name, goal, phases)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, input.name, input.goal ?? null, JSON.stringify(input.phases ?? []));

    return this.getTeam(id)!;
  }

  getTeam(id: string): Team | null {
    const row = this.db
      .prepare("SELECT * FROM teams WHERE id = ?")
      .get(id) as TeamRow | null;
    return row ? rowToTeam(row) : null;
  }

  listTeams(): Team[] {
    const rows = this.db
      .prepare("SELECT * FROM teams ORDER BY created_at")
      .all() as TeamRow[];
    return rows.map(rowToTeam);
  }

  setEntrypoint(teamId: string, agentId: string): void {
    // Validate agent is a member of the team
    const membership = this.db
      .prepare(
        "SELECT id FROM team_agents WHERE team_id = ? AND agent_id = ?",
      )
      .get(teamId, agentId);

    if (!membership) {
      throw new Error("Agent must be a team member to be set as entrypoint");
    }

    this.db
      .prepare(
        "UPDATE teams SET entrypoint_agent_id = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(agentId, teamId);
  }

  addAgent(teamId: string, input: AddTeamAgentInput): TeamAgent {
    const team = this.getTeam(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    // Validate agent exists
    const agent = this.db
      .prepare("SELECT id FROM agents WHERE id = ?")
      .get(input.agent_id);
    if (!agent) throw new Error(`Agent not found: ${input.agent_id}`);

    // Validate parent agent if specified
    if (input.parent_agent_id) {
      const parentMembership = this.db
        .prepare(
          "SELECT id FROM team_agents WHERE team_id = ? AND agent_id = ?",
        )
        .get(teamId, input.parent_agent_id);
      if (!parentMembership) {
        throw new Error("Parent agent must be a member of the same team");
      }
    }

    const id = crypto.randomUUID();

    this.db
      .prepare(
        `INSERT INTO team_agents (id, team_id, agent_id, role, level, parent_agent_id, skills, max_complexity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        teamId,
        input.agent_id,
        input.role ?? null,
        input.level ?? 0,
        input.parent_agent_id ?? null,
        JSON.stringify(input.skills ?? []),
        input.max_complexity ?? 10,
      );

    return this.getTeamAgent(id)!;
  }

  getTeamAgents(teamId: string): TeamAgent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM team_agents WHERE team_id = ? ORDER BY level, created_at",
      )
      .all(teamId) as TeamAgentRow[];
    return rows.map(rowToTeamAgent);
  }

  getTeamForExecution(teamId: string): TeamForExecution | null {
    const team = this.getTeam(teamId);
    if (!team || !team.entrypoint_agent_id) return null;

    const agents = this.getTeamAgents(teamId);
    return {
      team,
      entrypoint_agent_id: team.entrypoint_agent_id,
      agents,
    };
  }

  private getTeamAgent(id: string): TeamAgent | null {
    const row = this.db
      .prepare("SELECT * FROM team_agents WHERE id = ?")
      .get(id) as TeamAgentRow | null;
    return row ? rowToTeamAgent(row) : null;
  }
}
