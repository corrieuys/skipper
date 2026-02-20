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

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await req.formData();
    const body: Record<string, unknown> = {};
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
      `SELECT ta.agent_id, a.name as agent_name, ta.role, ta.level, ta.max_complexity, a.capabilities
       FROM team_agents ta JOIN agents a ON ta.agent_id = a.id
       WHERE ta.team_id = ? ORDER BY ta.level`,
    )
    .all(teamId) as (TeamAgentData & { capabilities: string | string[] })[];
  return rows.map((r) => ({
    ...r,
    capabilities: typeof r.capabilities === "string" ? JSON.parse(r.capabilities) : r.capabilities,
  }));
}

function getAvailableAgentsForTeam(db: Database, teamId: string): { id: string; name: string }[] {
  return db.prepare(
    `SELECT a.id, a.name
     FROM agents a
     WHERE a.id NOT IN (SELECT ta.agent_id FROM team_agents ta WHERE ta.team_id = ?)
     ORDER BY a.name`,
  ).all(teamId) as { id: string; name: string }[];
}

function getTeamWithEntrypointName(db: Database, teamId: string): TeamData | null {
  const row = db.prepare(
    `SELECT t.*, a.name AS entrypoint_agent_name
     FROM teams t
     LEFT JOIN agents a ON a.id = t.entrypoint_agent_id
     WHERE t.id = ?`,
  ).get(teamId) as (TeamData & { phases: string | TeamData["phases"] }) | null;

  if (!row) return null;

  return {
    ...row,
    phases: typeof row.phases === "string" ? JSON.parse(row.phases) : row.phases,
  };
}

function getTeamsWithEntrypointName(db: Database): TeamData[] {
  const rows = db.prepare(
    `SELECT t.*, a.name AS entrypoint_agent_name
     FROM teams t
     LEFT JOIN agents a ON a.id = t.entrypoint_agent_id
     ORDER BY t.created_at`,
  ).all() as (TeamData & { phases: string | TeamData["phases"] })[];

  return rows.map((row) => ({
    ...row,
    phases: typeof row.phases === "string" ? JSON.parse(row.phases) : row.phases,
  }));
}

function renderTeamDetailPage(db: Database, teamId: string): Response {
  const team = getTeamWithEntrypointName(db, teamId);
  if (!team) return html("<p>Team not found</p>");
  const agents = getTeamAgentsWithNames(db, teamId);
  const availableAgents = getAvailableAgentsForTeam(db, teamId);
  return html(teamDetailPage(team, agents, availableAgents));
}

function normalizeSkills(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(
      new Map(
        value
          .map((entry) => String(entry).trim())
          .filter((entry) => entry.length > 0)
          .map((entry) => [entry.toLowerCase(), entry]),
      ).values(),
    );
  }

  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return normalizeSkills(parsed);
    } catch {
      // fallback to comma split
    }
  }

  return Array.from(
    new Map(
      trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => [entry.toLowerCase(), entry]),
    ).values(),
  );
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function registerTeamRoutes(database?: Database): void {
  const db = database ?? getDb();
  const manager = new TeamManager(db);

  addRoute("POST", "/api/teams", async (req) => {
    const body = await parseBody(req);

    if (typeof body.name !== "string" || !body.name.trim()) {
      return Response.json(
        { error: "name is required" },
        { status: 400 },
      );
    }

    const team = manager.createTeam({
      name: body.name,
      goal: typeof body.goal === "string" ? body.goal : undefined,
      phases: typeof body.phases === "string" ? JSON.parse(body.phases) : undefined,
    });

    if (req.headers.get("HX-Request")) {
      const teams = getTeamsWithEntrypointName(db);
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

  addRoute("POST", "/api/teams/:id", async (req, params) => {
    const body = await parseBody(req);

    if (typeof body.name !== "string" || !body.name.trim()) {
      return Response.json(
        { error: "name is required" },
        { status: 400 },
      );
    }

    try {
      const team = manager.updateTeam(params.id, {
        name: body.name,
        goal: typeof body.goal === "string" ? body.goal : undefined,
      }) as unknown as TeamData;

      if (req.headers.get("HX-Request")) {
        return renderTeamDetailPage(db, params.id);
      }

      return Response.json(team);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/teams/:id/agents", async (req, params) => {
    const body = await parseBody(req);

    if (typeof body.agent_id !== "string" || !body.agent_id.trim()) {
      return Response.json(
        { error: "agent_id is required" },
        { status: 400 },
      );
    }

    try {
      const teamAgent = manager.addAgent(params.id, {
        agent_id: body.agent_id,
        role: typeof body.role === "string" ? body.role : undefined,
        level: parseOptionalNumber(body.level),
        parent_agent_id: typeof body.parent_agent_id === "string" ? body.parent_agent_id : undefined,
        max_complexity: parseOptionalNumber(body.max_complexity),
      });

      if (req.headers.get("HX-Request")) {
        return renderTeamDetailPage(db, params.id);
      }

      return Response.json(teamAgent, { status: 201 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("POST", "/api/teams/:id/agents/:agent_id", async (req, params) => {
    const body = await parseBody(req);
    const level = parseOptionalNumber(body.level);
    const maxComplexity = parseOptionalNumber(body.max_complexity);

    if (level !== undefined && (!Number.isInteger(level) || level < 0)) {
      return Response.json({ error: "level must be an integer >= 0" }, { status: 400 });
    }
    if (maxComplexity !== undefined && (!Number.isInteger(maxComplexity) || maxComplexity < 1 || maxComplexity > 10)) {
      return Response.json({ error: "max_complexity must be an integer between 1 and 10" }, { status: 400 });
    }

    if (!manager.isTeamMember(params.id, params.agent_id)) {
      return Response.json({ error: "Team member not found" }, { status: 404 });
    }

    try {
      const member = manager.updateTeamAgent(params.id, params.agent_id, {
        role: typeof body.role === "string" ? body.role : undefined,
        level,
        max_complexity: maxComplexity,
      });

      const skills = normalizeSkills(body.skills ?? body.capabilities);
      db.prepare(
        "UPDATE agents SET capabilities = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(JSON.stringify(skills), params.agent_id);

      if (req.headers.get("HX-Request")) {
        return renderTeamDetailPage(db, params.id);
      }

      return Response.json({
        ...member,
        skills,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  addRoute("DELETE", "/api/teams/:id/agents/:agent_id", (req, params) => {
    try {
      manager.removeAgent(params.id, params.agent_id);

      if (req.headers.get("HX-Request")) {
        return renderTeamDetailPage(db, params.id);
      }

      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      const status = message.includes("not found") ? 404 : 400;
      return Response.json({ error: message }, { status });
    }
  });

  addRoute("POST", "/api/teams/:id/phases", async (req, params) => {
    const body = await parseBody(req);

    if (typeof body.name !== "string" || typeof body.prompt !== "string" || !body.name.trim() || !body.prompt.trim()) {
      return Response.json(
        { error: "name and prompt are required" },
        { status: 400 },
      );
    }

    const team = manager.getTeam(params.id);
    if (!team) {
      return Response.json({ error: "Team not found" }, { status: 404 });
    }

    const updatedTeam = manager.updatePhases(params.id, [
      ...team.phases,
      { name: body.name.trim(), prompt: body.prompt.trim() },
    ]) as unknown as TeamData;

    if (req.headers.get("HX-Request")) {
      return renderTeamDetailPage(db, params.id);
    }

    return Response.json(updatedTeam, { status: 201 });
  });

  addRoute("POST", "/api/teams/:id/phases/:index", async (req, params) => {
    const body = await parseBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

    if (!name || !prompt) {
      return Response.json(
        { error: "name and prompt are required" },
        { status: 400 },
      );
    }

    const team = manager.getTeam(params.id);
    if (!team) {
      return Response.json({ error: "Team not found" }, { status: 404 });
    }

    const idx = Number(params.index);
    if (isNaN(idx) || idx < 0 || idx >= team.phases.length) {
      return Response.json({ error: "Invalid phase index" }, { status: 400 });
    }

    const phases = [...team.phases];
    phases[idx] = { name, prompt };
    const updatedTeam = manager.updatePhases(params.id, phases) as unknown as TeamData;

    if (req.headers.get("HX-Request")) {
      return renderTeamDetailPage(db, params.id);
    }

    return Response.json(updatedTeam);
  });

  addRoute("DELETE", "/api/teams/:id/phases/:index", async (req, params) => {
    const team = manager.getTeam(params.id);
    if (!team) {
      return Response.json({ error: "Team not found" }, { status: 404 });
    }

    const idx = Number(params.index);
    if (isNaN(idx) || idx < 0 || idx >= team.phases.length) {
      return Response.json({ error: "Invalid phase index" }, { status: 400 });
    }

    const newPhases = team.phases.filter((_, i) => i !== idx);
    const updatedTeam = manager.updatePhases(params.id, newPhases) as unknown as TeamData;

    if (req.headers.get("HX-Request")) {
      return renderTeamDetailPage(db, params.id);
    }

    return Response.json(updatedTeam);
  });

  addRoute("POST", "/api/teams/:id/entrypoint", async (req, params) => {
    const body = await parseBody(req);

    if (typeof body.agent_id !== "string" || !body.agent_id.trim()) {
      return Response.json(
        { error: "agent_id is required" },
        { status: 400 },
      );
    }

    try {
      manager.setEntrypoint(params.id, body.agent_id.trim());
      if (req.headers.get("HX-Request")) {
        return renderTeamDetailPage(db, params.id);
      }
      const team = manager.getTeam(params.id);
      return Response.json(team);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });
}
