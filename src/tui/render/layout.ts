import type { PaneId } from "./types";

/** A rectangle in terminal cells. x,y are 1-based (ANSI cursor coords). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  header: Rect;
  panes: Record<PaneId, Rect>;
  footer: Rect;
  mode: "rail" | "stacked";
}

const MIN_H = 3;
const RAIL_MIN_COLS = 100;
const RAIL_MIN_ROWS = 18;

const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/**
 * Pure layout: terminal size → rectangles. No I/O.
 *
 *   rail    (cols >= 100, rows >= 18): a left rail (tasks over agents) beside a
 *           big OUTPUT feed, with a full-width MILESTONES strip along the bottom.
 *   stacked (everything smaller):      OUTPUT (big) → agents → tasks → milestones.
 *
 * OUTPUT dominates in both — the live agent feed is the point of the view.
 */
export function computeLayout(cols: number, rows: number): Layout {
  const w = Math.max(cols, 1);
  const h = Math.max(rows, 1);
  const header: Rect = { x: 1, y: 1, w, h: 1 };
  const footer: Rect = { x: 1, y: h, w, h: 1 };
  const bodyY = 2;
  const bodyH = Math.max(h - 2, MIN_H);

  if (w >= RAIL_MIN_COLS && h >= RAIL_MIN_ROWS) {
    // Left rail (tasks over agents) beside a full-height OUTPUT feed.
    const railW = clampN(Math.round(w * 0.3), 28, 42);
    const mainW = w - railW;
    const tasksH = clampN(Math.round(bodyH * 0.42), 3, bodyH - 3);
    const agentsH = Math.max(bodyH - tasksH, MIN_H);
    return {
      mode: "rail",
      header,
      footer,
      panes: {
        tasks: { x: 1, y: bodyY, w: railW, h: tasksH },
        agents: { x: 1, y: bodyY + tasksH, w: railW, h: agentsH },
        output: { x: railW + 1, y: bodyY, w: mainW, h: bodyH },
      },
    };
  }

  // Stacked: output (big) → agents → tasks.
  const agentsH = clampN(Math.round(bodyH * 0.22), MIN_H, bodyH);
  const tasksH = clampN(Math.round(bodyH * 0.2), MIN_H, bodyH);
  const outputH = Math.max(bodyH - agentsH - tasksH, MIN_H);
  return {
    mode: "stacked",
    header,
    footer,
    panes: {
      output: { x: 1, y: bodyY, w, h: outputH },
      agents: { x: 1, y: bodyY + outputH, w, h: agentsH },
      tasks: { x: 1, y: bodyY + outputH + agentsH, w, h: tasksH },
    },
  };
}
