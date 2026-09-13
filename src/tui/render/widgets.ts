import { Screen, type Style, textWidth, clip } from "./screen";
import type { Rect } from "./layout";
import { C, S, SPIN_CUBE, WAVE, CURSOR_BREATHE, phaseSegmentStyle, statusColor, statusLabel, statusGlyph } from "./theme";

/** Reusable drawing helpers every view shares. Pure functions over a Screen. */

/** Bordered panel with a title in the top edge and optional right-side text. */
export function panel(
  s: Screen,
  r: Rect,
  title: string,
  opts: { focused?: boolean; right?: string; bg?: number; titleStyle?: Style } = {},
): Rect {
  if (r.w < 3 || r.h < 2) return { x: r.x + 1, y: r.y + 1, w: Math.max(r.w - 2, 0), h: Math.max(r.h - 2, 0) };
  const edge: Style = opts.focused ? S.borderFocus : S.border;
  if (opts.bg !== undefined) s.fill(r.x, r.y, r.w, r.h, " ", { bg: opts.bg });
  s.box(r.x, r.y, r.w, r.h, edge);
  const t = ` ${title} `;
  const tw = Math.min(textWidth(t), r.w - 2);
  s.text(r.x + 1, r.y, clip(t, tw), opts.titleStyle ?? (opts.focused ? S.bold : S.muted), tw);
  if (opts.right) {
    const rt = ` ${opts.right} `;
    const rw = Math.min(textWidth(rt), Math.max(r.w - 2 - tw - 1, 0));
    if (rw > 0) s.text(r.x + r.w - 1 - rw, r.y, clip(rt, rw), S.muted, rw);
  }
  return { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 };
}

/** Inline chip: `[ LABEL ]`-style pill with a coloured background. */
export function pill(s: Screen, x: number, y: number, label: string, fg: number, bg?: number, maxW?: number): number {
  const txt = ` ${label} `;
  const w = Math.min(textWidth(txt), maxW ?? txt.length);
  s.text(x, y, clip(txt, w), { fg: bg === undefined ? fg : C.bg, bg: bg ?? fg, bold: true }, w);
  return w;
}

/** Status pill using the theme's status colour. */
export function statusPill(s: Screen, x: number, y: number, status: string, frame: number): number {
  const label = `${statusGlyph(status, frame)} ${statusLabel(status)}`;
  return pill(s, x, y, label, statusColor(status), statusColor(status));
}

/** Segmented phase progress: done ▰ current ▰ (pulsing) todo ▱. Returns width used. */
export function phaseStrip(s: Screen, x: number, y: number, current: number, total: number, frame: number, maxW: number): number {
  if (total <= 0 || maxW <= 0) return 0;
  const segW = Math.max(1, Math.min(3, Math.floor((maxW - 6) / total)));
  let cx = x;
  for (let i = 0; i < total; i++) {
    const st = phaseSegmentStyle(i, current, frame);
    const ch = i <= current ? "▰" : "▱";
    for (let k = 0; k < segW; k++) {
      if (cx - x >= maxW) return cx - x;
      s.put(cx, y, ch, st);
      cx++;
    }
  }
  const label = ` ${Math.min(current + 1, total)}/${total}`;
  cx += s.text(cx, y, label, S.muted, Math.max(maxW - (cx - x), 0));
  return cx - x;
}

/** Sparkline from bucket counts using the block ramp. */
export function sparkline(s: Screen, x: number, y: number, buckets: number[], st: Style): number {
  const max = Math.max(1, ...buckets);
  const ramp = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  for (let i = 0; i < buckets.length; i++) {
    const v = buckets[i]!;
    const ch = v === 0 ? "▁" : ramp[Math.min(ramp.length - 1, Math.round((v / max) * (ramp.length - 1)))]!;
    s.put(x + i, y, ch, v === 0 ? S.dim : st);
  }
  return buckets.length;
}

/** Agent orb: rotating cube when active, hollow when idle. */
export function orb(active: boolean, frame: number, seed: number): string {
  return active ? SPIN_CUBE[(frame + seed) % SPIN_CUBE.length]! : "◦";
}

/** Animated "alive" wave used under headers while connected. */
export function waveChar(frame: number, i: number): string {
  return WAVE[(frame + i) % WAVE.length]!;
}

export function breathingCursor(frame: number): string {
  return CURSOR_BREATHE[frame % CURSOR_BREATHE.length]!;
}

/** Left text + right text on one row, right-aligned, clipping left first. */
export function lr(s: Screen, x: number, y: number, w: number, left: string, leftSt: Style, right: string, rightSt: Style): void {
  const rw = Math.min(textWidth(right), w);
  const lw = Math.max(w - rw - (rw > 0 ? 1 : 0), 0);
  s.text(x, y, clip(left, lw), leftSt, lw);
  if (rw > 0) s.text(x + w - rw, y, clip(right, rw), rightSt, rw);
}

/** Key hint sequence: `k label   k label …` fitting in w. Returns width used. */
export function keyHints(s: Screen, x: number, y: number, w: number, hints: Array<[string, string]>, keySt: Style = S.key, labelSt: Style = S.keyLabel): number {
  let cx = x;
  for (const [k, label] of hints) {
    const need = textWidth(k) + 1 + textWidth(label) + 2;
    if (cx - x + need > w) break;
    cx += s.text(cx, y, k, keySt);
    cx += s.text(cx, y, " " + label, labelSt);
    cx += 2;
  }
  return cx - x;
}

/** Vertical scrollbar thumb along the right edge of a body rect. */
export function scrollbar(s: Screen, r: Rect, total: number, top: number, visible: number): void {
  if (r.h < 3 || total <= visible) return;
  const trackH = r.h;
  const thumbH = Math.max(1, Math.round((visible / total) * trackH));
  const maxTop = Math.max(total - visible, 1);
  const thumbY = Math.round((Math.min(top, maxTop) / maxTop) * (trackH - thumbH));
  for (let i = 0; i < trackH; i++) {
    const inThumb = i >= thumbY && i < thumbY + thumbH;
    s.put(r.x + r.w - 1, r.y + i, inThumb ? "┃" : "│", inThumb ? S.accent : S.dim);
  }
}

/** Dim everything on screen (backdrop behind a modal). */
export function dimAll(s: Screen): void {
  s.restyle(0, 0, s.cols, s.rows, (st) => ({ ...st, fg: C.textDim, bold: false, bg: st.bg === undefined ? undefined : C.bg }));
}

/** Draw a drop shadow one cell right/below a rect. */
export function shadow(s: Screen, r: Rect): void {
  s.restyle(r.x + 1, r.y + r.h, r.w, 1, (st) => ({ ...st, fg: 232, bg: 232 }));
  s.restyle(r.x + r.w, r.y + 1, 1, r.h, (st) => ({ ...st, fg: 232, bg: 232 }));
}
