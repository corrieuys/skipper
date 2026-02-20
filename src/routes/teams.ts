import type { Database } from "bun:sqlite";
import { addRoute } from "../server";
import { TeamManager } from "../teams/manager";
import { getDb } from "../db/connection";
import { teamListFragment, teamDetailPage } from "../html/components";
import type { TeamData, TeamAgentData } from "../html/components";

function html(content: string): Response {
  return new Response(content, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function parseBody(req: Request): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await req.formData();
    const body: Record<string, string> = {};
    formData.forEach((value, key) => {
      body[key] = value.toString();
    });
    return body;
  }
  return req.json();
}

function getTeamAgentsWithNames(db: Database, teamId: string): TeamAgentData[] {
  const rows = db
    .prepare(
      `SELECT ta.agent_id, a.name as agent_name, ta.role, ta.level, ta.skills
       FROM team_agents ta JOIN agents a ON ta.agent_id = a.id
       WHERE ta.team_id = ? ORDER BY ta.level`,
    )
    .all(teamId) as (TeamAgentData & { skills: string | string[] })[];
  return rows.map((r) => ({
    ...r,
    skills: typeof r.skills === "string" ? JSON.parse(r.skills) : r.skills,
  }));
}

export function registerTeamRoutes(database?: Database): void {
  const db = database ?? getDb();
  const manager = new TeamManager(db);

  addRoute("POST", "/api/teams", async (req) => {
    const body = await parseBody(req);

    if (!body.name) {
      return Response.json(
        { error: "name is required" },
        { status: 400 },
      );
    }

    const team = manager.createTeam({
      name: body.name,
      goal: body.goal,
      phases: body.phases ? JSON.parse(body.phases) : undefined,
    });

    if (req.headers.get("HX-Request")) {
      const teams = manager.listTeams() as unknown as TeamData[];
      return html(teamListFragment(teams));
    }

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
    const body = await parseBody(req);

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
        level: body.level ? Number(body.level) : undefined,
        parent_agent_id: body.parent_agent_id,
        skills: body.skills ? JSON.parse(body.skills) : undefined,
        max_complexity: body.max_complexity ? Number(body.max_complexity) : undefined,
      });

      if (req.headers.get("HX-Request")) {
        const team = manager.getTeam(params.id) as unknown as TeamData;
        const agents = getTeamAgentsWithNames(db, params.id);
        return html(teamDetailPage(team, agents));
      }

      return Response.json(teamAgent, { status: 201 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/teams/:id/entrypoint", async (req, params) => {
    const body = await parseBody(req);

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
