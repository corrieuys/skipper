/**
 * Low-level terminal driver: alternate screen, raw mode, bracketed paste,
 * resize, cursor placement and the raw write. The ONLY file in the renderer
 * that touches process.stdout/stdin, so a different backend would replace it
 * wholesale. Zero dependencies.
 */

export const ESC = "\x1b[";

export class TerminalDriver {
  private readonly out: NodeJS.WriteStream;
  private readonly inp: NodeJS.ReadStream;
  private resizeCb: (() => void) | null = null;
  private keyCb: ((data: string) => void) | null = null;
  private mounted = false;
  private readonly onResizeBound = () => this.resizeCb?.();
  private readonly onDataBound = (buf: Buffer) => this.keyCb?.(buf.toString("utf8"));

  constructor(out: NodeJS.WriteStream = process.stdout, inp: NodeJS.ReadStream = process.stdin) {
    this.out = out;
    this.inp = inp;
  }

  size(): { cols: number; rows: number } {
    return { cols: this.out.columns ?? 80, rows: this.out.rows ?? 24 };
  }

  isTTY(): boolean {
    return !!this.out.isTTY;
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.write(
      `${ESC}?1049h` + // alternate screen
        `${ESC}?25l` + // hide cursor
        `${ESC}?2004h` + // bracketed paste
        `${ESC}2J${ESC}H`,
    );
    if (this.inp.isTTY) this.inp.setRawMode(true);
    this.inp.resume();
    this.inp.on("data", this.onDataBound);
    this.out.on("resize", this.onResizeBound);
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.out.off("resize", this.onResizeBound);
    this.inp.off("data", this.onDataBound);
    if (this.inp.isTTY) {
      try {
        this.inp.setRawMode(false);
      } catch {
        /* stream already closed */
      }
    }
    try {
      this.inp.pause();
    } catch {
      /* ignore */
    }
    this.write(`${ESC}?2004l${ESC}0m${ESC}?25h${ESC}?1049l`);
  }

  onResize(cb: () => void): void {
    this.resizeCb = cb;
  }

  onKey(cb: (data: string) => void): void {
    this.keyCb = cb;
  }

  /** Write a pre-composed ANSI diff, then park/show the cursor as asked. */
  paint(frame: string, cursor: { x: number; y: number } | null): void {
    let s = frame;
    if (cursor) s += `${ESC}${cursor.y + 1};${cursor.x + 1}H${ESC}?25h`;
    else s += `${ESC}?25l`;
    if (s) this.write(s);
  }

  private write(s: string): void {
    this.out.write(s);
  }
}
