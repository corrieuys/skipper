import type { Database } from "bun:sqlite";
import { addDataRoute } from "./auth";
import { TeamManager } from "../../teams/manager";
import { getAgent, getTeam } from "../../config/store";
import {
  getLocalTeam,
  createLocalTeam,
  updateLocalTeam,
  deleteLocalTeam,
} from "../../teams/local-teams";
import { toTeamInput } from "../../teams/team-input";
import { findSlashCommandConflict } from "../../slack/bindings";
import { ok, err } from "./envelope";

export function registerDataTeamRoutes(db: Database, _daemon?: unknown): void {
  const manager = new TeamManager(db);

  // A slash command binds to one target only (same rule as /api/teams).
  const slashConflict = (input: ReturnType<typeof toTeamInput>, excludeTeamId?: string): string | null => {
    const cmd = input.config?.slashCommand;
    if (!cmd) return null;
    const conflict = findSlashCommandConflict(db, cmd, { teamId: excludeTeamId });
    if (!conflict) return null;
    const target = conflict.kind === "team" ? "team" : "recurring task";
    return `Slash command ${cmd} is already bound to ${target} "${conflict.label}".`;
  };

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

  // POST /data/teams — create (JSON body, same shape as /api/teams)
  addDataRoute("POST", "/data/teams", async (req) => {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return err("invalid JSON body");
    }
    const input = toTeamInput(body, { withId: true });
    const conflict = slashConflict(input);
    if (conflict) return err(conflict);
    try {
      return ok(createLocalTeam(db, input), 201);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  // PUT /data/teams/:id — update
  addDataRoute("PUT", "/data/teams/:id", async (req, params) => {
    const existing = getLocalTeam(db, params.id);
    if (!existing) return err("Team not found", 404);
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return err("invalid JSON body");
    }
    const input = toTeamInput(body, { existingConfig: existing.config });
    const conflict = slashConflict(input, params.id);
    if (conflict) return err(conflict);
    try {
      return ok(updateLocalTeam(db, params.id, input));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  // DELETE /data/teams/:id
  addDataRoute("DELETE", "/data/teams/:id", (_req, params) => {
    const deleted = deleteLocalTeam(db, params.id);
    if (!deleted) return err("Team not found", 404);
    return ok({ deleted: true });
  });
}
