import { getOmarchyState, type OmarchyPalette } from "../../config-readers/omarchy";
import { glassCss, type GlassPalette } from "./themes";
import { isExperimental } from "../../config/feature-flags";

/**
 * The `omarchy` theme: CSS derived from the active Omarchy palette
 * (`config-readers/omarchy.ts`) instead of a static var map. It is served as its
 * own stylesheet (`GET /omarchy/theme.css`) and linked from the page head, so a
 * theme switch on the OS only has to swap that link (see `ws-subscribe.js`).
 *
 * Layout mirrors the Artemis theme: translucent surfaces over the Omarchy
 * wallpaper, the same frosted-glass overrides, accents from the palette. v1 is
 * dark-only: a light Omarchy theme still renders dark surfaces.
 */

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** Linear mix of `a` toward `b` by `t` (0 = a, 1 = b). */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function rgba(c: Rgb, alpha: number): string {
  return `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${alpha})`;
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/** Build the `[data-theme="omarchy"]` var overrides from a palette. */
export function omarchyThemeVars(p: OmarchyPalette): Record<string, string> {
  const bg = hexToRgb(p.background);
  const fg = hexToRgb(p.foreground);
  const accent = hexToRgb(p.accent);
  const cyan = hexToRgb(p.colors[6] ?? p.accent);
  const brightCyan = hexToRgb(p.colors[14] ?? p.colors[6] ?? p.accent);
  const green = hexToRgb(p.colors[2] ?? p.foreground);
  const yellow = hexToRgb(p.colors[3] ?? p.foreground);
  const red = hexToRgb(p.colors[1] ?? p.foreground);

  const deep = mix(bg, BLACK, 0.15);
  const low = mix(bg, WHITE, 0.03);
  const mid = mix(bg, WHITE, 0.06);
  const high = mix(bg, WHITE, 0.1);
  const bright = mix(bg, WHITE, 0.16);
  const muted = mix(fg, bg, 0.35);
  const line = mix(fg, bg, 0.2);

  const surface0 = rgba(deep, 0.6);
  const surface1 = rgba(low, 0.55);
  const surface2 = rgba(mid, 0.5);
  const surface3 = rgba(high, 0.55);
  const surface4 = rgba(bright, 0.5);
  const border = rgba(line, 0.15);
  const borderSubtle = rgba(line, 0.25);
  const glowPrimary = `0 0 0.6rem ${rgba(accent, 0.3)}, 0 0 1.2rem ${rgba(accent, 0.15)}`;
  const glowSecondary = `0 0 0.6rem ${rgba(cyan, 0.2)}, 0 0 1.2rem ${rgba(cyan, 0.1)}`;

  return {
    "--sk-surface-0": surface0,
    "--sk-surface-1": surface1,
    "--sk-surface-2": surface2,
    "--sk-surface-3": surface3,
    "--sk-surface-4": surface4,
    "--sk-panel-bg": surface1,
    "--sk-panel-elevated-bg": surface3,
    "--sk-text": p.foreground,
    "--sk-text-muted": rgbToHex(muted),
    "--sk-text-subtle": rgba(muted, 0.6),
    "--sk-accent-primary": p.accent,
    "--sk-accent-primary-container": rgbToHex(mix(accent, BLACK, 0.15)),
    "--sk-accent-primary-dim": rgba(accent, 0.25),
    "--sk-accent-secondary": rgbToHex(cyan),
    "--sk-accent-secondary-container": rgbToHex(mix(cyan, bg, 0.8)),
    "--sk-accent-secondary-dim": rgba(cyan, 0.2),
    "--sk-accent-tertiary": rgbToHex(green),
    "--sk-accent-tertiary-dim": rgba(green, 0.2),
    "--sk-accent-warning": rgbToHex(yellow),
    "--sk-accent-danger": rgbToHex(red),
    "--sk-panel-radius": "0.75rem",
    "--sk-radius-xs": "4px",
    "--sk-radius-sm": "6px",
    "--sk-radius-md": "10px",
    "--sk-radius-lg": "14px",
    "--sk-btn-radius": "5px",
    "--sk-border": border,
    "--sk-border-subtle": borderSubtle,
    "--sk-border-active": rgba(accent, 0.3),
    "--sk-glow-primary": glowPrimary,
    "--sk-glow-secondary": glowSecondary,
    "--on-primary": rgbToHex(mix(accent, BLACK, 0.8)),
    "--on-secondary-container": rgbToHex(brightCyan),
    "--void": surface0,
    "--surface-low": surface1,
    "--surface-mid": surface2,
    "--surface-high": surface3,
    "--surface-bright": surface4,
    "--panel": surface1,
    "--panel-alt": surface0,
    "--text": p.foreground,
    "--muted": rgbToHex(muted),
    "--border": border,
    "--accent-cyan": rgbToHex(cyan),
    "--accent-magenta": p.accent,
    "--accent-yellow": rgbToHex(yellow),
    "--danger": rgbToHex(red),
    "--glow": glowPrimary,
    "--glow-cyan": glowSecondary,
  };
}

function omarchyGlassPalette(p: OmarchyPalette): GlassPalette {
  const bg = hexToRgb(p.background);
  const fg = hexToRgb(p.foreground);
  return {
    deep: mix(bg, BLACK, 0.15),
    low: mix(bg, WHITE, 0.03),
    mid: mix(bg, WHITE, 0.06),
    line: mix(fg, bg, 0.2),
    accent: hexToRgb(p.accent),
    solid: rgbToHex(mix(bg, WHITE, 0.04)),
    solidBar: rgbToHex(mix(bg, WHITE, 0.09)),
    solidMenu: rgbToHex(mix(bg, WHITE, 0.09)),
  };
}

/** Wallpaper (or flat palette background when none is set) behind the page. */
function omarchyBackgroundCss(p: OmarchyPalette, hasImage: boolean, version: string): string {
  const image = hasImage ? `background-image: url('/omarchy/background?v=${version}');` : "";
  return `
    [data-theme="omarchy"] body::before {
      content: '';
      position: fixed;
      inset: 0;
      z-index: -1;
      background-color: ${p.background};
      ${image}
      background-position: center;
      background-size: cover;
      background-repeat: no-repeat;
      background-attachment: fixed;
    }
  `;
}

/** The complete `omarchy` stylesheet for the current OS state, or "" when absent. */
export function omarchyThemeCss(): string {
  const state = getOmarchyState();
  if (!state) return "";
  const decls = Object.entries(omarchyThemeVars(state.palette)).map(([k, v]) => `${k}: ${v};`).join(" ");
  return [
    `[data-theme="omarchy"] { ${decls} }`,
    omarchyBackgroundCss(state.palette, state.background !== null, state.version),
    glassCss('[data-theme="omarchy"]', omarchyGlassPalette(state.palette)),
  ].join("\n");
}

/** Public URL of the current omarchy stylesheet, versioned for cache-busting. */
export function omarchyThemeHref(version: string): string {
  return `/omarchy/theme.css?v=${version}`;
}

/** `<link>` for the page head; empty unless experimental and Omarchy is present. */
export function omarchyThemeLinkHtml(): string {
  if (!isExperimental()) return "";
  const state = getOmarchyState();
  if (!state) return "";
  return `<link id="sk-omarchy-theme" rel="stylesheet" href="${omarchyThemeHref(state.version)}">`;
}
