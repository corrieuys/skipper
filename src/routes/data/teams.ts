import type { Database } from "bun:sqlite";
import { addDataRoute } from "./auth";
import { TeamManager } from "../../teams/manager";
import { getAgent, getTeam } from "../../config/store";

function ok(data: unknown, status: number = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

function err(message: string, status: number = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export function registerDataTeamRoutes(db: Database, _daemon?: unknown): void {
  const manager = new TeamManager(db);

  addDataRoute("GET", "/data/teams", () => {
    const teams = manager.listTeams();
    return ok(teams);
  });

  addDataRoute("GET", "/data/teams/:id", (_req, params) => {
    const team = manager.getTeam(params.id);
    if (!team) return err("Team not found", 404);
    return ok(team);
  });

  addDataRoute("GET", "/data/teams/:id/members", (_req, params) => {
    const team = getTeam(params.id);
    if (!team) return err("Team not found", 404);
    const members = team.members
      .map((m) => {
        const agent = getAgent(m.agent_id);
        if (!agent) return null;
        return {
          agent_id: m.agent_id,
          agent_name: agent.name,
          role: m.role,
          level: m.level,
          capabilities: agent.capabilities,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .sort((a, b) => a.level - b.level || a.agent_name.localeCompare(b.agent_name));
    return ok(members);
  });
}
