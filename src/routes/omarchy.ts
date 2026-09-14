import { addRoute } from "../server";
import { isExperimental } from "../config/feature-flags";
import { eventBus } from "../events/bus";
import { getOmarchyState, invalidateOmarchyState, watchOmarchy } from "../config-readers/omarchy";
import { omarchyThemeCss } from "../html/styles/omarchy-theme";

/**
 * Omarchy OS-theme follower (experimental, 404 without `--experimental` or when
 * `~/.config/omarchy/current/theme/colors.toml` is absent).
 *
 *   GET  /omarchy/theme.css?v=   the `omarchy` theme stylesheet built from the active palette
 *   GET  /omarchy/background?v=  the active Omarchy wallpaper image
 *   POST /api/omarchy/reload     re-read the OS state now (for an omarchy `theme-set` hook);
 *                                emits `appearance:omarchy_changed` when it differs
 *
 * `?v=` is the state version; a matching value is served immutable, anything
 * else (stale link) is served no-cache so the swapped-in sheet is never cached.
 */
export function registerOmarchyRoutes(): void {
  const gate = (): Response | null =>
    isExperimental() && getOmarchyState() ? null : new Response("not found", { status: 404 });

  const cacheHeader = (req: Request, version: string): string => {
    const v = new URL(req.url).searchParams.get("v");
    return v === version ? "public, max-age=31536000, immutable" : "no-cache";
  };

  addRoute("GET", "/omarchy/theme.css", (req) => {
    const refused = gate();
    if (refused) return refused;
    const state = getOmarchyState()!;
    return new Response(omarchyThemeCss(), {
      headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": cacheHeader(req, state.version) },
    });
  });

  addRoute("GET", "/omarchy/background", (req) => {
    const refused = gate();
    if (refused) return refused;
    const state = getOmarchyState()!;
    if (!state.background) return new Response("not found", { status: 404 });
    const file = Bun.file(state.background);
    return new Response(file, {
      headers: { "Content-Type": file.type || "application/octet-stream", "Cache-Control": cacheHeader(req, state.version) },
    });
  });

  addRoute("POST", "/api/omarchy/reload", () => {
    const refused = gate();
    if (refused) return refused;
    const before = getOmarchyState()!.version;
    invalidateOmarchyState();
    const state = getOmarchyState();
    if (!state) return new Response("not found", { status: 404 });
    const changed = state.version !== before;
    if (changed) eventBus.emit("appearance:omarchy_changed", { version: state.version });
    return Response.json({ version: state.version, changed });
  });
}

/**
 * Follow the OS: watch the Omarchy `current` dir and fan a theme / wallpaper
 * switch out on the bus so every open page re-skins itself. Returns a stop fn.
 */
export function startOmarchyFollower(): () => void {
  if (!isExperimental()) return () => {};
  return watchOmarchy((state) => eventBus.emit("appearance:omarchy_changed", { version: state.version }));
}
