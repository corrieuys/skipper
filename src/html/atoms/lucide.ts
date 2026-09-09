import { assetTextSync } from "../../assets";
import { escapeHtml } from "./escape-html";
import { sanitizeColor, DEFAULT_AGENT_COLOR } from "./creature";

/**
 * Server-side Lucide icon rendering. The icon set (2000+ glyphs) is generated
 * into the embedded asset `public/lucide-icons.json` by `scripts/gen-lucide-icons.ts`
 * — the same file the icon picker fetches in the browser. We read it once here to
 * draw a chosen icon inline anywhere (task rows, headers, sidebar), tinted by a
 * color the same way agent creatures are (`--icon-color`, reusing `sanitizeColor`
 * and `AGENT_COLORS` so team/task/recurring icons match the agent palette).
 */
interface LucideData {
  version: string;
  count: number;
  popular: string[];
  icons: Record<string, string>;
  keywords: Record<string, string[]>;
}

let CACHE: LucideData | null = null;

function load(): LucideData {
  if (CACHE) return CACHE;
  try {
    CACHE = JSON.parse(assetTextSync("public/lucide-icons.json")) as LucideData;
  } catch {
    CACHE = { version: "0", count: 0, popular: [], icons: {}, keywords: {} };
  }
  return CACHE;
}

/** True when `id` is a known Lucide icon id (kebab-case name). */
export function isLucideIconId(id: unknown): id is string {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(load().icons, id);
}

/** Coerce arbitrary input to a valid icon id, or null. Kebab-case, known set only. */
export function sanitizeIcon(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const clean = id.trim().toLowerCase();
  return isLucideIconId(clean) ? clean : null;
}

/** The default subset shown before the picker is searched. */
export function popularIconIds(): string[] {
  return load().popular;
}

export interface IconOptions {
  /** Hex color (#rgb/#rrggbb); falls back to the default agent color. */
  color?: string | null;
  /** Pixel size of the square glyph (default 16). */
  size?: number;
  /** Extra class(es) on the <svg>. */
  className?: string;
  /** Accessible title; when absent the icon is aria-hidden. */
  title?: string;
}

/**
 * Inline `<svg>` for one icon, or "" when the id is unknown. Lucide bodies use
 * `stroke="currentColor"`, so tinting is just setting the element color.
 */
export function lucideSvg(id: string | null | undefined, opts: IconOptions = {}): string {
  const iconId = sanitizeIcon(id);
  if (!iconId) return "";
  const inner = load().icons[iconId];
  if (!inner) return "";
  const size = opts.size && opts.size > 0 ? Math.round(opts.size) : 16;
  const color = opts.color ? sanitizeColor(opts.color) : DEFAULT_AGENT_COLOR;
  const cls = `sk-icon${opts.className ? ` ${opts.className}` : ""}`;
  const a11y = opts.title
    ? `role="img" aria-label="${escapeHtml(opts.title)}"`
    : `aria-hidden="true"`;
  return `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:${color};flex-shrink:0;vertical-align:middle" ${a11y}>${inner}</svg>`;
}

/** Convenience for the common {icon, iconColor} pair stored on an entity. */
export function entityIcon(
  icon: string | null | undefined,
  iconColor: string | null | undefined,
  opts: Omit<IconOptions, "color"> = {},
): string {
  return lucideSvg(icon, { ...opts, color: iconColor });
}
