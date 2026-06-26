import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { addRoute } from "../server";
import { getDb } from "../db/connection";
import type { TeamPhase } from "../config/store";
import {
  type LocalTeam,
  type LocalTeamAgent,
  type LocalTeamInput,
  listLocalTeams,
  getLocalTeam,
  createLocalTeam,
  updateLocalTeam,
  deleteLocalTeam,
} from "../teams/local-teams";

// ---------------------------------------------------------------------------
// HTTP routes for teams: CRUD plus JSON import/export. A team embeds its own
// agents and phases; Skipper is the implicit lead.
// ---------------------------------------------------------------------------

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ensureUniqueId(base: string, used: Set<string>): string {
  let candidate = base || `agent-${randomUUID().slice(0, 8)}`;
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let i = 2;
  while (used.has(`${candidate}-${i}`)) i++;
  const id = `${candidate}-${i}`;
  used.add(id);
  return id;
}

/** Coerce an arbitrary phase-shaped value into a TeamPhase. */
function coercePhase(raw: unknown): TeamPhase | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name) return null;
  const phase: TeamPhase = {
    name,
    prompt: typeof p.prompt === "string" ? p.prompt : "",
  };
  if (typeof p.review === "boolean") phase.review = p.review;
  if (p.consensus && typeof p.consensus === "object") {
    const c = p.consensus as Record<string, unknown>;
    phase.consensus = {
      agent_count: typeof c.agent_count === "number" ? c.agent_count : 2,
      strategy: typeof c.strategy === "string" ? c.strategy : "best_of",
      worktree: !!c.worktree,
      ...(typeof c.reviewer_agent_id === "string" ? { reviewer_agent_id: c.reviewer_agent_id } : {}),
    };
  }
  return phase;
}

/** Coerce an arbitrary agent-shaped value into a LocalTeamAgent, assigning an id if missing. */
function coerceAgent(raw: unknown, usedIds: Set<string>): LocalTeamAgent | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const name = typeof a.name === "string" ? a.name.trim() : "";
  const type = typeof a.type === "string" ? a.type.trim() : "";
  const model = typeof a.model === "string" ? a.model.trim() : "";
  if (!type) return null;
  const requestedId = typeof a.id === "string" && a.id.trim() ? a.id.trim() : slugify(name);
  const id = ensureUniqueId(requestedId, usedIds);
  const agent: LocalTeamAgent = {
    id,
    name: name || id,
    type,
    model,
  };
  if (typeof a.instruction === "string") agent.instruction = a.instruction;
  if (typeof a.role === "string") agent.role = a.role;
  if (typeof a.parent_agent_id === "string") agent.parent_agent_id = a.parent_agent_id;
  if (Array.isArray(a.capabilities)) {
    agent.capabilities = (a.capabilities as unknown[]).filter((c): c is string => typeof c === "string");
  }
  return agent;
}

/** Build a LocalTeamInput from a raw JSON object (used by create/update/import). */
function toInput(body: Record<string, unknown>, opts: { withId?: boolean } = {}): LocalTeamInput {
  const usedIds = new Set<string>();
  const rawAgents = Array.isArray(body.agents) ? body.agents : [];
  const agents = rawAgents
    .map((a) => coerceAgent(a, usedIds))
    .filter((a): a is LocalTeamAgent => a !== null);
  const rawPhases = Array.isArray(body.phases) ? body.phases : [];
  const phases = rawPhases
    .map(coercePhase)
    .filter((p): p is TeamPhase => p !== null);

  const input: LocalTeamInput = {
    name: typeof body.name === "string" ? body.name.trim() : "",
    skipper_prompt: typeof body.skipper_prompt === "string" ? body.skipper_prompt : "",
    hooks: Array.isArray(body.hooks) ? body.hooks : [],
    phases,
    agents,
  };
  if (opts.withId && typeof body.id === "string" && body.id.trim()) {
    input.id = body.id.trim();
  }
  return input;
}

/** Round-trippable export shape: identical to the import/create body. */
function toExportShape(team: LocalTeam): Record<string, unknown> {
  return {
    id: team.id,
    name: team.name,
    skipper_prompt: team.skipper_prompt,
    hooks: team.hooks,
    phases: team.phases,
    agents: team.agents,
  };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const contentType = req.headers.get("content-type") ?? "";
  const isForm =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data");
  if (isForm) {
    const formData = await req.formData();
    const body: Record<string, unknown> = {};
    body.name = (formData.get("name") as string | null) ?? undefined;
    body.skipper_prompt = (formData.get("skipper_prompt") as string | null) ?? undefined;
    const id = formData.get("id") as string | null;
    if (id) body.id = id;
    // phases / agents / hooks may arrive as JSON-encoded strings from the form.
    for (const key of ["phases", "agents", "hooks"]) {
      const raw = formData.get(key) as string | null;
      if (raw) {
        try {
          body[key] = JSON.parse(raw);
        } catch {
          /* ignore malformed JSON field */
        }
      }
    }
    return body;
  }
  return (await req.json()) as Record<string, unknown>;
}

export function registerTeamRoutes(database?: Database): void {
  const db = database ?? getDb();

  // ----- List -----
  addRoute("GET", "/api/teams", () => {
    return Response.json(listLocalTeams(db));
  });

  // ----- Export (must be registered before :id so it is not shadowed) -----
  addRoute("GET", "/api/teams/export", (req) => {
    const url = new URL(req.url, "http://localhost");
    const id = url.searchParams.get("id");
    let teams: LocalTeam[];
    let filename: string;
    if (id) {
      const team = getLocalTeam(db, id);
      if (!team) return Response.json({ error: "Team not found" }, { status: 404 });
      teams = [team];
      filename = `team-${id}.json`;
    } else {
      teams = listLocalTeams(db);
      filename = "teams-export.json";
    }
    const payload = { teams: teams.map(toExportShape) };
    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  });

  // ----- Import -----
  addRoute("POST", "/api/teams/import", async (req) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }

    let rawTeams: unknown[];
    if (Array.isArray(body)) {
      rawTeams = body;
    } else if (body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).teams)) {
      rawTeams = (body as Record<string, unknown>).teams as unknown[];
    } else {
      return Response.json({ error: "expected an array of teams or { teams: [...] }" }, { status: 400 });
    }

    let imported = 0;
    let updated = 0;
    const errors: Array<{ team: string; error: string }> = [];

    for (const raw of rawTeams) {
      if (!raw || typeof raw !== "object") {
        errors.push({ team: "(unknown)", error: "not an object" });
        continue;
      }
      const obj = raw as Record<string, unknown>;
      const label =
        (typeof obj.id === "string" && obj.id) ||
        (typeof obj.name === "string" && obj.name) ||
        "(unnamed)";
      try {
        const input = toInput(obj, { withId: true });
        if (input.id && getLocalTeam(db, input.id)) {
          updateLocalTeam(db, input.id, input);
          updated++;
        } else {
          createLocalTeam(db, input);
          imported++;
        }
      } catch (e) {
        errors.push({ team: label, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return Response.json({ imported, updated, errors });
  });

  // ----- Get one (with inline agents + phases) -----
  addRoute("GET", "/api/teams/:id", (_req, params) => {
    const team = getLocalTeam(db, params.id!);
    if (!team) return Response.json({ error: "Team not found" }, { status: 404 });
    return Response.json(team);
  });

  // ----- Create (JSON or HTML form) -----
  addRoute("POST", "/api/teams", async (req) => {
    const isHtmx = !!req.headers.get("HX-Request");
    let input: LocalTeamInput;
    try {
      const body = await readBody(req);
      input = toInput(body, { withId: true });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
    try {
      const team = createLocalTeam(db, input);
      if (isHtmx) return new Response("", { status: 200, headers: { "HX-Redirect": "/config" } });
      return Response.json(team, { status: 201 });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  });

  // ----- Update (PUT or POST, JSON or HTML form) -----
  const updateHandler = async (req: Request, params: Record<string, string>) => {
    const isHtmx = !!req.headers.get("HX-Request");
    const id = params.id!;
    if (!getLocalTeam(db, id)) {
      return Response.json({ error: "Team not found" }, { status: 404 });
    }
    let input: LocalTeamInput;
    try {
      const body = await readBody(req);
      input = toInput(body);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
    try {
      const team = updateLocalTeam(db, id, input);
      if (isHtmx) return new Response("", { status: 200, headers: { "HX-Redirect": "/config" } });
      return Response.json(team);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  };
  addRoute("PUT", "/api/teams/:id", updateHandler);
  addRoute("POST", "/api/teams/:id/update", updateHandler);

  // ----- Delete -----
  addRoute("DELETE", "/api/teams/:id", (_req, params) => {
    const ok = deleteLocalTeam(db, params.id!);
    if (!ok) return Response.json({ error: "Team not found" }, { status: 404 });
    return new Response("", { status: 200 });
  });

  // Form-based delete (HTML)
  addRoute("POST", "/api/teams/:id/delete", (req, params) => {
    deleteLocalTeam(db, params.id!);
    if (req.headers.get("HX-Request")) {
      return new Response("", { status: 200, headers: { "HX-Redirect": "/config" } });
    }
    return new Response("", { status: 302, headers: { Location: "/config" } });
  });
}
