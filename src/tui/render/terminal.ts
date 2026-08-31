/**
 * Low-level terminal driver: alternate screen buffer, raw mode, cursor moves,
 * resize, and cell-accurate text clipping. Zero dependencies — colors are plain
 * ANSI and width uses Bun.stringWidth (wide-char / emoji aware). This is the
 * only file in the renderer that touches process.stdout/stdin directly, so a
 * different backend (ink/blessed) would replace it wholesale.
 */

export const ESC = "\x1b[";

export const ansi = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  fg: (n: number) => `${ESC}38;5;${n}m`,
  // 256-color palette picks that read on both light and dark terminals.
  cyan: `${ESC}38;5;44m`,
  green: `${ESC}38;5;42m`,
  yellow: `${ESC}38;5;220m`,
  red: `${ESC}38;5;203m`,
  gray: `${ESC}38;5;245m`,
  border: `${ESC}38;5;240m`,
  white: `${ESC}38;5;255m`,
  magenta: `${ESC}38;5;170m`,
  blue: `${ESC}38;5;75m`,
  orange: `${ESC}38;5;215m`,
};

/** Visible width of a string in terminal cells. */
export function width(s: string): number {
  return Bun.stringWidth(s);
}

/**
 * Truncate `s` to at most `max` cells, appending "…" when cut. Handles
 * wide chars by measuring incrementally. Never returns wider than `max`.
 */
export function clip(s: string, max: number): string {
  if (max <= 0) return "";
  if (width(s) <= max) return s;
  if (max === 1) return "…";
  const budget = max - 1; // room for the ellipsis
  let out = "";
  let acc = 0;
  for (const ch of s) {
    const cw = width(ch);
    if (acc + cw > budget) break;
    out += ch;
    acc += cw;
  }
  return out + "…";
}

/** Pad `s` with spaces to exactly `w` cells (clipping if longer). */
export function padTo(s: string, w: number): string {
  const clipped = clip(s, w);
  const gap = w - width(clipped);
  return gap > 0 ? clipped + " ".repeat(gap) : clipped;
}

export class TerminalDriver {
  private readonly out: NodeJS.WriteStream;
  private readonly inp: NodeJS.ReadStream;
  private resizeCb: (() => void) | null = null;
  private mounted = false;
  private readonly onResizeBound = () => this.resizeCb?.();

  constructor(
    out: NodeJS.WriteStream = process.stdout,
    inp: NodeJS.ReadStream = process.stdin,
  ) {
    this.out = out;
    this.inp = inp;
  }

  size(): { cols: number; rows: number } {
    return {
      cols: this.out.columns ?? 80,
      rows: this.out.rows ?? 24,
    };
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.write(
      `${ESC}?1049h` + // enter alternate screen
        `${ESC}?25l` + // hide cursor
        `${ESC}2J`, // clear
    );
    if (this.inp.isTTY) this.inp.setRawMode(true);
    this.inp.resume();
    this.out.on("resize", this.onResizeBound);
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.out.off("resize", this.onResizeBound);
    if (this.inp.isTTY) {
      try {
        this.inp.setRawMode(false);
      } catch {
        /* stream already closed */
      }
    }
    this.write(
      `${ESC}?25h` + // show cursor
        `${ESC}?1049l`, // leave alternate screen
    );
  }

  onResize(cb: () => void): void {
    this.resizeCb = cb;
  }

  onKey(cb: (data: string) => void): void {
    this.inp.on("data", (buf: Buffer) => cb(buf.toString("utf8")));
  }

  /** Write a full pre-composed frame. Cursor is homed first. */
  paint(frame: string): void {
    this.write(`${ESC}H${frame}`);
  }

  private write(s: string): void {
    this.out.write(s);
  }
}

/** Position the cursor at 1-based (x, y). */
export function moveTo(x: number, y: number): string {
  return `${ESC}${y};${x}H`;
}
