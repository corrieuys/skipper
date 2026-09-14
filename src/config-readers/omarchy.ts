import { existsSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reader for the active Omarchy theme (https://omarchy.org). Omarchy keeps the
 * selected theme behind one symlink, `~/.config/omarchy/current/theme`, whose
 * `colors.toml` is the palette every app is generated from, and the selected
 * wallpaper behind `~/.config/omarchy/current/background`. Nothing here is ever
 * written back; Skipper only follows what the OS picked.
 *
 * `watchOmarchy` fires when either symlink is swapped (`omarchy-theme-set`,
 * `omarchy-theme-bg-next`), debounced because a theme switch rewrites many files.
 */

export interface OmarchyPalette {
  background: string;
  foreground: string;
  accent: string;
  /** ANSI colours 0..15 as `#rrggbb`; missing entries fall back to foreground. */
  colors: string[];
  mode: "dark" | "light";
}

export interface OmarchyState {
  palette: OmarchyPalette;
  /** Absolute path of the active wallpaper image, or null when none is set. */
  background: string | null;
  /** Cache-busting token: changes whenever the theme or wallpaper changes. */
  version: string;
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "avif", "gif"]);

export function omarchyCurrentDir(): string {
  return process.env.OMARCHY_CURRENT_DIR || join(homedir(), ".config", "omarchy", "current");
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
  const accent = normalizeHex(kv.accent) ?? normalizeHex(kv.color4) ?? foreground;
  const colors: string[] = [];
  for (let i = 0; i < 16; i++) colors.push(normalizeHex(kv[`color${i}`]) ?? foreground);
  const mode = lightMarker || kv.mode === "light" ? "light" : "dark";
  return { background, foreground, accent, colors, mode };
}

function resolveBackground(): string | null {
  const link = join(omarchyCurrentDir(), "background");
  try {
    const real = realpathSync(link);
    const ext = real.split(".").pop()?.toLowerCase() ?? "";
    if (!IMAGE_EXTS.has(ext)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

let cached: OmarchyState | null = null;

/** Drop the cache so the next `getOmarchyState` re-reads disk. */
export function invalidateOmarchyState(): void {
  cached = null;
}

/** The active theme + wallpaper, or null when Omarchy is not present. */
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
  const background = resolveBackground();
  let themeReal = themeDir;
  try { themeReal = realpathSync(themeDir); } catch { /* keep the link path */ }
  const seed = `${themeReal}|${text}|${background ?? ""}`;
  const version = Bun.hash(seed).toString(36);
  cached = { palette, background, version };
  return cached;
}

/**
 * Watch `~/.config/omarchy/current` for the theme / background symlinks being
 * replaced. Calls `onChange` (after a short debounce) only when the resolved
 * state actually changed. Returns a stop function; a no-op when Omarchy is absent.
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
