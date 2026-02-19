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

export interface ConsensusConfig {
  agent_count: number;
  reviewer_agent_id?: string;
  strategy: 'best_of' | 'merge';
  worktree: boolean;
}

export interface Phase {
  name: string;
  prompt: string;
  review?: boolean;
  consensus?: ConsensusConfig;
}

export interface TeamAgent {
  id: string;
  team_id: string;
  agent_id: string;
  role: string | null;
  level: number;
  parent_agent_id: string | null;
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
    created_at: row.created_at,
  };
}

export interface CreateTeamInput {
  name: string;
  goal?: string;
  phases?: Phase[];
  entrypoint_agent_id?: string;
}

export interface UpdateTeamInput {
  name: string;
  goal?: string;
}

export interface AddTeamAgentInput {
  agent_id: string;
  role?: string;
  level?: number;
  parent_agent_id?: string;
}

export interface UpdateTeamAgentInput {
  role?: string;
  level?: number;
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
        `INSERT INTO teams (id, name, goal, phases, entrypoint_agent_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.goal ?? null, JSON.stringify(input.phases ?? []), input.entrypoint_agent_id ?? null);

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

  updateTeam(teamId: string, input: UpdateTeamInput): Team {
    const team = this.getTeam(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    this.db
      .prepare(
        `UPDATE teams
         SET name = ?, goal = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(input.name.trim(), input.goal?.trim() ? input.goal.trim() : null, teamId);

    return this.getTeam(teamId)!;
  }

  updatePhases(teamId: string, phases: Phase[]): Team {
    const team = this.getTeam(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    for (const phase of phases) {
      if (phase.consensus) {
        const c = phase.consensus;
        if (!Number.isInteger(c.agent_count) || c.agent_count < 2 || c.agent_count > 10) {
          throw new Error(`Phase "${phase.name}": consensus.agent_count must be an integer between 2 and 10`);
        }
        if (!['majority', 'best_of', 'merge'].includes(c.strategy)) {
          throw new Error(`Phase "${phase.name}": consensus.strategy must be 'majority', 'best_of', or 'merge'`);
        }
        if (c.reviewer_agent_id) {
          const isMember = this.db
            .prepare("SELECT id FROM team_agents WHERE team_id = ? AND agent_id = ?")
            .get(teamId, c.reviewer_agent_id);
          if (!isMember) {
            throw new Error(`Phase "${phase.name}": consensus.reviewer_agent_id must be a team member`);
          }
        }
      }
    }

    this.db
      .prepare(
        "UPDATE teams SET phases = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(JSON.stringify(phases), teamId);

    return this.getTeam(teamId)!;
  }

  setEntrypoint(teamId: string, agentId: string): void {
    const team = this.getTeam(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    // Validate agent is a team member
    const membership = this.db
      .prepare("SELECT id FROM team_agents WHERE team_id = ? AND agent_id = ?")
      .get(teamId, agentId);
    if (!membership) throw new Error("Agent must be a member of the team");

    this.db
      .prepare(
        `UPDATE teams SET entrypoint_agent_id = ?, updated_at = datetime('now') WHERE id = ?`,
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
        `INSERT INTO team_agents (id, team_id, agent_id, role, level, parent_agent_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        teamId,
        input.agent_id,
        input.role ?? null,
        input.level ?? 0,
        input.parent_agent_id ?? null,
      );

    return this.getTeamAgent(id)!;
  }

  isTeamMember(teamId: string, agentId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 as found FROM team_agents WHERE team_id = ? AND agent_id = ? LIMIT 1")
      .get(teamId, agentId) as { found: number } | null;
    return !!row;
  }

  updateTeamAgent(teamId: string, agentId: string, input: UpdateTeamAgentInput): TeamAgent {
    const row = this.db
      .prepare("SELECT id, level FROM team_agents WHERE team_id = ? AND agent_id = ?")
      .get(teamId, agentId) as { id: string; level: number } | null;

    if (!row) throw new Error("Team member not found");

    this.db
      .prepare(
        `UPDATE team_agents
         SET role = ?, level = ?
         WHERE team_id = ? AND agent_id = ?`,
      )
      .run(
        input.role?.trim() ? input.role.trim() : null,
        input.level ?? row.level,
        teamId,
        agentId,
      );

    return this.getTeamAgent(row.id)!;
  }

  removeAgent(teamId: string, agentId: string): void {
    const membership = this.db
      .prepare("SELECT id FROM team_agents WHERE team_id = ? AND agent_id = ?")
      .get(teamId, agentId) as { id: string } | null;
    if (!membership) throw new Error("Team member not found");

    this.db
      .prepare("DELETE FROM team_agents WHERE team_id = ? AND agent_id = ?")
      .run(teamId, agentId);

    this.db
      .prepare(
        `UPDATE teams
         SET entrypoint_agent_id = NULL, updated_at = datetime('now')
         WHERE id = ? AND entrypoint_agent_id = ?`,
      )
      .run(teamId, agentId);
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
    if (!team) return null;
    if (!team.entrypoint_agent_id) return null;

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
