/**
 * Raw stdin bytes → key events. Raw mode delivers control characters and CSI
 * escape sequences directly, and one chunk may hold several keys (fast typing,
 * an unbracketed paste). Bracketed paste (`ESC[200~ … ESC[201~`) becomes one
 * `paste` event so multi-line JSON lands in a field intact.
 */

export type KeyName =
  | "enter"
  | "escape"
  | "tab"
  | "backtab"
  | "backspace"
  | "delete"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "insert"
  | "f1"
  | "f2"
  | "f3"
  | "f4"
  | "f5"
  | "f6"
  | "f7"
  | "f8"
  | "f9"
  | "f10"
  | "f11"
  | "f12";

export type KeyEvent =
  | { type: "char"; ch: string; alt?: boolean }
  | { type: "ctrl"; ch: string } // ctrl+<letter>, ch lower-case
  | { type: "key"; name: KeyName; shift?: boolean; alt?: boolean; ctrl?: boolean }
  | { type: "paste"; text: string }
  | { type: "unknown"; raw: string };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Stateful decoder: a paste may span chunks, so keep a buffer between calls. */
export class KeyDecoder {
  private pasteBuf: string | null = null;

  feed(data: string): KeyEvent[] {
    const out: KeyEvent[] = [];
    let s = data;
    if (this.pasteBuf !== null) {
      const end = s.indexOf(PASTE_END);
      if (end === -1) {
        this.pasteBuf += s;
        return out;
      }
      out.push({ type: "paste", text: this.pasteBuf + s.slice(0, end) });
      this.pasteBuf = null;
      s = s.slice(end + PASTE_END.length);
    }
    let i = 0;
    while (i < s.length) {
      if (s.startsWith(PASTE_START, i)) {
        const rest = s.slice(i + PASTE_START.length);
        const end = rest.indexOf(PASTE_END);
        if (end === -1) {
          this.pasteBuf = rest;
          return out;
        }
        out.push({ type: "paste", text: rest.slice(0, end) });
        i += PASTE_START.length + end + PASTE_END.length;
        continue;
      }
      const [ev, len] = decodeOne(s, i);
      out.push(ev);
      i += len;
    }
    return out;
  }
}

/** Decode one key at position i. Returns the event and the consumed length. */
export function decodeOne(s: string, i: number): [KeyEvent, number] {
  const c = s[i]!;
  if (c === "\x1b") {
    // Escape sequences.
    const rest = s.slice(i);
    const csi = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest);
    if (csi) {
      const params = csi[1] ?? "";
      const final = csi[2]!;
      const len = csi[0].length;
      const mod = modifierFrom(params);
      const name = csiName(params, final);
      if (name) return [{ type: "key", name, ...mod }, len];
      return [{ type: "unknown", raw: csi[0] }, len];
    }
    const ss3 = /^\x1bO([A-Za-z])/.exec(rest);
    if (ss3) {
      const name = ss3Name(ss3[1]!);
      if (name) return [{ type: "key", name }, ss3[0].length];
      return [{ type: "unknown", raw: ss3[0] }, ss3[0].length];
    }
    // ESC + printable = alt+char (meta). ESC alone = escape.
    if (rest.length >= 2) {
      const n = rest[1]!;
      if (n === "\x7f" || n === "\b") return [{ type: "key", name: "backspace", alt: true }, 2];
      if (n === "\r" || n === "\n") return [{ type: "key", name: "enter", alt: true }, 2];
      if (n >= " " && n !== "\x1b") return [{ type: "char", ch: n, alt: true }, 2];
    }
    return [{ type: "key", name: "escape" }, 1];
  }
  if (c === "\r" || c === "\n") return [{ type: "key", name: "enter" }, 1];
  if (c === "\t") return [{ type: "key", name: "tab" }, 1];
  if (c === "\x7f" || c === "\b") return [{ type: "key", name: "backspace" }, 1];
  const code = c.charCodeAt(0);
  if (code < 32) {
    // Ctrl+letter: 1..26 → a..z. Others map to their ^-char.
    if (code >= 1 && code <= 26) return [{ type: "ctrl", ch: String.fromCharCode(96 + code) }, 1];
    return [{ type: "ctrl", ch: String.fromCharCode(64 + code).toLowerCase() }, 1];
  }
  // Printable: take a full code point (surrogate pairs).
  const cp = s.codePointAt(i)!;
  const ch = String.fromCodePoint(cp);
  return [{ type: "char", ch }, ch.length];
}

function modifierFrom(params: string): { shift?: boolean; alt?: boolean; ctrl?: boolean } {
  const parts = params.split(";");
  const m = parts.length >= 2 ? Number(parts[1]) : NaN;
  if (!Number.isFinite(m) || m <= 1) return {};
  const bits = m - 1;
  const out: { shift?: boolean; alt?: boolean; ctrl?: boolean } = {};
  if (bits & 1) out.shift = true;
  if (bits & 2) out.alt = true;
  if (bits & 4) out.ctrl = true;
  return out;
}

function csiName(params: string, final: string): KeyName | null {
  const first = params.split(";")[0] ?? "";
  switch (final) {
    case "A":
      return "up";
    case "B":
      return "down";
    case "C":
      return "right";
    case "D":
      return "left";
    case "H":
      return "home";
    case "F":
      return "end";
    case "Z":
      return "backtab";
    case "P":
      return "f1";
    case "Q":
      return "f2";
    case "R":
      return "f3";
    case "S":
      return "f4";
    case "~":
      switch (first) {
        case "1":
        case "7":
          return "home";
        case "2":
          return "insert";
        case "3":
          return "delete";
        case "4":
        case "8":
          return "end";
        case "5":
          return "pageup";
        case "6":
          return "pagedown";
        case "11":
          return "f1";
        case "12":
          return "f2";
        case "13":
          return "f3";
        case "14":
          return "f4";
        case "15":
          return "f5";
        case "17":
          return "f6";
        case "18":
          return "f7";
        case "19":
          return "f8";
        case "20":
          return "f9";
        case "21":
          return "f10";
        case "23":
          return "f11";
        case "24":
          return "f12";
        default:
          return null;
      }
    default:
      return null;
  }
}

function ss3Name(c: string): KeyName | null {
  switch (c) {
    case "A":
      return "up";
    case "B":
      return "down";
    case "C":
      return "right";
    case "D":
      return "left";
    case "H":
      return "home";
    case "F":
      return "end";
    case "P":
      return "f1";
    case "Q":
      return "f2";
    case "R":
      return "f3";
    case "S":
      return "f4";
    default:
      return null;
  }
}

/** Human label for a key event (help screens, debugging). */
export function describeKey(k: KeyEvent): string {
  switch (k.type) {
    case "char":
      return (k.alt ? "alt+" : "") + k.ch;
    case "ctrl":
      return `ctrl+${k.ch}`;
    case "key":
      return (k.ctrl ? "ctrl+" : "") + (k.alt ? "alt+" : "") + (k.shift ? "shift+" : "") + k.name;
    case "paste":
      return "paste";
    case "unknown":
      return "?";
  }
}
