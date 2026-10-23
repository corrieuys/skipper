/**
 * Agent identity — the curated agent-color palette, reused by the agent editors
 * (color picker) and the active-agent orb indicator
 * (`dashboardLatestSteerFragment`).
 *
 * `CREATURE_IDS` / `isCreatureId` only validate the stored `character` field,
 * which no web surface renders or edits any more.
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

/** A random color for a fresh agent. Used to pre-fill a new agent's identity when
 *  experimental. */
export function randomIdentity(): { color: string } {
  const color = AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)] ?? DEFAULT_AGENT_COLOR;
  return { color };
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

/** The darker shade paired with an agent color. */
export function inkFor(color: string): string {
  return shade(color, -45);
}
