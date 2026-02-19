import { baseStyles } from "../baseStyles";
import { skStyles, themesCss, themeOverridesCss, glassOverridesCss } from "./index";

/**
 * The full static stylesheet, built once at process start and served as a single
 * cacheable file (see STYLESHEET_PATH). Everything that doesn't change at runtime
 * lives here; only the per-config wallpaper `:root` vars stay inline in the page.
 *
 * Previously this ~230 KB of CSS was inlined into every page response and
 * re-downloaded + re-parsed on every (full-page) navigation. Serving it once,
 * cached, removes that cost entirely.
 */
const STYLESHEET = [
  baseStyles(),
  skStyles(),
  themesCss(),
  themeOverridesCss(),
  glassOverridesCss(),
].join("\n");

// Content hash → an immutable, cache-forever URL. The hash only changes when the
// CSS changes (a new build), so the browser never serves stale styles and never
// needs to revalidate.
const STYLESHEET_HASH = Bun.hash(STYLESHEET).toString(36);

export const STYLESHEET_PATH = `/assets/skipper-${STYLESHEET_HASH}.css`;

export function getStylesheet(): string {
  return STYLESHEET;
}
