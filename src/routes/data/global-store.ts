import { addDataRoute } from "./auth";
import { GlobalStoreManager } from "../../global-store/manager";
import { parseRequestBody } from "../utils";

function ok(data: unknown, status: number = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

function err(message: string, status: number = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export function registerDataGlobalStoreRoutes(): void {
  const store = new GlobalStoreManager();

  addDataRoute("GET", "/data/global-store", (req) => {
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get("limit");
    return ok(store.query({
      name_prefix: url.searchParams.get("key") ?? undefined,
      type: url.searchParams.get("type") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      limit: limitRaw ? parseInt(limitRaw, 10) : undefined,
    }));
  });

  // Keys may contain slashes (e.g. team/alpha) — callers URL-encode them,
  // and the router matches the encoded segment, so decode before lookup.
  addDataRoute("GET", "/data/global-store/:key", (_req, params) => {
    const row = store.get(decodeURIComponent(params.key));
    if (!row) return err("Key not found", 404);
    return ok(row);
  });

  addDataRoute("POST", "/data/global-store", async (req) => {
    const body = await parseRequestBody<Record<string, string>>(req);
    const name = (body.key ?? body.name)?.trim();
    if (!name) return err("key is required");
    const row = store.set({
      name,
      type: body.type,
      data: body.data,
      status: body.status,
      updatedByAgentId: "api",
    });
    return ok(row);
  });

  addDataRoute("DELETE", "/data/global-store/:key", (_req, params) => {
    const key = decodeURIComponent(params.key);
    if (!store.delete(key)) return err("Key not found", 404);
    return ok({ key, deleted: true });
  });
}
