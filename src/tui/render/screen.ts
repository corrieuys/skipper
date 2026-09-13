/**
 * Cell-buffer screen. Views draw styled text into a width×height grid; the
 * painter then diffs against the previously painted grid and emits only the
 * runs that changed. No per-frame clear, no flicker, and overlays (modals,
 * toasts, dimmed backdrops) are trivial: draw later, on top.
 *
 * Wide characters (CJK, many emoji) occupy two cells; the second cell is a
 * zero-width continuation marker so clipping never splits a glyph.
 */

export interface Style {
  fg?: number;
  bg?: number;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

interface Cell {
  ch: string; // "" = continuation of a wide char to the left
  w: number; // 1 or 2 (0 for a continuation)
  st: Style;
}

const EMPTY: Style = {};
const ESC = "\x1b[";

export function cellWidth(ch: string): number {
  if (ch === "") return 0;
  const w = Bun.stringWidth(ch);
  return w <= 0 ? 1 : Math.min(w, 2);
}

export function textWidth(s: string): number {
  return Bun.stringWidth(s);
}

/** Split into user-perceived characters (grapheme clusters) when available. */
const segmenter: Intl.Segmenter | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

export function graphemes(s: string): string[] {
  if (!segmenter) return Array.from(s);
  const out: string[] = [];
  for (const seg of segmenter.segment(s)) out.push(seg.segment);
  return out;
}

/** Truncate to `max` cells, appending an ellipsis when cut. */
export function clip(s: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return "";
  if (textWidth(s) <= max) return s;
  const ew = textWidth(ellipsis);
  if (max <= ew) return ellipsis.slice(0, max);
  const budget = max - ew;
  let out = "";
  let acc = 0;
  for (const g of graphemes(s)) {
    const w = cellWidth(g);
    if (acc + w > budget) break;
    out += g;
    acc += w;
  }
  return out + ellipsis;
}

/** Pad (or clip) to exactly `w` cells. */
export function padEnd(s: string, w: number): string {
  const c = clip(s, w);
  const gap = w - textWidth(c);
  return gap > 0 ? c + " ".repeat(gap) : c;
}

export function padStart(s: string, w: number): string {
  const c = clip(s, w);
  const gap = w - textWidth(c);
  return gap > 0 ? " ".repeat(gap) + c : c;
}

/** Word-wrap to `width` cells. Hard-breaks words longer than the width. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (para.trim() === "") {
      lines.push("");
      continue;
    }
    let cur = "";
    let curW = 0;
    for (const word of para.split(/(\s+)/)) {
      if (word === "") continue;
      const ww = textWidth(word);
      if (/^\s+$/.test(word)) {
        if (curW === 0) continue; // drop leading whitespace on a fresh line
        if (curW + ww > width) {
          lines.push(cur);
          cur = "";
          curW = 0;
        } else {
          cur += word;
          curW += ww;
        }
        continue;
      }
      if (curW + ww <= width) {
        cur += word;
        curW += ww;
        continue;
      }
      if (curW > 0) {
        lines.push(cur.trimEnd());
        cur = "";
        curW = 0;
      }
      if (ww <= width) {
        cur = word;
        curW = ww;
        continue;
      }
      // Hard break an over-long word.
      let chunk = "";
      let cw = 0;
      for (const g of graphemes(word)) {
        const gw = cellWidth(g);
        if (cw + gw > width) {
          lines.push(chunk);
          chunk = "";
          cw = 0;
        }
        chunk += g;
        cw += gw;
      }
      cur = chunk;
      curW = cw;
    }
    lines.push(cur.trimEnd());
  }
  return lines;
}

export class Screen {
  readonly cols: number;
  readonly rows: number;
  private cells: Cell[];

  constructor(cols: number, rows: number, fill: Style = EMPTY) {
    this.cols = Math.max(cols, 1);
    this.rows = Math.max(rows, 1);
    this.cells = new Array(this.cols * this.rows);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = { ch: " ", w: 1, st: fill };
  }

  private idx(x: number, y: number): number {
    return y * this.cols + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }

  /** Set one cell, repairing any wide char it overlaps. */
  put(x: number, y: number, ch: string, st: Style = EMPTY): void {
    if (!this.inBounds(x, y)) return;
    const i = this.idx(x, y);
    const w = cellWidth(ch);
    // Overlapping the tail of a wide char → blank its head.
    const cur = this.cells[i]!;
    if (cur.w === 0 && x > 0) {
      const head = this.cells[i - 1]!;
      if (head.w === 2) this.cells[i - 1] = { ch: " ", w: 1, st: head.st };
    }
    // Overwriting the head of a wide char → blank its tail.
    if (cur.w === 2 && x + 1 < this.cols) this.cells[i + 1] = { ch: " ", w: 1, st: cur.st };
    if (w === 2) {
      if (x + 1 >= this.cols) {
        this.cells[i] = { ch: " ", w: 1, st };
        return;
      }
      this.cells[i] = { ch, w: 2, st };
      const tail = this.cells[i + 1]!;
      if (tail.w === 2 && x + 2 < this.cols) this.cells[i + 2] = { ch: " ", w: 1, st: tail.st };
      this.cells[i + 1] = { ch: "", w: 0, st };
      return;
    }
    this.cells[i] = { ch: w === 0 ? " " : ch, w: 1, st };
  }

  /** Draw text starting at (x, y), clipped to `maxW` cells (default: to the edge). */
  text(x: number, y: number, s: string, st: Style = EMPTY, maxW?: number): number {
    if (y < 0 || y >= this.rows) return 0;
    const limit = Math.min(maxW ?? this.cols - x, this.cols - x);
    if (limit <= 0) return 0;
    let cx = x;
    let used = 0;
    for (const g of graphemes(s)) {
      const w = cellWidth(g);
      if (used + w > limit) break;
      if (cx >= 0) this.put(cx, y, g, st);
      cx += w;
      used += w;
    }
    return used;
  }

  /** Text clipped with an ellipsis to `maxW`, then padded to fill it. */
  textClip(x: number, y: number, s: string, maxW: number, st: Style = EMPTY): void {
    this.text(x, y, padEnd(s, maxW), st, maxW);
  }

  fill(x: number, y: number, w: number, h: number, ch = " ", st: Style = EMPTY): void {
    for (let yy = y; yy < y + h; yy++) {
      if (yy < 0 || yy >= this.rows) continue;
      for (let xx = x; xx < x + w; xx++) {
        if (xx < 0 || xx >= this.cols) continue;
        this.put(xx, yy, ch, st);
      }
    }
  }

  hline(x: number, y: number, w: number, ch = "─", st: Style = EMPTY): void {
    for (let i = 0; i < w; i++) this.put(x + i, y, ch, st);
  }

  vline(x: number, y: number, h: number, ch = "│", st: Style = EMPTY): void {
    for (let i = 0; i < h; i++) this.put(x, y + i, ch, st);
  }

  /** Rounded box border. Interior untouched. */
  box(x: number, y: number, w: number, h: number, st: Style = EMPTY, rounded = true): void {
    if (w < 2 || h < 2) return;
    const [tl, tr, bl, br] = rounded ? ["╭", "╮", "╰", "╯"] : ["┌", "┐", "└", "┘"];
    this.put(x, y, tl, st);
    this.put(x + w - 1, y, tr, st);
    this.put(x, y + h - 1, bl, st);
    this.put(x + w - 1, y + h - 1, br, st);
    this.hline(x + 1, y, w - 2, "─", st);
    this.hline(x + 1, y + h - 1, w - 2, "─", st);
    this.vline(x, y + 1, h - 2, "│", st);
    this.vline(x + w - 1, y + 1, h - 2, "│", st);
  }

  /** Restyle a region (used to dim a backdrop behind a modal). */
  restyle(x: number, y: number, w: number, h: number, patch: (st: Style) => Style): void {
    for (let yy = Math.max(y, 0); yy < Math.min(y + h, this.rows); yy++) {
      for (let xx = Math.max(x, 0); xx < Math.min(x + w, this.cols); xx++) {
        const i = this.idx(xx, yy);
        const c = this.cells[i]!;
        this.cells[i] = { ch: c.ch, w: c.w, st: patch(c.st) };
      }
    }
  }

  /** Plain text of one row (tests / debugging). */
  rowText(y: number): string {
    let s = "";
    for (let x = 0; x < this.cols; x++) s += this.cells[this.idx(x, y)]!.ch;
    return s;
  }

  /** Whole screen as plain text lines (tests). */
  toLines(): string[] {
    const out: string[] = [];
    for (let y = 0; y < this.rows; y++) out.push(this.rowText(y).replace(/\s+$/, ""));
    return out;
  }

  cellAt(x: number, y: number): { ch: string; st: Style } | null {
    if (!this.inBounds(x, y)) return null;
    const c = this.cells[this.idx(x, y)]!;
    return { ch: c.ch, st: c.st };
  }

  /**
   * Emit ANSI for the cells that differ from `prev` (or everything when prev
   * is null / a different size). Cursor is parked at the bottom-right.
   */
  diff(prev: Screen | null): string {
    const full = !prev || prev.cols !== this.cols || prev.rows !== this.rows;
    let out = "";
    let curStyle: Style | null = null;
    for (let y = 0; y < this.rows; y++) {
      let x = 0;
      while (x < this.cols) {
        const i = this.idx(x, y);
        const c = this.cells[i]!;
        if (!full) {
          const p = prev!.cells[i]!;
          if (p.ch === c.ch && sameStyle(p.st, c.st)) {
            x += 1;
            continue;
          }
        }
        // Start a run at x; extend while cells differ (or full repaint).
        out += `${ESC}${y + 1};${x + 1}H`;
        let run = "";
        while (x < this.cols) {
          const j = this.idx(x, y);
          const cc = this.cells[j]!;
          if (!full) {
            const pp = prev!.cells[j]!;
            if (pp.ch === cc.ch && sameStyle(pp.st, cc.st)) break;
          }
          if (!curStyle || !sameStyle(curStyle, cc.st)) {
            run += sgr(cc.st);
            curStyle = cc.st;
          }
          run += cc.ch;
          x += 1;
        }
        out += run;
      }
    }
    if (out) out += `${ESC}0m`;
    return out;
  }
}

export function sameStyle(a: Style, b: Style): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.inverse === !!b.inverse
  );
}

/** Full SGR reset + attributes for a style (always starts from reset). */
export function sgr(st: Style): string {
  let s = `${ESC}0`;
  if (st.bold) s += ";1";
  if (st.dim) s += ";2";
  if (st.italic) s += ";3";
  if (st.underline) s += ";4";
  if (st.inverse) s += ";7";
  if (st.fg !== undefined) s += `;38;5;${st.fg}`;
  if (st.bg !== undefined) s += `;48;5;${st.bg}`;
  return s + "m";
}

export function merge(a: Style, b: Style): Style {
  return { ...a, ...b };
}
