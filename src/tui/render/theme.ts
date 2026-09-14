/**
 * Visual vocabulary for the dashboard: the colour palette, status semantics,
 * and the animation frame sets. Everything that decides "what does X look like"
 * lives here so a view never hardcodes a colour index or glyph.
 *
 * Two palette modes (`setPalette`), both emitted as `38;5;n` indices:
 * - `256`: fixed xterm-256 indices that read on any dark terminal (default).
 * - `ansi`: only the terminal's own ANSI 0..15 slots plus its default fg/bg
 *   (`undefined`), so the dashboard follows whatever theme the terminal is
 *   running (Omarchy re-themes its terminals on every theme switch). Picked
 *   automatically on an Omarchy machine; force with `SKIPPER_TUI_PALETTE`.
 */
import type { Style } from "./screen";
import { isOmarchyAvailable } from "../../config-readers/omarchy";

export type PaletteMode = "256" | "ansi";

export interface Palette {
  /** Page background; `undefined` = the terminal's own. */
  bg: number | undefined;
  bgRaised: number;
  bgPanel: number;
  bgSelected: number;
  bgModal: number;
  border: number;
  borderFocus: number;
  /** Body text; `undefined` = the terminal's own. */
  text: number | undefined;
  textBright: number;
  textMuted: number;
  textDim: number;
  accent: number;
  accentAlt: number;
  accentSoft: number;
  ok: number;
  warn: number;
  danger: number;
  info: number;
  orange: number;
  violet: number;
  pink: number;
  gold: number;
  /** Ink for text printed on an accent-coloured chip. */
  onAccent: number;
  /** Shimmer ramp for the brand mark. */
  brandRamp: number[];
  /** Deterministic per-agent colours. */
  agentRamp: number[];
}

// ── palette (xterm-256 indices) ───────────────────────────────────────────
const PALETTE_256: Palette = {
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
  onAccent: 234,
  brandRamp: [44, 43, 37, 31, 25, 61, 97, 133, 170, 134, 98, 62, 31, 37, 43],
  agentRamp: [44, 170, 117, 215, 141, 212, 178, 42, 75, 203, 111, 156],
};

// ── palette (terminal ANSI 0..15: 0 black · 1 red · 2 green · 3 yellow · 4 blue
//    · 5 magenta · 6 cyan · 7 white · 8..15 bright variants) ─────────────────
const PALETTE_ANSI: Palette = {
  bg: undefined,
  bgRaised: 0,
  bgPanel: 0,
  bgSelected: 8,
  bgModal: 0,
  border: 8,
  borderFocus: 4,
  text: undefined,
  textBright: 15,
  textMuted: 7,
  textDim: 8,
  accent: 4,
  accentAlt: 5,
  accentSoft: 12,
  ok: 2,
  warn: 3,
  danger: 1,
  info: 6,
  orange: 11,
  violet: 13,
  pink: 9,
  gold: 3,
  onAccent: 0,
  brandRamp: [4, 12, 6, 14, 5, 13, 5, 6, 12],
  agentRamp: [4, 5, 6, 3, 13, 9, 11, 2, 12, 1, 14, 10],
};

/** Live palette. Mutated in place by `setPalette` so views read it at draw time. */
export const C: Palette = { ...PALETTE_256 };

function buildStyles(): Record<keyof typeof S, Style> {
  return {
    text: { fg: C.text },
    bright: { fg: C.textBright },
    bold: { fg: C.textBright, bold: true },
    muted: { fg: C.textMuted },
    dim: { fg: C.textDim },
    border: { fg: C.border },
    borderFocus: { fg: C.borderFocus },
    accent: { fg: C.accent },
    accentBold: { fg: C.accent, bold: true },
    alt: { fg: C.accentAlt },
    ok: { fg: C.ok },
    warn: { fg: C.warn },
    danger: { fg: C.danger },
    info: { fg: C.info },
    orange: { fg: C.orange },
    violet: { fg: C.violet },
    gold: { fg: C.gold },
    key: { fg: C.textBright, bg: C.bgSelected },
    keyLabel: { fg: C.textMuted },
  };
}

/** Switch the live palette. Existing `S` / `BRAND_RAMP` references stay valid. */
export function setPalette(mode: PaletteMode): void {
  Object.assign(C, mode === "ansi" ? PALETTE_ANSI : PALETTE_256);
  Object.assign(S, buildStyles());
  BRAND_RAMP.splice(0, BRAND_RAMP.length, ...C.brandRamp);
}

/** `SKIPPER_TUI_PALETTE=ansi|256` wins; otherwise follow the terminal on Omarchy. */
export function resolvePaletteMode(env: NodeJS.ProcessEnv = process.env): PaletteMode {
  const forced = env.SKIPPER_TUI_PALETTE?.trim().toLowerCase();
  if (forced === "ansi" || forced === "256") return forced;
  return isOmarchyAvailable() ? "ansi" : "256";
}

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

/** Shimmer colour ramp used for the brand mark: a teal → magenta sweep (per palette). */
export const BRAND_RAMP: number[] = [...PALETTE_256.brandRamp];

/** Deterministic accent colour for an agent name (stable across frames). */
export function agentColor(name: string): number {
  const ramp = C.agentRamp;
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
