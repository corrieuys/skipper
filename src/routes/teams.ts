import type { Database } from "bun:sqlite";
import { hxRedirect } from "./utils";
import { addRoute } from "../server";
import { getDb } from "../db/connection";
import {
  type LocalTeam,
  type LocalTeamInput,
  listLocalTeams,
  getLocalTeam,
  createLocalTeam,
  updateLocalTeam,
  deleteLocalTeam,
} from "../teams/local-teams";
import { findSlashCommandConflict } from "../slack/bindings";
import { toTeamInput as toInput } from "../teams/team-input";

// ---------------------------------------------------------------------------
// HTTP routes for teams: CRUD plus JSON import/export. A team embeds its own
// agents and phases; Skipper is the implicit lead.
// ---------------------------------------------------------------------------

/** Round-trippable export shape: identical to the import/create body. */
function toExportShape(team: LocalTeam): Record<string, unknown> {
  return {
    id: team.id,
    name: team.name,
    skipper_prompt: team.skipper_prompt,
    hooks: team.hooks,
    phases: team.phases,
    agents: team.agents,
    config: team.config,
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
    // Only carry the Slack fields when the form actually rendered them (marked by
    // the hidden `slack_section` field). Otherwise leave the keys absent so the
    // update path preserves the stored config instead of wiping it — a save from
    // a build where these fields are hidden must not clear slackEnabled/slashCommand.
    // An unchecked checkbox is absent from the form; presence ⇒ enabled.
    if (formData.get("slack_section") != null) {
      body.slack_enabled = formData.get("slack_enabled") != null;
      body.slash_command = (formData.get("slash_command") as string | null) ?? "";
    }
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

  // A slash command binds to one target only: reject a team save that reuses a
  // command already bound to another team or a recurring task.
  const slashConflictResponse = (input: LocalTeamInput, excludeTeamId?: string): Response | null => {
    const cmd = input.config?.slashCommand;
    if (!cmd) return null;
    const conflict = findSlashCommandConflict(db, cmd, { teamId: excludeTeamId });
    if (!conflict) return null;
    const target = conflict.kind === "team" ? "team" : "recurring task";
    return Response.json(
      { error: `Slash command ${cmd} is already bound to ${target} "${conflict.label}".` },
      { status: 400 },
    );
  };

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
        const existing = typeof obj.id === "string" && obj.id.trim() ? getLocalTeam(db, obj.id.trim()) : null;
        const input = toInput(obj, { withId: true, existingConfig: existing?.config });
        if (input.id && existing) {
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
    const conflict = slashConflictResponse(input);
    if (conflict) return conflict;
    try {
      const team = createLocalTeam(db, input);
      if (isHtmx) return hxRedirect("/teams");
      return Response.json(team, { status: 201 });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  });

  // ----- Update (PUT or POST, JSON or HTML form) -----
  const updateHandler = async (req: Request, params: Record<string, string>) => {
    const isHtmx = !!req.headers.get("HX-Request");
    const id = params.id!;
    const existing = getLocalTeam(db, id);
    if (!existing) {
      return Response.json({ error: "Team not found" }, { status: 404 });
    }
    let input: LocalTeamInput;
    try {
      const body = await readBody(req);
      input = toInput(body, { existingConfig: existing.config });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
    const conflict = slashConflictResponse(input, id);
    if (conflict) return conflict;
    try {
      const team = updateLocalTeam(db, id, input);
      if (isHtmx) return hxRedirect("/teams");
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
      return hxRedirect("/teams");
    }
    return new Response("", { status: 302, headers: { Location: "/teams" } });
  });
}
