import type { Database } from "bun:sqlite";
import { addRoute } from "../server";
import { TeamManager } from "../teams/manager";
import { getDb } from "../db/connection";
import type { DaemonStatus } from "../html/components";

export function registerTeamRoutes(
  database?: Database,
  _daemon?: Pick<{ getStatus: () => DaemonStatus }, "getStatus">,
): void {
  const db = database ?? getDb();
  const manager = new TeamManager(db);

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
}
