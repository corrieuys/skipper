import { describe, it, expect } from "bun:test";
import { KeyDecoder, decodeOne } from "./keyboard";

describe("KeyDecoder", () => {
  it("decodes printable characters, control keys and CSI sequences", () => {
    const d = new KeyDecoder();
    expect(d.feed("a")).toEqual([{ type: "char", ch: "a" }]);
    expect(d.feed("\x03")).toEqual([{ type: "ctrl", ch: "c" }]);
    expect(d.feed("\x13")).toEqual([{ type: "ctrl", ch: "s" }]);
    expect(d.feed("\r")).toEqual([{ type: "key", name: "enter" }]);
    expect(d.feed("\x7f")).toEqual([{ type: "key", name: "backspace" }]);
    expect(d.feed("\x1b[A")).toEqual([{ type: "key", name: "up" }]);
    expect(d.feed("\x1b[Z")).toEqual([{ type: "key", name: "backtab" }]);
    expect(d.feed("\x1b[3~")).toEqual([{ type: "key", name: "delete" }]);
    expect(d.feed("\x1b[5~")).toEqual([{ type: "key", name: "pageup" }]);
    expect(d.feed("\x1b")).toEqual([{ type: "key", name: "escape" }]);
  });

  it("decodes modifiers on CSI arrows and alt+char", () => {
    const d = new KeyDecoder();
    expect(d.feed("\x1b[1;2A")).toEqual([{ type: "key", name: "up", shift: true }]);
    expect(d.feed("\x1b[1;5C")).toEqual([{ type: "key", name: "right", ctrl: true }]);
    expect(d.feed("\x1bb")).toEqual([{ type: "char", ch: "b", alt: true }]);
  });

  it("splits a chunk holding several keys", () => {
    const d = new KeyDecoder();
    const evs = d.feed("ab\x1b[B\r");
    expect(evs.map((e) => (e.type === "char" ? e.ch : e.type === "key" ? e.name : "?"))).toEqual(["a", "b", "down", "enter"]);
  });

  it("turns a bracketed paste into one paste event, even across chunks", () => {
    const d = new KeyDecoder();
    const first = d.feed('\x1b[200~{"name": "te');
    expect(first).toEqual([]);
    const second = d.feed('am"}\n\x1b[201~x');
    expect(second).toEqual([
      { type: "paste", text: '{"name": "team"}\n' },
      { type: "char", ch: "x" },
    ]);
  });

  it("keeps multi-byte characters intact", () => {
    const [ev, len] = decodeOne("日本", 0);
    expect(ev).toEqual({ type: "char", ch: "日" });
    expect(len).toBe(1);
    const [emoji, elen] = decodeOne("😀", 0);
    expect(emoji).toEqual({ type: "char", ch: "😀" });
    expect(elen).toBe(2);
  });
});
