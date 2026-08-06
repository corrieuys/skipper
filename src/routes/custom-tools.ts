import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { isExperimental } from "../config/feature-flags";
import { parseRequestBody } from "./utils";
import { executeCustomTool } from "../custom-tools/runtime";
import {
  createCustomTool,
  deleteCustomTool,
  getCustomTool,
  listCustomTools,
  normalizeToolInput,
  updateCustomTool,
  PARAM_TYPES,
  type CustomToolInput,
  type ToolParameter,
} from "../custom-tools/store";

/**
 * Operator-defined tool CRUD, plus a test runner. Experimental only.
 *
 * The bodies these routes accept are executed by the daemon, so the whole
 * surface is exactly as trusted as the operator: there is no filtering of what
 * the code may do, only the worker boundary and the timeout that
 * `custom-tools/runtime.ts` applies.
 */
export function registerCustomToolRoutes(): void {
  if (!isExperimental()) return;
  const db = getDb();

  const badRequest = (err: unknown) =>
    Response.json({ error: err instanceof Error ? err.message : "Invalid request" }, { status: 400 });

  addRoute("GET", "/api/custom-tools", () => Response.json(listCustomTools(db)));

  addRoute("POST", "/api/custom-tools", async (req) => {
    try {
      return Response.json(createCustomTool(db, coerce(await parseRequestBody(req))));
    } catch (err) {
      return badRequest(err);
    }
  });

  addRoute("POST", "/api/custom-tools/:id/update", async (req, params) => {
    try {
      if (!getCustomTool(db, params.id!)) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(updateCustomTool(db, params.id!, coerce(await parseRequestBody(req))));
    } catch (err) {
      return badRequest(err);
    }
  });

  addRoute("DELETE", "/api/custom-tools/:id", (_req, params) => {
    return deleteCustomTool(db, params.id!)
      ? Response.json({ ok: true })
      : Response.json({ error: "Not found" }, { status: 404 });
  });

  /**
   * Run a body exactly as an agent's call would, from the values in the form
   * rather than the saved row — so a typo surfaces while writing the tool rather
   * than mid-task. Same worker and timeout as the real path.
   */
  addRoute("POST", "/api/custom-tools/test", async (req) => {
    try {
      const body = await parseRequestBody<{ tool?: unknown; args?: unknown }>(req);
      const tool = normalizeToolInput(coerce((body.tool ?? {}) as Record<string, unknown>));
      const args = (body.args && typeof body.args === "object" ? body.args : {}) as Record<string, unknown>;
      const execution = await executeCustomTool(
        { name: tool.name, code: tool.code, timeoutMs: tool.timeoutMs },
        args,
        { taskId: null, agentId: null, instanceId: "config-test", workingDir: process.cwd() },
      );
      return Response.json(execution);
    } catch (err) {
      return badRequest(err);
    }
  });
}

function coerce(body: Record<string, unknown>): CustomToolInput {
  const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
  const parameters: ToolParameter[] = Array.isArray(body.parameters)
    ? (body.parameters as Array<Record<string, unknown>>).map((p) => ({
      name: str(p?.name),
      type: (PARAM_TYPES as string[]).includes(str(p?.type)) ? (str(p?.type) as ToolParameter["type"]) : "string",
      description: str(p?.description),
      required: p?.required !== false,
    }))
    : [];

  return {
    ...(typeof body.id === "string" && body.id ? { id: body.id } : {}),
    name: str(body.name),
    description: str(body.description),
    parameters,
    code: str(body.code),
    timeoutMs: Number(body.timeoutMs ?? 10_000),
  };
}
