/**
 * Visual vocabulary for the dashboard: a 256-colour palette that reads on dark
 * terminals, status semantics, and the animation frame sets. Everything that
 * decides "what does X look like" lives here so a view never hardcodes a
 * colour index or glyph.
 */
import type { Style } from "./screen";

// ── palette (xterm-256 indices) ───────────────────────────────────────────
export const C = {
  bg: 234,
  bgRaised: 235,
  bgPanel: 236,
  bgSelected: 238,
  bgModal: 235,
  border: 240,
  borderFocus: 44,
  text: 252,
  textBright: 255,
  textMuted: 245,
  textDim: 240,
  accent: 44, // teal
  accentAlt: 170, // magenta
  accentSoft: 117, // sky
  ok: 42,
  warn: 220,
  danger: 203,
  info: 75,
  orange: 215,
  violet: 141,
  pink: 212,
  gold: 178,
} as const;

// ── text styles ───────────────────────────────────────────────────────────
export const S = {
  text: { fg: C.text } as Style,
  bright: { fg: C.textBright } as Style,
  bold: { fg: C.textBright, bold: true } as Style,
  muted: { fg: C.textMuted } as Style,
  dim: { fg: C.textDim } as Style,
  border: { fg: C.border } as Style,
  borderFocus: { fg: C.borderFocus } as Style,
  accent: { fg: C.accent } as Style,
  accentBold: { fg: C.accent, bold: true } as Style,
  alt: { fg: C.accentAlt } as Style,
  ok: { fg: C.ok } as Style,
  warn: { fg: C.warn } as Style,
  danger: { fg: C.danger } as Style,
  info: { fg: C.info } as Style,
  orange: { fg: C.orange } as Style,
  violet: { fg: C.violet } as Style,
  gold: { fg: C.gold } as Style,
  key: { fg: C.textBright, bg: C.bgSelected } as Style,
  keyLabel: { fg: C.textMuted } as Style,
};

// ── status semantics ──────────────────────────────────────────────────────
export type DisplayStatus =
  | "draft"
  | "queued"
  | "working"
  | "idle"
  | "paused"
  | "review"
  | "blocked"
  | "completed"
  | "failed";

export const STATUS_ORDER: DisplayStatus[] = [
  "blocked",
  "review",
  "working",
  "queued",
  "idle",
  "paused",
  "draft",
  "completed",
  "failed",
];

export function statusColor(status: string): number {
  switch (status) {
    case "working":
      return C.ok;
    case "queued":
      return C.warn;
    case "idle":
      return C.accent;
    case "paused":
      return C.orange;
    case "review":
      return C.violet;
    case "blocked":
      return C.danger;
    case "completed":
      return C.info;
    case "failed":
      return C.danger;
    case "draft":
      return C.textMuted;
    default:
      return C.textMuted;
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case "working":
      return "WORKING";
    case "queued":
      return "QUEUED";
    case "idle":
      return "IDLE";
    case "paused":
      return "PAUSED";
    case "review":
      return "REVIEW";
    case "blocked":
      return "BLOCKED";
    case "completed":
      return "DONE";
    case "failed":
      return "FAILED";
    case "draft":
      return "DRAFT";
    default:
      return status.toUpperCase();
  }
}

// ── animation frame sets ──────────────────────────────────────────────────
export const SPIN_BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPIN_CUBE = ["◰", "◳", "◲", "◱"];
export const PULSE = ["●", "◉", "◎", "○", "◎", "◉"];
export const WAVE = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"];
export const BLINK_SLOW = 6; // frames per half-cycle
export const CURSOR_BREATHE = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█", "▉", "▊", "▋", "▌", "▍", "▎"];

/** Status glyph for a task row, animated where the state is "alive". */
export function statusGlyph(status: string, frame: number, seed = 0): string {
  switch (status) {
    case "working":
      return SPIN_BRAILLE[(frame + seed) % SPIN_BRAILLE.length]!;
    case "queued":
      return PULSE[(frame + seed) % PULSE.length]!;
    case "blocked":
      return Math.floor(frame / 3) % 2 === 0 ? "▲" : "△";
    case "review":
      return Math.floor(frame / 4) % 2 === 0 ? "◆" : "◇";
    case "paused":
      return "▮▮";
    case "idle":
      return "◦";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "draft":
      return "·";
    default:
      return "·";
  }
}

/** Shimmer colour ramp used for the brand mark: a teal → magenta sweep. */
export const BRAND_RAMP = [44, 43, 37, 31, 25, 61, 97, 133, 170, 134, 98, 62, 31, 37, 43];

/** Deterministic accent colour for an agent name (stable across frames). */
export function agentColor(name: string): number {
  const ramp = [44, 170, 117, 215, 141, 212, 178, 42, 75, 203, 111, 156];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return ramp[h % ramp.length]!;
}

/** Gradient across a phase strip: done segments cool, current hot, todo dim. */
export function phaseSegmentStyle(i: number, current: number, frame: number): Style {
  if (i < current) return { fg: C.ok };
  if (i === current) return { fg: frame % 8 < 4 ? C.accent : C.accentSoft, bold: true };
  return { fg: C.textDim };
}
