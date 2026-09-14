import type { Database } from "bun:sqlite";
import { addRoute } from "../server";
import { isExperimental } from "../config/feature-flags";
import type { GlyphEngine } from "../glyph/engine";
import { resolveAllowedFile } from "../glyph/sources";
import { artifactViewDocument } from "../glyph/artifact-view";

/**
 * Glyph overlay routes (experimental, 404 without `--experimental`). The
 * overlay itself renders from the `glyph:<taskId>` JSON topic on `/ws/ui`; these
 * routes bootstrap it, reset it, and serve what its `w` (web view) nodes point at.
 *
 *   POST /api/tasks/:id/glyph/open     overlay opened: current frame + a wake if the screen is empty
 *   GET  /api/tasks/:id/glyph          current frame + render state
 *   POST /api/tasks/:id/glyph/reset    drop the screen and the model session, re-render from scratch
 *   POST /api/tasks/:id/glyph/viewport {fit}: how much the overlay zoomed the screen to fit (1 = fits)
 *   GET  /api/artifacts/:id/view       an inline artifact as a page (glyph/artifact-view.ts: markdown via marked, html as-is, themed)
 *   GET  /glyph-local/:task/<abs path> a file inside the task's working directory or artifact store,
 *                                      path-style so relative assets next to an html file resolve too
 */
export function registerGlyphRoutes(engine: GlyphEngine, db: Database): void {
  const gate = (): Response | null => (isExperimental() ? null : new Response("not found", { status: 404 }));

  addRoute("POST", "/api/tasks/:id/glyph/open", (_req, params) => gate() ?? Response.json(engine.open(params.id ?? "")));
  addRoute("GET", "/api/tasks/:id/glyph", (_req, params) => gate() ?? Response.json(engine.status(params.id ?? "")));
  addRoute("POST", "/api/tasks/:id/glyph/reset", (_req, params) => gate() ?? Response.json(engine.reset(params.id ?? "")));
  addRoute("POST", "/api/tasks/:id/glyph/viewport", async (req, params) => {
    const denied = gate();
    if (denied) return denied;
    const body = (await req.json().catch(() => ({}))) as { fit?: unknown };
    const fit = Number(body.fit);
    if (!Number.isFinite(fit)) return new Response("fit must be a number", { status: 400 });
    engine.viewport(params.id ?? "", fit);
    return new Response(null, { status: 204 });
  });

  addRoute("GET", "/api/artifacts/:id/view", (_req, params) => {
    const denied = gate();
    if (denied) return denied;
    const row = db.prepare(
      "SELECT name, body, format, storage FROM task_artifacts WHERE id = ? AND deleted_at IS NULL",
    ).get(params.id ?? "") as { name: string; body: string; format: string | null; storage: string } | null;
    if (!row || row.storage === "file") return new Response("not found", { status: 404 });
    const html = artifactViewDocument(row.name, row.body, row.format);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  });

  // Regex-style pattern: the router turns `:task` into a group and keeps the
  // trailing `.*` verbatim, so the path segment can contain slashes. The file
  // path is taken from the URL directly.
  addRoute("GET", "/glyph-local/:task/.*", (req, params) => {
    const denied = gate();
    if (denied) return denied;
    const taskId = decodeURIComponent(params.task ?? "");
    const prefix = `/glyph-local/${params.task ?? ""}/`;
    const pathname = new URL(req.url).pathname;
    const rawPath = "/" + pathname.slice(prefix.length).split("/").map((s) => decodeURIComponent(s)).join("/");
    const real = resolveAllowedFile(db, taskId, rawPath);
    if (!real) return new Response("not found", { status: 404 });
    const file = Bun.file(real);
    return new Response(file, {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
