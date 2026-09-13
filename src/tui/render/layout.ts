/** A rectangle in screen cells. x,y are 0-based. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LayoutMode = "triple" | "double" | "single";

export interface Layout {
  mode: LayoutMode;
  header: Rect; // 2 rows: brand/metrics + filter tabs
  footer: Rect; // 1 row: keys + toast
  rail: Rect | null; // task list
  main: Rect; // task detail (or whichever single view is active)
  feed: Rect | null; // global live feed column
}

const HEADER_H = 2;
const FOOTER_H = 1;
const TRIPLE_MIN_COLS = 150;
const DOUBLE_MIN_COLS = 96;
const MIN_BODY_H = 6;

const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/**
 * Pure layout: terminal size → rectangles. No I/O.
 *
 *   triple (cols >= 150): rail | detail | live feed
 *   double (cols >= 96):  rail | detail          (feed is a detail tab)
 *   single (smaller):     one full-width view, Tab cycles rail/detail/feed
 */
export function computeLayout(cols: number, rows: number): Layout {
  const w = Math.max(cols, 1);
  const h = Math.max(rows, 1);
  const header: Rect = { x: 0, y: 0, w, h: Math.min(HEADER_H, h) };
  const footer: Rect = { x: 0, y: h - 1, w, h: FOOTER_H };
  const bodyY = header.h;
  const bodyH = Math.max(h - header.h - FOOTER_H, Math.min(MIN_BODY_H, h));

  if (w >= TRIPLE_MIN_COLS) {
    const railW = clampN(Math.round(w * 0.26), 34, 48);
    const feedW = clampN(Math.round(w * 0.3), 40, 64);
    const mainW = w - railW - feedW;
    return {
      mode: "triple",
      header,
      footer,
      rail: { x: 0, y: bodyY, w: railW, h: bodyH },
      main: { x: railW, y: bodyY, w: mainW, h: bodyH },
      feed: { x: railW + mainW, y: bodyY, w: feedW, h: bodyH },
    };
  }
  if (w >= DOUBLE_MIN_COLS) {
    const railW = clampN(Math.round(w * 0.34), 32, 46);
    return {
      mode: "double",
      header,
      footer,
      rail: { x: 0, y: bodyY, w: railW, h: bodyH },
      main: { x: railW, y: bodyY, w: w - railW, h: bodyH },
      feed: null,
    };
  }
  return {
    mode: "single",
    header,
    footer,
    rail: null,
    main: { x: 0, y: bodyY, w, h: bodyH },
    feed: null,
  };
}

/** Centered modal rect of the requested size, clamped inside the screen. */
export function centered(cols: number, rows: number, wantW: number, wantH: number): Rect {
  const w = Math.max(Math.min(wantW, cols - 2), Math.min(20, cols));
  const h = Math.max(Math.min(wantH, rows - 2), Math.min(5, rows));
  return { x: Math.max(Math.floor((cols - w) / 2), 0), y: Math.max(Math.floor((rows - h) / 2), 0), w, h };
}

export function inset(r: Rect, dx: number, dy: number = dx): Rect {
  return { x: r.x + dx, y: r.y + dy, w: Math.max(r.w - dx * 2, 0), h: Math.max(r.h - dy * 2, 0) };
}
