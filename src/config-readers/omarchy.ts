import { existsSync, readFileSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reader for the active Omarchy theme (https://omarchy.org). Omarchy stages the
 * selected theme at `~/.local/state/omarchy/current/theme`, whose
 * `colors.toml` is the palette every app is generated from. Nothing here is
 * ever written back; Skipper only follows what the OS picked.
 *
 * `watchOmarchy` fires when the staged theme is swapped (`omarchy-theme-set`),
 * debounced because a theme switch rewrites many files.
 */

export interface OmarchyPalette {
  background: string;
  foreground: string;
  accent: string;
  /**
   * ANSI colours 0..15 as `#rrggbb`. Staged themes are semantic-only
   * (background/foreground/red/...) with no `colorN` keys, so missing entries
   * fall back to the matching semantic name, then to foreground. Mirrors the
   * `ansi_alias` cascade in `omarchy-theme-color`.
   */
  colors: string[];
  mode: "dark" | "light";
}

export interface OmarchyState {
  palette: OmarchyPalette;
  /** Cache-busting token: changes whenever the staged theme changes. */
  version: string;
}

export function omarchyCurrentDir(): string {
  if (process.env.OMARCHY_CURRENT_DIR) return process.env.OMARCHY_CURRENT_DIR;
  const next = join(homedir(), ".local", "state", "omarchy", "current");
  if (existsSync(join(next, "theme", "colors.toml"))) return next;
  // Legacy location from older Omarchy releases; kept as a fallback so a
  // machine that still stages the theme there keeps working.
  const legacy = join(homedir(), ".config", "omarchy", "current");
  if (existsSync(join(legacy, "theme", "colors.toml"))) return legacy;
  return next;
}

function colorsTomlPath(): string {
  return join(omarchyCurrentDir(), "theme", "colors.toml");
}

/** True when this machine runs Omarchy with a selected theme. */
export function isOmarchyAvailable(): boolean {
  return existsSync(colorsTomlPath());
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Parse the flat `key = "value"` lines of colors.toml. The file is one table of
 * strings (no nesting), so a full TOML parser is not needed; unknown keys are
 * kept so callers can read e.g. `mode`.
 */
export function parseColorsToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted = value.match(/^"([^"]*)"|^'([^']*)'/);
    if (quoted) value = quoted[1] ?? quoted[2] ?? "";
    else value = value.split("#")[0]?.trim() ?? "";
    if (key) out[key] = value;
  }
  return out;
}

function normalizeHex(value: string | undefined): string | null {
  if (!value) return null;
  let v = value.trim();
  if (!v.startsWith("#")) v = `#${v}`;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return HEX_RE.test(v) ? v.toLowerCase() : null;
}

export function paletteFromToml(text: string, lightMarker = false): OmarchyPalette {
  const kv = parseColorsToml(text);
  const background = normalizeHex(kv.background) ?? "#000000";
  const foreground = normalizeHex(kv.foreground) ?? "#ffffff";
  const accent = normalizeHex(kv.accent) ?? normalizeHex(kv.blue) ?? normalizeHex(kv.color4) ?? foreground;
  // Staged themes (e.g. Catppuccin) ship semantic names only. Fall back per
  // index the same way `omarchy-theme-color` aliases ANSI <-> semantic.
  const semanticByIndex = [
    kv.background, kv.red, kv.green, kv.yellow, kv.blue, kv.magenta, kv.cyan, kv.foreground,
    kv.muted, kv.bright_red, kv.bright_green, kv.bright_yellow, kv.bright_blue,
    kv.bright_magenta, kv.bright_cyan, kv.bright_foreground,
  ];
  const colors: string[] = [];
  for (let i = 0; i < 16; i++) {
    colors.push(normalizeHex(kv[`color${i}`]) ?? normalizeHex(semanticByIndex[i]) ?? foreground);
  }
  const mode = lightMarker || kv.mode === "light" ? "light" : "dark";
  return { background, foreground, accent, colors, mode };
}

let cached: OmarchyState | null = null;

/** Drop the cache so the next `getOmarchyState` re-reads disk. */
export function invalidateOmarchyState(): void {
  cached = null;
}

/** The active theme palette, or null when Omarchy is not present. */
export function getOmarchyState(): OmarchyState | null {
  if (cached) return cached;
  const tomlPath = colorsTomlPath();
  let text: string;
  try {
    text = readFileSync(tomlPath, "utf8");
  } catch {
    return null;
  }
  const themeDir = join(omarchyCurrentDir(), "theme");
  const lightMarker = existsSync(join(themeDir, "light.mode"));
  const palette = paletteFromToml(text, lightMarker);
  let themeReal = themeDir;
  try { themeReal = realpathSync(themeDir); } catch { /* keep the link path */ }
  const seed = `${themeReal}|${text}`;
  const version = Bun.hash(seed).toString(36);
  cached = { palette, version };
  return cached;
}

/**
 * Watch `~/.local/state/omarchy/current` for the staged theme being replaced.
 * Calls `onChange` (after a short debounce) only when the resolved state
 * actually changed. Returns a stop function; a no-op when Omarchy is absent.
 */
export function watchOmarchy(onChange: (state: OmarchyState) => void, debounceMs = 400): () => void {
  const dir = omarchyCurrentDir();
  if (!existsSync(dir)) return () => {};
  let watcher: FSWatcher;
  try {
    watcher = watch(dir, { persistent: false });
  } catch {
    return () => {};
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastVersion = getOmarchyState()?.version ?? "";
  watcher.on("change", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      invalidateOmarchyState();
      const next = getOmarchyState();
      if (!next || next.version === lastVersion) return;
      lastVersion = next.version;
      onChange(next);
    }, debounceMs);
  });
  watcher.on("error", () => { /* directory vanished; stop quietly */ });
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
