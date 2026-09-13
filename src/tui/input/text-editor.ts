import type { KeyEvent } from "./keyboard";
import { graphemes, cellWidth } from "../render/screen";

/**
 * Minimal editable text buffer shared by single-line fields and multi-line
 * areas. The buffer is a string of grapheme clusters; the caret is an index
 * into that cluster array. Pure state + key handling — rendering is the
 * renderer's job (it asks for `visibleLines()` and `caretPos()`).
 */
export class TextBuffer {
  private chars: string[];
  caret: number;
  readonly multiline: boolean;

  constructor(initial = "", multiline = false) {
    this.chars = graphemes(initial);
    this.caret = this.chars.length;
    this.multiline = multiline;
  }

  get value(): string {
    return this.chars.join("");
  }

  set value(v: string) {
    this.chars = graphemes(v);
    this.caret = Math.min(this.caret, this.chars.length);
  }

  get length(): number {
    return this.chars.length;
  }

  insert(text: string): void {
    const t = this.multiline ? text.replace(/\r\n?/g, "\n") : text.replace(/[\r\n]+/g, " ");
    const g = graphemes(t);
    this.chars.splice(this.caret, 0, ...g);
    this.caret += g.length;
  }

  clear(): void {
    this.chars = [];
    this.caret = 0;
  }

  /** Apply one key. Returns true when the event was consumed. */
  handle(k: KeyEvent): boolean {
    switch (k.type) {
      case "paste":
        this.insert(k.text);
        return true;
      case "char":
        if (k.alt) {
          if (k.ch === "b") return this.wordLeft(), true;
          if (k.ch === "f") return this.wordRight(), true;
          if (k.ch === "d") return this.deleteWordRight(), true;
          return false;
        }
        this.insert(k.ch);
        return true;
      case "ctrl":
        switch (k.ch) {
          case "a":
            this.lineHome();
            return true;
          case "e":
            this.lineEnd();
            return true;
          case "u":
            this.killToLineStart();
            return true;
          case "k":
            this.killToLineEnd();
            return true;
          case "w":
            this.deleteWordLeft();
            return true;
          case "h":
            this.backspace();
            return true;
          case "d":
            this.del();
            return true;
          case "j": // ctrl+j = newline in a multi-line area
            if (this.multiline) {
              this.insert("\n");
              return true;
            }
            return false;
          default:
            return false;
        }
      case "key":
        switch (k.name) {
          case "backspace":
            if (k.alt) this.deleteWordLeft();
            else this.backspace();
            return true;
          case "delete":
            this.del();
            return true;
          case "left":
            if (k.alt || k.ctrl) this.wordLeft();
            else this.caret = Math.max(0, this.caret - 1);
            return true;
          case "right":
            if (k.alt || k.ctrl) this.wordRight();
            else this.caret = Math.min(this.chars.length, this.caret + 1);
            return true;
          case "home":
            this.lineHome();
            return true;
          case "end":
            this.lineEnd();
            return true;
          case "up":
            if (!this.multiline) return false;
            this.moveVertical(-1);
            return true;
          case "down":
            if (!this.multiline) return false;
            this.moveVertical(1);
            return true;
          case "enter":
            if (this.multiline && (k.alt || k.shift)) {
              this.insert("\n");
              return true;
            }
            return false;
          default:
            return false;
        }
      default:
        return false;
    }
  }

  // ── editing primitives ──────────────────────────────────────────────────

  backspace(): void {
    if (this.caret === 0) return;
    this.chars.splice(this.caret - 1, 1);
    this.caret -= 1;
  }

  del(): void {
    if (this.caret >= this.chars.length) return;
    this.chars.splice(this.caret, 1);
  }

  private isWordChar(i: number): boolean {
    const c = this.chars[i];
    return c !== undefined && /[\p{L}\p{N}_]/u.test(c);
  }

  wordLeft(): void {
    let i = this.caret;
    while (i > 0 && !this.isWordChar(i - 1)) i--;
    while (i > 0 && this.isWordChar(i - 1)) i--;
    this.caret = i;
  }

  wordRight(): void {
    let i = this.caret;
    while (i < this.chars.length && !this.isWordChar(i)) i++;
    while (i < this.chars.length && this.isWordChar(i)) i++;
    this.caret = i;
  }

  deleteWordLeft(): void {
    const end = this.caret;
    this.wordLeft();
    this.chars.splice(this.caret, end - this.caret);
  }

  deleteWordRight(): void {
    const start = this.caret;
    this.wordRight();
    this.chars.splice(start, this.caret - start);
    this.caret = start;
  }

  private lineStartIndex(): number {
    let i = this.caret;
    while (i > 0 && this.chars[i - 1] !== "\n") i--;
    return i;
  }

  private lineEndIndex(): number {
    let i = this.caret;
    while (i < this.chars.length && this.chars[i] !== "\n") i++;
    return i;
  }

  lineHome(): void {
    this.caret = this.lineStartIndex();
  }

  lineEnd(): void {
    this.caret = this.lineEndIndex();
  }

  killToLineStart(): void {
    const s = this.lineStartIndex();
    this.chars.splice(s, this.caret - s);
    this.caret = s;
  }

  killToLineEnd(): void {
    const e = this.lineEndIndex();
    this.chars.splice(this.caret, e - this.caret);
  }

  private moveVertical(dir: -1 | 1): void {
    const lineStart = this.lineStartIndex();
    const col = this.caret - lineStart;
    if (dir === -1) {
      if (lineStart === 0) {
        this.caret = 0;
        return;
      }
      const prevEnd = lineStart - 1; // index of the "\n"
      let prevStart = prevEnd;
      while (prevStart > 0 && this.chars[prevStart - 1] !== "\n") prevStart--;
      this.caret = Math.min(prevStart + col, prevEnd);
    } else {
      const lineEnd = this.lineEndIndex();
      if (lineEnd >= this.chars.length) {
        this.caret = this.chars.length;
        return;
      }
      const nextStart = lineEnd + 1;
      let nextEnd = nextStart;
      while (nextEnd < this.chars.length && this.chars[nextEnd] !== "\n") nextEnd++;
      this.caret = Math.min(nextStart + col, nextEnd);
    }
  }

  // ── view helpers ────────────────────────────────────────────────────────

  /** Logical lines (split on newline) as grapheme arrays. */
  lines(): string[][] {
    const out: string[][] = [[]];
    for (const c of this.chars) {
      if (c === "\n") out.push([]);
      else out[out.length - 1]!.push(c);
    }
    return out;
  }

  /** Caret as (line, column-in-graphemes). */
  caretLineCol(): { line: number; col: number } {
    let line = 0;
    let col = 0;
    for (let i = 0; i < this.caret; i++) {
      if (this.chars[i] === "\n") {
        line++;
        col = 0;
      } else col++;
    }
    return { line, col };
  }

  /**
   * Soft-wrapped view of the buffer for a viewport `width` cells wide, with the
   * caret's visual row/col and the first row to show so the caret stays inside
   * `height` rows. Wrapping is by cell (not word) so the caret mapping is exact.
   */
  view(width: number, height: number, scrollRow: number): { rows: string[]; caret: { row: number; col: number }; top: number } {
    const w = Math.max(width, 1);
    const rows: string[] = [];
    let caretRow = 0;
    let caretCol = 0;
    const lines = this.lines();
    const cl = this.caretLineCol();
    for (let li = 0; li < lines.length; li++) {
      const gs = lines[li]!;
      let cur = "";
      let curW = 0;
      let startedRow = rows.length;
      for (let gi = 0; gi <= gs.length; gi++) {
        if (li === cl.line && gi === cl.col) {
          caretRow = rows.length;
          caretCol = curW;
          if (curW >= w) {
            // caret sits at the wrap boundary → next row, col 0
            caretRow = rows.length + 1;
            caretCol = 0;
          }
        }
        if (gi === gs.length) break;
        const g = gs[gi]!;
        const gw = cellWidth(g);
        if (curW + gw > w) {
          rows.push(cur);
          cur = "";
          curW = 0;
          startedRow = rows.length;
        }
        cur += g;
        curW += gw;
      }
      rows.push(cur);
      void startedRow;
    }
    let top = Math.max(0, Math.min(scrollRow, rows.length - 1));
    if (caretRow < top) top = caretRow;
    if (caretRow >= top + height) top = caretRow - height + 1;
    return { rows, caret: { row: caretRow, col: caretCol }, top: Math.max(top, 0) };
  }
}
