import { describe, it, expect } from "bun:test";
import { TextBuffer } from "./text-editor";

describe("TextBuffer", () => {
  it("inserts, moves and deletes", () => {
    const b = new TextBuffer("");
    b.insert("hello");
    expect(b.value).toBe("hello");
    b.handle({ type: "key", name: "left" });
    b.handle({ type: "key", name: "left" });
    b.insert("X");
    expect(b.value).toBe("helXlo");
    b.handle({ type: "key", name: "backspace" });
    expect(b.value).toBe("hello");
    b.handle({ type: "key", name: "delete" });
    expect(b.value).toBe("helo");
  });

  it("supports word and line editing shortcuts", () => {
    const b = new TextBuffer("one two three");
    b.handle({ type: "ctrl", ch: "w" });
    expect(b.value).toBe("one two ");
    b.handle({ type: "ctrl", ch: "a" });
    expect(b.caret).toBe(0);
    b.handle({ type: "ctrl", ch: "k" });
    expect(b.value).toBe("");
    b.insert("alpha beta");
    b.handle({ type: "char", ch: "b", alt: true });
    expect(b.caret).toBe(6);
  });

  it("keeps single-line fields single-line but lets areas take newlines", () => {
    const single = new TextBuffer("");
    single.handle({ type: "paste", text: "a\nb" });
    expect(single.value).toBe("a b");
    const multi = new TextBuffer("", true);
    multi.handle({ type: "paste", text: "a\r\nb" });
    expect(multi.value).toBe("a\nb");
    multi.handle({ type: "ctrl", ch: "j" });
    expect(multi.value).toBe("a\nb\n");
  });

  it("moves vertically between lines keeping the column", () => {
    const b = new TextBuffer("abc\nde\nfghij", true);
    // caret at end (line 2, col 5)
    b.handle({ type: "key", name: "up" });
    expect(b.caretLineCol()).toEqual({ line: 1, col: 2 });
    b.handle({ type: "key", name: "up" });
    expect(b.caretLineCol()).toEqual({ line: 0, col: 2 });
    b.handle({ type: "key", name: "down" });
    expect(b.caretLineCol()).toEqual({ line: 1, col: 2 });
  });

  it("soft-wraps for a viewport and tracks the caret row/col", () => {
    const b = new TextBuffer("abcdefgh", true); // caret at 8
    const v = b.view(4, 2, 0);
    expect(v.rows).toEqual(["abcd", "efgh"]);
    // caret sits at the wrap boundary after the last row → virtual next row
    expect(v.caret).toEqual({ row: 2, col: 0 });
    b.caret = 5;
    const v2 = b.view(4, 2, 0);
    expect(v2.caret).toEqual({ row: 1, col: 1 });
  });
});
