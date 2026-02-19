import { addRoute } from "../server";
import { TeamManager } from "../teams/manager";

export function registerTeamRoutes(): void {
  const manager = new TeamManager();

  addRoute("POST", "/api/teams", async (req) => {
    const body = await req.json();

    if (!body.name) {
      return Response.json(
        { error: "name is required" },
        { status: 400 },
      );
    }

    const team = manager.createTeam({
      name: body.name,
      goal: body.goal,
      phases: body.phases,
    });
    return Response.json(team, { status: 201 });
  });

  addRoute("GET", "/api/teams", () => {
    const teams = manager.listTeams();
    return Response.json(teams);
  });

  addRoute("GET", "/api/teams/:id", (_req, params) => {
    const team = manager.getTeam(params.id);
    if (!team) {
      return Response.json({ error: "Team not found" }, { status: 404 });
    }
    return Response.json(team);
  });

  addRoute("POST", "/api/teams/:id/agents", async (req, params) => {
    const body = await req.json();

    if (!body.agent_id) {
      return Response.json(
        { error: "agent_id is required" },
        { status: 400 },
      );
    }

    try {
      const teamAgent = manager.addAgent(params.id, {
        agent_id: body.agent_id,
        role: body.role,
        level: body.level,
        parent_agent_id: body.parent_agent_id,
        skills: body.skills,
        max_complexity: body.max_complexity,
      });
      return Response.json(teamAgent, { status: 201 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/teams/:id/entrypoint", async (req, params) => {
    const body = await req.json();

    if (!body.agent_id) {
      return Response.json(
        { error: "agent_id is required" },
        { status: 400 },
      );
    }

    try {
      manager.setEntrypoint(params.id, body.agent_id);
      const team = manager.getTeam(params.id);
      return Response.json(team);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });
}
