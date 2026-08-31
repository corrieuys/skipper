import type { Database } from "bun:sqlite";
import { hxRedirect } from "./utils";
import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { isExperimental } from "../config/feature-flags";
import { normalizeSlashCommand } from "../slack/slash-command";
import { findSlashCommandConflict } from "../slack/bindings";
import { isCreatureId, sanitizeColor } from "../html/atoms/creature";
import {
  type SingleAgent,
  type SingleAgentInput,
  type SingleAgentConfig,
  listSingleAgents,
  getSingleAgent,
  createSingleAgent,
  updateSingleAgent,
  deleteSingleAgent,
  singleAgentRefType,
} from "../single-agents/store";
import { teamsReferencingAgentType, reflattenTeamsReferencingAgentType } from "../teams/local-teams";

// ---------------------------------------------------------------------------
// HTTP routes for single agents: CRUD. A single agent is a standalone agent that
// runs one task alone (no delegation, no phases). Experimental only.
// ---------------------------------------------------------------------------

function coerceConfig(raw: unknown): SingleAgentConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const config: SingleAgentConfig = { slackEnabled: c.slackEnabled === true };
  if (typeof c.slashCommand === "string" && c.slashCommand.trim()) {
    config.slashCommand = normalizeSlashCommand(c.slashCommand);
  }
  if (Array.isArray(c.customTools)) {
    const tools = (c.customTools as unknown[]).filter((t): t is string => typeof t === "string");
    if (tools.length > 0) config.customTools = tools;
  }
  if (typeof c.color === "string") config.color = sanitizeColor(c.color);
  if (typeof c.character === "string") config.character = isCreatureId(c.character) ? c.character : null;
  return config;
}

function toInput(body: Record<string, unknown>, opts: { withId?: boolean } = {}): SingleAgentInput {
  const capabilities = Array.isArray(body.capabilities)
    ? (body.capabilities as unknown[]).filter((c): c is string => typeof c === "string")
    : typeof body.capabilities === "string"
      ? (body.capabilities as string).split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const input: SingleAgentInput = {
    name: typeof body.name === "string" ? body.name.trim() : "",
    agent_type: typeof body.agent_type === "string" ? body.agent_type.trim() : "",
    model: typeof body.model === "string" ? body.model.trim() : "default",
    instruction: typeof body.instruction === "string" ? body.instruction : "",
    capabilities,
    config: coerceConfig(body.config),
  };
  if (opts.withId && typeof body.id === "string" && body.id.trim()) input.id = body.id.trim();
  return input;
}

export function registerSingleAgentRoutes(database?: Database): void {
  // Experimental only - do not register any of these routes without the flag, so
  // they 404 rather than exposing a half-built feature.
  if (!isExperimental()) return;
  const db = database ?? getDb();

  // A slash command binds to one target only: reject a save that reuses a
  // command already bound to a team, recurring task, or another single agent.
  const slashConflictResponse = (input: SingleAgentInput, excludeId?: string): Response | null => {
    const cmd = input.config?.slashCommand;
    if (!cmd) return null;
    const conflict = findSlashCommandConflict(db, cmd, { singleAgentId: excludeId });
    if (!conflict) return null;
    const target = conflict.kind === "team" ? "team" : conflict.kind === "agent" ? "headless CLI agent" : "recurring task";
    return Response.json(
      { error: `Slash command ${cmd} is already bound to ${target} "${conflict.label}".` },
      { status: 400 },
    );
  };

  addRoute("GET", "/api/single-agents", () => {
    return Response.json(listSingleAgents(db));
  });

  addRoute("GET", "/api/single-agents/:id", (_req, params) => {
    const agent = getSingleAgent(db, params.id!);
    if (!agent) return Response.json({ error: "Headless CLI agent not found" }, { status: 404 });
    return Response.json(agent);
  });

  addRoute("POST", "/api/single-agents", async (req) => {
    const isHtmx = !!req.headers.get("HX-Request");
    let input: SingleAgentInput;
    try {
      input = toInput((await req.json()) as Record<string, unknown>, { withId: true });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
    const conflict = slashConflictResponse(input);
    if (conflict) return conflict;
    try {
      const agent = createSingleAgent(db, input);
      if (isHtmx) return hxRedirect("/agent-library");
      return Response.json(agent, { status: 201 });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  });

  const updateHandler = async (req: Request, params: Record<string, string>) => {
    const isHtmx = !!req.headers.get("HX-Request");
    const id = params.id!;
    if (!getSingleAgent(db, id)) return Response.json({ error: "Headless CLI agent not found" }, { status: 404 });
    let input: SingleAgentInput;
    try {
      input = toInput((await req.json()) as Record<string, unknown>);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
    const conflict = slashConflictResponse(input, id);
    if (conflict) return conflict;
    try {
      const agent = updateSingleAgent(db, id, input);
      // Live reference: re-project every team that uses this agent as a member,
      // so the edit (provider/model/prompt/tools) takes effect on their next run.
      reflattenTeamsReferencingAgentType(db, singleAgentRefType(id));
      if (isHtmx) return hxRedirect("/agent-library");
      return Response.json(agent);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  };
  addRoute("PUT", "/api/single-agents/:id", updateHandler);
  addRoute("POST", "/api/single-agents/:id/update", updateHandler);

  addRoute("DELETE", "/api/single-agents/:id", (_req, params) => {
    const id = params.id!;
    // Block the delete while a team still references this agent as a member -
    // otherwise the team would carry a dangling reference. Surface the teams.
    const referencing = teamsReferencingAgentType(db, singleAgentRefType(id));
    if (referencing.length > 0) {
      return Response.json(
        { error: `In use by ${referencing.length} team(s): ${referencing.join(", ")}. Remove it from them first.` },
        { status: 409 },
      );
    }
    const ok = deleteSingleAgent(db, id);
    if (!ok) return Response.json({ error: "Headless CLI agent not found" }, { status: 404 });
    return new Response("", { status: 200 });
  });
}

export type { SingleAgent };
