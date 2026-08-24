import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { isExperimental } from "../config/feature-flags";
import { parseRequestBody } from "./utils";
import { probeEndpoint } from "../custom-agents/model";
import {
  createCustomAgent,
  deleteCustomAgent,
  getCustomAgent,
  listCustomAgents,
  updateCustomAgent,
  customAgentTypeName,
  type CustomAgentInput,
} from "../custom-agents/store";
import { teamsReferencingAgentType } from "../teams/local-teams";
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listImportableServers,
  listMcpServers,
  updateMcpServer,
  type McpServerInput,
  type McpServerRecord,
} from "../custom-agents/servers";
import { refreshServerCatalogue } from "../custom-agents/server-tools";
import { mcpServersPanel } from "../html/pages/custom-agents.page";

/**
 * Custom agent CRUD. Experimental only — every route 404s without the flag, so
 * the feature is absent rather than merely hidden.
 *
 * Responses never echo `apiKey` or header values back. The editor renders stored
 * secrets as empty fields with a "leave blank to keep" hint and `updateCustomAgent`
 * treats blank as "unchanged", which is the same contract as the Slack bot token.
 */
export function registerCustomAgentRoutes(): void {
  if (!isExperimental()) return;
  const db = getDb();

  const notFound = () => Response.json({ error: "Not found" }, { status: 404 });
  const badRequest = (err: unknown) =>
    Response.json({ error: err instanceof Error ? err.message : "Invalid request" }, { status: 400 });

  addRoute("GET", "/api/custom-agents", () => {
    return Response.json(listCustomAgents(db).map(redact));
  });

  addRoute("GET", "/api/custom-agents/:id", (_req, params) => {
    const agent = getCustomAgent(db, params.id!);
    return agent ? Response.json(redact(agent)) : notFound();
  });

  addRoute("POST", "/api/custom-agents", async (req) => {
    try {
      const body = await parseRequestBody<Record<string, unknown>>(req);
      const agent = createCustomAgent(db, coerceInput(body));
      return Response.json(redact(agent));
    } catch (err) {
      return badRequest(err);
    }
  });

  addRoute("POST", "/api/custom-agents/:id/update", async (req, params) => {
    try {
      if (!getCustomAgent(db, params.id!)) return notFound();
      const body = await parseRequestBody<Record<string, unknown>>(req);
      return Response.json(redact(updateCustomAgent(db, params.id!, coerceInput(body))));
    } catch (err) {
      return badRequest(err);
    }
  });

  addRoute("DELETE", "/api/custom-agents/:id", (_req, params) => {
    const id = params.id!;
    // Block the delete while a team references this agent as a member, so the
    // team never carries a dangling reference. Surface the teams.
    const referencing = teamsReferencingAgentType(db, customAgentTypeName(id));
    if (referencing.length > 0) {
      return Response.json(
        { error: `In use by ${referencing.length} team(s): ${referencing.join(", ")}. Remove it from them first.` },
        { status: 409 },
      );
    }
    return deleteCustomAgent(db, id) ? Response.json({ ok: true }) : notFound();
  });

  // ── MCP server registry ─────────────────────────────────────────────
  // Lives on the Custom Agents page, so every mutation returns the re-rendered panel
  // for an htmx swap, the way the API-keys panel does.

  const panel = () =>
    new Response(mcpServersPanel(listMcpServers(db), listImportableServers(db)), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });

  addRoute("GET", "/api/custom-agent-servers", (req) => {
    if (req.headers.get("hx-request") === "true") return panel();
    return Response.json(listMcpServers(db).map(redactServer));
  });

  addRoute("POST", "/api/custom-agent-servers", async (req) => {
    try {
      const body = await parseRequestBody<Record<string, unknown>>(req);
      const server = createMcpServer(db, coerceServerInput(body));
      // Discover on save: the operator finds out now whether the server answers,
      // rather than when an agent reaches for one of its tools mid-task.
      await refreshServerCatalogue(db, server);
      return req.headers.get("hx-request") === "true" ? panel() : Response.json(redactServer(getMcpServer(db, server.id)!));
    } catch (err) {
      return badRequest(err);
    }
  });

  addRoute("POST", "/api/custom-agent-servers/:id/update", async (req, params) => {
    try {
      if (!getMcpServer(db, params.id!)) return notFound();
      const body = await parseRequestBody<Record<string, unknown>>(req);
      const server = updateMcpServer(db, params.id!, coerceServerInput(body));
      await refreshServerCatalogue(db, server);
      return req.headers.get("hx-request") === "true" ? panel() : Response.json(redactServer(getMcpServer(db, server.id)!));
    } catch (err) {
      return badRequest(err);
    }
  });

  addRoute("POST", "/api/custom-agent-servers/:id/refresh", async (req, params) => {
    const server = getMcpServer(db, params.id!);
    if (!server) return notFound();
    const result = await refreshServerCatalogue(db, server);
    return req.headers.get("hx-request") === "true" ? panel() : Response.json(result);
  });

  addRoute("DELETE", "/api/custom-agent-servers/:id", (req, params) => {
    if (!deleteMcpServer(db, params.id!)) return notFound();
    return req.headers.get("hx-request") === "true" ? panel() : Response.json({ ok: true });
  });

  /**
   * Connectivity check + model discovery for the editor's Test button.
   *
   * Takes the form's current values rather than the stored row so an operator can
   * verify a base URL before saving it — the whole point is to catch a typo or a
   * missing key here instead of halfway through a task. When the agent already
   * exists, a blank key/header falls back to what is stored, matching the save
   * contract.
   */
  addRoute("POST", "/api/custom-agents/probe", async (req) => {
    try {
      const body = await parseRequestBody<Record<string, unknown>>(req);
      const existing = typeof body.id === "string" && body.id ? getCustomAgent(db, body.id) : null;
      const input = coerceInput(body);
      const result = await probeEndpoint({
        id: existing?.id ?? "probe",
        name: input.name || "probe",
        description: "",
        baseUrl: input.baseUrl,
        modelId: input.modelId || "probe",
        apiKey: input.apiKey || existing?.apiKey || "",
        headers: mergeSecrets(input.headers, existing?.headers),
        queryParams: input.queryParams,
        systemPrompt: "",
        enabledTools: [],
        enabledMcpTools: [],
        enabledServerTools: [],
        enabledCustomTools: [],
        enabledSkills: [],
        maxSteps: 1,
        temperature: null,
        createdAt: "",
        updatedAt: "",
      });
      return Response.json(result);
    } catch (err) {
      return badRequest(err);
    }
  });
}

/** Never send a stored env value or header back to the browser. */
function redactServer(server: McpServerRecord) {
  const mask = (o: Record<string, string>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v ? "__stored__" : ""]));
  return { ...server, env: mask(server.env), headers: mask(server.headers) };
}

function coerceServerInput(body: Record<string, unknown>): McpServerInput {
  const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
  const pairs = (v: unknown): Record<string, string> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = val === "__stored__" ? "" : String(val ?? "");
    }
    return out;
  };
  // Args accept either an array (JSON body) or a whitespace-separated string,
  // because the panel's single-line field is how a command is actually pasted.
  const args = Array.isArray(body.args)
    ? body.args.map((a) => String(a))
    : str(body.args).split(/\s+/).filter(Boolean);

  return {
    ...(typeof body.id === "string" && body.id ? { id: body.id } : {}),
    slug: str(body.slug),
    name: str(body.name),
    transport: body.transport === "stdio" ? "stdio" : "http",
    command: str(body.command),
    args,
    env: pairs(body.env),
    url: str(body.url),
    headers: pairs(body.headers),
  };
}

/** Blank header values fall back to the stored ones — the form masks secrets. */
function mergeSecrets(
  submitted: Record<string, string>,
  stored: Record<string, string> | undefined,
): Record<string, string> {
  const out = { ...submitted };
  for (const [key, value] of Object.entries(out)) {
    if (value === "") out[key] = stored?.[key] ?? "";
  }
  return out;
}

/** Never send a stored secret back to the browser. */
function redact(agent: { apiKey: string; headers: Record<string, string> }) {
  return {
    ...agent,
    apiKey: agent.apiKey ? "__stored__" : "",
    headers: Object.fromEntries(
      Object.entries(agent.headers).map(([k, v]) => [k, v ? "__stored__" : ""]),
    ),
  };
}

/**
 * Accept both the JSON body the editor posts and a plain form body. Validation
 * proper lives in `normalizeCustomAgentInput`; this only gets the shapes right.
 */
function coerceInput(body: Record<string, unknown>): CustomAgentInput {
  const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const pairs = (v: unknown): Record<string, string> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      // "__stored__" is what `redact` sent to the browser; round-tripping it
      // would save the literal placeholder as the secret.
      out[k] = val === "__stored__" ? "" : String(val ?? "");
    }
    return out;
  };

  const rawKey = str(body.apiKey);
  return {
    ...(typeof body.id === "string" && body.id ? { id: body.id } : {}),
    name: str(body.name),
    description: str(body.description),
    baseUrl: str(body.baseUrl),
    modelId: str(body.modelId),
    apiKey: rawKey === "__stored__" ? "" : rawKey,
    headers: pairs(body.headers),
    queryParams: pairs(body.queryParams),
    systemPrompt: str(body.systemPrompt),
    enabledTools: strings(body.enabledTools),
    enabledMcpTools: strings(body.enabledMcpTools),
    enabledServerTools: strings(body.enabledServerTools),
    enabledCustomTools: strings(body.enabledCustomTools),
    enabledSkills: strings(body.enabledSkills),
    maxSteps: Number(body.maxSteps ?? 40),
    temperature:
      body.temperature === null || body.temperature === undefined || body.temperature === ""
        ? null
        : Number(body.temperature),
  };
}
