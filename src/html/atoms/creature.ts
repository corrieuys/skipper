/**
 * Agent identity — creature characters + color palette.
 *
 * The single source of truth for the six "primitive creatures" (a soft rounded
 * body with little legs and two eyes) and the curated agent-color palette. Reused
 * by the agent editors (color/character picker) and the active-agent orb indicator
 * (`dashboardLatestSteerFragment`).
 *
 * Creatures tint through two CSS custom properties — `--agent-color` (body) and
 * `--agent-ink` (legs/outline, a darker shade) — so the same markup can be baked
 * with a fixed color (orb, self-contained via inline style) OR re-tinted live by
 * an ancestor (the editor picker, which just rewrites the vars). CSS drives the
 * idle bob and the busy spin-and-go-crazy (`.zen-orb__creature` in
 * styles/animations.ts). No character set → the orb falls back to the cube.
 */

export const CREATURE_IDS = ["blob", "pod", "slug", "sprout", "mite", "pebble", "captain"] as const;
export type CreatureId = (typeof CREATURE_IDS)[number];

export function isCreatureId(v: unknown): v is CreatureId {
  return typeof v === "string" && (CREATURE_IDS as readonly string[]).includes(v);
}

/** Curated, theme-safe swatches (read on both dark and light). Custom hex allowed. */
export const AGENT_COLORS: string[] = [
  "#6ea8fe", "#7bd88f", "#e0a458", "#c988f0", "#f0768b",
  "#5ccadb", "#f2c14e", "#8b93a7", "#ef8f5a", "#9db85c",
];
export const DEFAULT_AGENT_COLOR = "#6ea8fe";

/** Accept only #rgb / #rrggbb; anything else falls back to the default color. */
export function sanitizeColor(hex: unknown): string {
  if (typeof hex === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex.trim())) {
    return hex.trim().toLowerCase();
  }
  return DEFAULT_AGENT_COLOR;
}

/** A random color + creature for a fresh agent (excludes `captain` — the Skipper's
 *  signature). Used to pre-fill a new agent's identity when experimental. */
export function randomIdentity(): { color: string; character: CreatureId } {
  const chars = CREATURE_IDS.filter((c) => c !== "captain");
  const color = AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)] ?? DEFAULT_AGENT_COLOR;
  const character = chars[Math.floor(Math.random() * chars.length)] ?? "blob";
  return { color, character };
}

/** Lighten (amt>0) or darken (amt<0) a #rgb/#rrggbb color by a flat RGB offset. */
export function shade(hex: string, amt: number): string {
  const clean = sanitizeColor(hex).slice(1);
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const n = parseInt(full, 16);
  const clamp = (v: number): number => Math.max(0, Math.min(255, v));
  const r = clamp((n >> 16) + amt);
  const g = clamp(((n >> 8) & 255) + amt);
  const b = clamp((n & 255) + amt);
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/** The darker leg/outline shade paired with a body color. */
export function inkFor(color: string): string {
  return shade(color, -45);
}

// Two eyes: white sclera + dark pupil, offset slightly for a curious look. Each
// eye is its own `.zen-eye` group (transform-box:fill-box) so CSS can blink it by
// squashing it around its own centre — see styles/animations.ts.
function eye(cx: number, cy: number, r: number): string {
  const w = r * 0.42;
  return `<g class="zen-eye">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff"/>
    <circle cx="${cx + w * 0.2}" cy="${cy + r * 0.15}" r="${w}" fill="#1a2030"/>
  </g>`;
}
function eyes(cx1: number, cx2: number, cy: number, r: number): string {
  return `${eye(cx1, cy, r)}${eye(cx2, cy, r)}`;
}

// Each creature: body blob (fill var(--agent-color)) + legs/outline
// (stroke var(--agent-ink)) + two eyes. Soft primitive shapes only. viewBox 0 0 100 100.
const BODY = "var(--agent-color)";
const INK = "var(--agent-ink)";
const SHAPES: Record<CreatureId, () => string> = {
  blob: () => `
    <g stroke="${INK}" stroke-width="4" stroke-linecap="round">
      <line x1="38" y1="74" x2="38" y2="90"/><line x1="62" y1="74" x2="62" y2="90"/>
    </g>
    <path d="M50 16 C74 16 84 36 84 54 C84 74 70 82 50 82 C30 82 16 74 16 54 C16 36 26 16 50 16Z" fill="${BODY}" stroke="${INK}" stroke-width="3"/>
    ${eyes(40, 60, 48, 9)}`,
  pod: () => `
    <g stroke="${INK}" stroke-width="4" stroke-linecap="round">
      <line x1="34" y1="76" x2="30" y2="92"/><line x1="50" y1="80" x2="50" y2="94"/><line x1="66" y1="76" x2="70" y2="92"/>
    </g>
    <path d="M50 12 C70 12 76 40 76 56 C76 74 64 82 50 82 C36 82 24 74 24 56 C24 40 30 12 50 12Z" fill="${BODY}" stroke="${INK}" stroke-width="3"/>
    ${eyes(41, 59, 46, 8.5)}`,
  slug: () => {
    let legs = "";
    for (let i = 0; i < 5; i++) { const x = 26 + i * 12; legs += `<line x1="${x}" y1="70" x2="${x}" y2="84"/>`; }
    return `
    <g stroke="${INK}" stroke-width="3.5" stroke-linecap="round">${legs}</g>
    <path d="M18 58 C18 38 34 30 50 30 C66 30 82 38 82 58 C82 70 72 74 50 74 C28 74 18 70 18 58Z" fill="${BODY}" stroke="${INK}" stroke-width="3"/>
    ${eyes(42, 60, 48, 8)}`;
  },
  sprout: () => `
    <g stroke="${INK}" stroke-width="4" stroke-linecap="round">
      <line x1="40" y1="78" x2="40" y2="92"/><line x1="60" y1="78" x2="60" y2="92"/>
      <path d="M50 24 C50 14 58 10 62 12" fill="none"/>
    </g>
    <circle cx="50" cy="54" r="30" fill="${BODY}" stroke="${INK}" stroke-width="3"/>
    ${eyes(41, 59, 50, 9)}`,
  mite: () => `
    <g stroke="${INK}" stroke-width="4" stroke-linecap="round">
      <line x1="30" y1="66" x2="20" y2="80"/><line x1="42" y1="72" x2="38" y2="90"/>
      <line x1="58" y1="72" x2="62" y2="90"/><line x1="70" y1="66" x2="80" y2="80"/>
    </g>
    <path d="M50 18 C72 26 82 44 82 54 C82 70 66 78 50 78 C34 78 18 70 18 54 C18 44 28 26 50 18Z" fill="${BODY}" stroke="${INK}" stroke-width="3"/>
    ${eyes(41, 59, 48, 9)}`,
  pebble: () => `
    <g stroke="${INK}" stroke-width="4" stroke-linecap="round">
      <line x1="40" y1="74" x2="40" y2="88"/><line x1="60" y1="74" x2="60" y2="88"/>
    </g>
    <path d="M22 56 C22 40 36 32 52 32 C68 32 80 42 80 56 C80 70 66 74 50 74 C32 74 22 70 22 56Z" fill="${BODY}" stroke="${INK}" stroke-width="3"/>
    ${eyes(42, 60, 50, 8.5)}`,
  // The Skipper's own creature: a plain soft blob (no hat). The Skipper wears this
  // by default.
  captain: () => `
    <g stroke="${INK}" stroke-width="4" stroke-linecap="round">
      <line x1="38" y1="76" x2="38" y2="90"/><line x1="62" y1="76" x2="62" y2="90"/>
    </g>
    <path d="M50 26 C74 26 84 44 84 60 C84 78 70 84 50 84 C30 84 16 78 16 60 C16 44 26 26 50 26Z" fill="${BODY}" stroke="${INK}" stroke-width="3"/>
    ${eyes(40, 60, 54, 8.5)}`,
};

/** Inner SVG shapes for a creature (no wrapping <svg>); tints via CSS vars. */
export function creatureShapes(id: CreatureId): string {
  return SHAPES[id]();
}

/**
 * Full inline SVG for a creature (class `zen-orb__creature`). Pass `color` to bake
 * the tint as inline `--agent-color`/`--agent-ink` (self-contained, e.g. the orb);
 * omit it to inherit the vars from an ancestor (the editor picker re-tints live).
 */
export function creatureSvg(id: CreatureId, color?: string, extraClass = ""): string {
  const cls = extraClass ? `zen-orb__creature ${extraClass}` : "zen-orb__creature";
  const style = color != null
    ? ` style="--agent-color:${sanitizeColor(color)};--agent-ink:${inkFor(color)}"`
    : "";
  return `<svg class="${cls}"${style} viewBox="0 0 100 100" aria-hidden="true" focusable="false">${creatureShapes(id)}</svg>`;
}
