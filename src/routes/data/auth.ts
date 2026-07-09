import { addRoute } from "../../server";
import { getDb } from "../../db/connection";
import { resolveApiKey } from "../../mcp/auth";

type RouteHandler = Parameters<typeof addRoute>[2];

/**
 * Returns a 401 Response when the request carries no valid API key,
 * or null when authenticated. Keys are the same sk-... keys that gate
 * external MCP access, managed via /api/api-keys (config page).
 */
export function requireApiKey(req: Request): Response | null {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() ?? "";
  if (token && resolveApiKey(getDb(), token)) return null;
  return Response.json(
    { ok: false, error: "Unauthorized: /data/* requires Authorization: Bearer <api-key>" },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="skipper-data"' } },
  );
}

/**
 * addRoute wrapper for the JSON data API — every /data/* route must be
 * registered through this so the Bearer key check is enforced uniformly.
 * (auth.test.ts walks the route table and fails on any unguarded /data/*.)
 */
export function addDataRoute(method: string, path: string, handler: RouteHandler): void {
  addRoute(method, path, (req, params) => {
    const denied = requireApiKey(req);
    if (denied) return denied;
    return handler(req, params);
  });
}
