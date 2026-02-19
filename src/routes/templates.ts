import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { parseRequestBody } from "./utils";

interface TemplateRow {
  id: string;
  template_name: string;
  team_id: string;
  skipper_prompt: string;
  hooks: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TemplatePhaseRow {
  id: string;
  task_template_id: string;
  phase_name: string;
  prompt: string;
  override_prompt: number;
  review_override: string | null;
  consensus_override: string | null;
  created_at: string;
}

interface PhaseToInsert {
  phase_name: string;
  prompt: string;
  override_prompt: number;
  review_override: string | null;
  consensus_override: string | null;
}

export function registerTemplateRoutes(): void {
  const db = getDb();

  // List all active templates, optionally filtered by team
  addRoute("GET", "/api/templates", (req) => {
    const url = new URL(req.url, "http://localhost");
    const teamId = url.searchParams.get("team_id");

    const query = teamId
      ? `SELECT tt.*, tm.name AS team_name
         FROM task_templates tt
         LEFT JOIN teams tm ON tm.id = tt.team_id
         WHERE tt.deleted_at IS NULL AND tt.team_id = ?
         ORDER BY tt.template_name`
      : `SELECT tt.*, tm.name AS team_name
         FROM task_templates tt
         LEFT JOIN teams tm ON tm.id = tt.team_id
         WHERE tt.deleted_at IS NULL
         ORDER BY tt.template_name`;

    const rows = teamId
      ? db.prepare(query).all(teamId)
      : db.prepare(query).all();

    return Response.json(rows);
  });

  // List templates for a specific team (used by task creation dropdown)
  addRoute("GET", "/api/templates/by-team/:teamId", (_req, params) => {
    const rows = db
      .prepare(
        `SELECT id, template_name FROM task_templates
         WHERE team_id = ? AND deleted_at IS NULL
         ORDER BY template_name`,
      )
      .all(params.teamId) as Array<{ id: string; template_name: string }>;
    return Response.json(rows);
  });

  // Get a single template with its phases
  addRoute("GET", "/api/templates/:id", (_req, params) => {
    const template = db
      .prepare("SELECT * FROM task_templates WHERE id = ? AND deleted_at IS NULL")
      .get(params.id) as TemplateRow | null;
    if (!template) return Response.json({ error: "Template not found" }, { status: 404 });

    const phases = db
      .prepare(
        "SELECT * FROM task_template_phases WHERE task_template_id = ? ORDER BY phase_name",
      )
      .all(params.id) as TemplatePhaseRow[];

    let parsedHooks: unknown[] = [];
    try { parsedHooks = JSON.parse(template.hooks || "[]"); } catch { /* ignore */ }
    return Response.json({ ...template, hooks: parsedHooks, phases });
  });

  // Create a new template (supports JSON body and HTML form submission)
  addRoute("POST", "/api/templates", async (req) => {
    const contentType = req.headers.get("content-type") ?? "";
    const isForm = contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data");
    const isHtmx = !!req.headers.get("HX-Request");

    let template_name: string | undefined;
    let team_id: string | undefined;
    let skipper_prompt: string | undefined;
    let phasesToInsert: PhaseToInsert[] = [];
    let hooksJson = "[]";

    if (isForm) {
      const formData = await req.formData();
      template_name = (formData.get("template_name") as string | null)?.trim();
      team_id = (formData.get("team_id") as string | null)?.trim();
      skipper_prompt = ((formData.get("skipper_prompt") as string | null) ?? "").trim();
      const hooksRaw = formData.get("hooks") as string | null;
      if (hooksRaw) { try { const parsed = JSON.parse(hooksRaw); if (Array.isArray(parsed)) hooksJson = JSON.stringify(parsed); } catch { /* ignore */ } }
      for (const [key, value] of formData.entries()) {
        if (key.startsWith("phase_") && key.length > 6) {
          phasesToInsert.push({ phase_name: key.slice(6), prompt: String(value).trim(), override_prompt: 0, review_override: null, consensus_override: null });
        }
      }
    } else {
      const body = await req.json() as Record<string, unknown>;
      template_name = typeof body.template_name === "string" ? body.template_name.trim() : undefined;
      team_id = typeof body.team_id === "string" ? body.team_id.trim() : undefined;
      skipper_prompt = typeof body.skipper_prompt === "string" ? body.skipper_prompt.trim() : "";
      if (Array.isArray(body.hooks)) {
        const validHooks = (body.hooks as Array<Record<string, unknown>>).filter(
          (h) => typeof h.event === "string" && typeof h.template === "string" && typeof h.type === "string",
        );
        if (validHooks.length > 0) hooksJson = JSON.stringify(validHooks);
      }
      if (Array.isArray(body.phases)) {
        phasesToInsert = (body.phases as Array<{ phase_name?: string; prompt?: string; override_prompt?: boolean; review_override?: boolean | null; consensus_override?: unknown }>)
          .filter(p => p.phase_name?.trim())
          .map(p => ({
            phase_name: p.phase_name!.trim(),
            prompt: p.prompt?.trim() ?? "",
            override_prompt: p.override_prompt ? 1 : 0,
            review_override: p.review_override !== undefined && p.review_override !== null ? JSON.stringify(p.review_override) : null,
            consensus_override: p.consensus_override !== undefined && p.consensus_override !== null ? JSON.stringify(p.consensus_override) : null,
          }));
      }
    }

    if (!template_name) {
      if (isHtmx) return new Response("", { status: 200, headers: { "HX-Redirect": "/templates/new" } });
      return Response.json({ error: "template_name is required" }, { status: 400 });
    }
    if (!team_id) {
      if (isHtmx) return new Response("", { status: 200, headers: { "HX-Redirect": "/templates/new" } });
      return Response.json({ error: "team_id is required" }, { status: 400 });
    }

    const team = db.prepare("SELECT id FROM teams WHERE id = ?").get(team_id) as { id: string } | null;
    if (!team) {
      if (isHtmx) return new Response("", { status: 200, headers: { "HX-Redirect": "/templates/new" } });
      return Response.json({ error: "Team not found" }, { status: 404 });
    }

    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO task_templates (id, template_name, team_id, skipper_prompt, hooks) VALUES (?, ?, ?, ?, ?)",
    ).run(id, template_name, team_id, skipper_prompt ?? "", hooksJson);

    for (const phase of phasesToInsert) {
      db.prepare(
        "INSERT INTO task_template_phases (id, task_template_id, phase_name, prompt, override_prompt, review_override, consensus_override) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(crypto.randomUUID(), id, phase.phase_name, phase.prompt, phase.override_prompt, phase.review_override, phase.consensus_override);
    }

    if (isHtmx) return new Response("", { status: 200, headers: { "HX-Redirect": "/templates" } });

    const created = db.prepare("SELECT * FROM task_templates WHERE id = ?").get(id) as TemplateRow;
    const createdPhases = db
      .prepare("SELECT * FROM task_template_phases WHERE task_template_id = ? ORDER BY phase_name")
      .all(id) as TemplatePhaseRow[];
    let createdHooks: unknown[] = [];
    try { createdHooks = JSON.parse(created.hooks || "[]"); } catch { /* ignore */ }
    return Response.json({ ...created, hooks: createdHooks, phases: createdPhases }, { status: 201 });
  });

  // Update a template (supports JSON body and HTML form submission via hx-put)
  addRoute("PUT", "/api/templates/:id", async (req, params) => {
    const template = db
      .prepare("SELECT * FROM task_templates WHERE id = ? AND deleted_at IS NULL")
      .get(params.id) as TemplateRow | null;
    if (!template) return Response.json({ error: "Template not found" }, { status: 404 });

    const isHtmx = !!req.headers.get("HX-Request");
    const contentType = req.headers.get("content-type") ?? "";
    const isForm = contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data");

    let newTemplateName = template.template_name;
    let newSkipperPrompt = template.skipper_prompt;
    let phasesToReplace: PhaseToInsert[] | null = null;
    let newHooksJson: string | null = null;

    if (isForm) {
      const formData = await req.formData();
      const name = (formData.get("template_name") as string | null)?.trim();
      if (name) newTemplateName = name;
      newSkipperPrompt = ((formData.get("skipper_prompt") as string | null) ?? "").trim();
      const hooksRaw = formData.get("hooks") as string | null;
      if (hooksRaw) { try { const parsed = JSON.parse(hooksRaw); if (Array.isArray(parsed)) newHooksJson = JSON.stringify(parsed); } catch { /* ignore */ } }
      phasesToReplace = [];
      for (const [key, value] of formData.entries()) {
        if (key.startsWith("phase_") && key.length > 6) {
          phasesToReplace.push({ phase_name: key.slice(6), prompt: String(value).trim(), override_prompt: 0, review_override: null, consensus_override: null });
        }
      }
    } else {
      const body = await req.json() as Record<string, unknown>;
      if (typeof body.template_name === "string" && body.template_name.trim()) newTemplateName = body.template_name.trim();
      if (typeof body.skipper_prompt === "string") newSkipperPrompt = body.skipper_prompt.trim();
      if (Array.isArray(body.hooks)) {
        const validHooks = (body.hooks as Array<Record<string, unknown>>).filter(
          (h) => typeof h.event === "string" && typeof h.template === "string" && typeof h.type === "string",
        );
        newHooksJson = JSON.stringify(validHooks);
      }
      if (Array.isArray(body.phases)) {
        phasesToReplace = (body.phases as Array<{ phase_name?: string; prompt?: string; override_prompt?: boolean; review_override?: boolean | null; consensus_override?: unknown }>)
          .filter(p => p.phase_name?.trim())
          .map(p => ({
            phase_name: p.phase_name!.trim(),
            prompt: p.prompt?.trim() ?? "",
            override_prompt: p.override_prompt ? 1 : 0,
            review_override: p.review_override !== undefined && p.review_override !== null ? JSON.stringify(p.review_override) : null,
            consensus_override: p.consensus_override !== undefined && p.consensus_override !== null ? JSON.stringify(p.consensus_override) : null,
          }));
      }
    }

    db.prepare(
      "UPDATE task_templates SET template_name = ?, skipper_prompt = ?, hooks = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(newTemplateName, newSkipperPrompt, newHooksJson ?? (template as Record<string, unknown>).hooks ?? "[]", params.id);

    if (phasesToReplace !== null) {
      db.prepare("DELETE FROM task_template_phases WHERE task_template_id = ?").run(params.id);
      for (const phase of phasesToReplace) {
        db.prepare(
          "INSERT INTO task_template_phases (id, task_template_id, phase_name, prompt, override_prompt, review_override, consensus_override) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(crypto.randomUUID(), params.id, phase.phase_name, phase.prompt, phase.override_prompt, phase.review_override, phase.consensus_override);
      }
    }

    if (isHtmx) return new Response("", { status: 200, headers: { "HX-Redirect": "/templates" } });

    const updated = db.prepare("SELECT * FROM task_templates WHERE id = ?").get(params.id) as TemplateRow;
    const updatedPhases = db
      .prepare("SELECT * FROM task_template_phases WHERE task_template_id = ? ORDER BY phase_name")
      .all(params.id) as TemplatePhaseRow[];
    let updatedHooks: unknown[] = [];
    try { updatedHooks = JSON.parse(updated.hooks || "[]"); } catch { /* ignore */ }
    return Response.json({ ...updated, hooks: updatedHooks, phases: updatedPhases });
  });

  // Soft-delete a template
  addRoute("DELETE", "/api/templates/:id", (_req, params) => {
    db.prepare(
      "UPDATE task_templates SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
    ).run(params.id);
    // Return empty body — HTMX with hx-swap="outerHTML" on the row removes it
    return new Response("", { status: 200 });
  });

  // Form-based create (HTML form submission)
  addRoute("POST", "/api/templates/create", async (req) => {
    const formData = await req.formData();
    const templateName = (formData.get("templateName") as string | null)?.trim();
    const teamId = (formData.get("teamId") as string | null)?.trim();
    const skipperPrompt = ((formData.get("skipperPrompt") as string | null) ?? "").trim();
    const phaseNames = formData.getAll("phaseName") as string[];
    const phasePrompts = formData.getAll("phasePrompt") as string[];
    const phaseOverridePrompts = formData.getAll("phaseOverridePrompt") as string[];
    const phaseReviewOverrides = formData.getAll("phaseReviewOverride") as string[];
    const phaseConsensusOverrides = formData.getAll("phaseConsensusOverride") as string[];

    if (!templateName) {
      return new Response("", { status: 302, headers: { Location: "/templates/new?error=name+required" } });
    }
    if (!teamId) {
      return new Response("", { status: 302, headers: { Location: "/templates/new?error=team+required" } });
    }

    const team = db.prepare("SELECT id FROM teams WHERE id = ?").get(teamId) as { id: string } | null;
    if (!team) {
      return new Response("", { status: 302, headers: { Location: "/templates/new?error=team+not+found" } });
    }

    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO task_templates (id, template_name, team_id, skipper_prompt) VALUES (?, ?, ?, ?)",
    ).run(id, templateName, teamId, skipperPrompt);

    phaseNames.forEach((name, i) => {
      const pname = name.trim();
      const prompt = ((phasePrompts[i] as string | undefined) ?? "").trim();
      if (pname) {
        const overridePrompt = phaseOverridePrompts[i] === "1" ? 1 : 0;
        const reviewVal = (phaseReviewOverrides[i] as string | undefined) ?? "inherit";
        const reviewOverride = reviewVal === "enabled" ? "true" : reviewVal === "disabled" ? "false" : null;
        const consensusVal = (phaseConsensusOverrides[i] as string | undefined) ?? "inherit";
        const consensusOverride = consensusVal === "inherit" ? null : consensusVal === "disabled" ? '{"disabled":true}' : consensusVal;
        db.prepare(
          "INSERT INTO task_template_phases (id, task_template_id, phase_name, prompt, override_prompt, review_override, consensus_override) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(crypto.randomUUID(), id, pname, prompt, overridePrompt, reviewOverride, consensusOverride);
      }
    });

    if (req.headers.get("HX-Request")) {
      return new Response("", { status: 200, headers: { "HX-Redirect": "/templates" } });
    }
    return new Response("", { status: 302, headers: { Location: "/templates" } });
  });

  // Form-based update (HTML form submission)
  addRoute("POST", "/api/templates/:id/update", async (req, params) => {
    const template = db
      .prepare("SELECT * FROM task_templates WHERE id = ? AND deleted_at IS NULL")
      .get(params.id) as TemplateRow | null;
    if (!template) {
      return new Response("", { status: 302, headers: { Location: "/templates" } });
    }

    const formData = await req.formData();
    const templateName = ((formData.get("templateName") as string | null) ?? "").trim() || template.template_name;
    const skipperPrompt = ((formData.get("skipperPrompt") as string | null) ?? "").trim();
    const phaseNames = formData.getAll("phaseName") as string[];
    const phasePrompts = formData.getAll("phasePrompt") as string[];
    const phaseOverridePrompts = formData.getAll("phaseOverridePrompt") as string[];
    const phaseReviewOverrides = formData.getAll("phaseReviewOverride") as string[];
    const phaseConsensusOverrides = formData.getAll("phaseConsensusOverride") as string[];

    db.prepare(
      "UPDATE task_templates SET template_name = ?, skipper_prompt = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(templateName, skipperPrompt, params.id);

    db.prepare("DELETE FROM task_template_phases WHERE task_template_id = ?").run(params.id);
    phaseNames.forEach((name, i) => {
      const pname = name.trim();
      const prompt = ((phasePrompts[i] as string | undefined) ?? "").trim();
      if (pname) {
        const overridePrompt = phaseOverridePrompts[i] === "1" ? 1 : 0;
        const reviewVal = (phaseReviewOverrides[i] as string | undefined) ?? "inherit";
        const reviewOverride = reviewVal === "enabled" ? "true" : reviewVal === "disabled" ? "false" : null;
        const consensusVal = (phaseConsensusOverrides[i] as string | undefined) ?? "inherit";
        const consensusOverride = consensusVal === "inherit" ? null : consensusVal === "disabled" ? '{"disabled":true}' : consensusVal;
        db.prepare(
          "INSERT INTO task_template_phases (id, task_template_id, phase_name, prompt, override_prompt, review_override, consensus_override) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(crypto.randomUUID(), params.id, pname, prompt, overridePrompt, reviewOverride, consensusOverride);
      }
    });

    if (req.headers.get("HX-Request")) {
      return new Response("", { status: 200, headers: { "HX-Redirect": "/templates" } });
    }
    return new Response("", { status: 302, headers: { Location: "/templates" } });
  });

  // Form-based soft delete (HTML form submission)
  addRoute("POST", "/api/templates/:id/delete", (_req, params) => {
    db.prepare(
      "UPDATE task_templates SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
    ).run(params.id);

    if (_req.headers.get("HX-Request")) {
      return new Response("", { status: 200, headers: { "HX-Redirect": "/templates" } });
    }
    return new Response("", { status: 302, headers: { Location: "/templates" } });
  });
}
