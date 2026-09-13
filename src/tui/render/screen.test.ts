import { describe, it, expect } from "bun:test";
import { Screen, clip, padEnd, wrap, sgr } from "./screen";

describe("Screen", () => {
  it("draws clipped text and reads it back", () => {
    const s = new Screen(10, 2);
    s.text(0, 0, "hello world!!", { fg: 1 });
    expect(s.rowText(0)).toBe("hello worl");
    s.textClip(0, 1, "hello world!!", 10);
    expect(s.rowText(1)).toBe("hello wor…");
  });

  it("keeps wide characters whole: a 2-cell glyph never straddles the clip edge", () => {
    const s = new Screen(5, 1);
    s.text(0, 0, "ab日本", {});
    // 'a','b' = 2 cells, '日' = 2 cells (4), '本' needs 2 → does not fit in 1
    expect(s.rowText(0)).toBe("ab日 ");
    // overwriting the tail of a wide char blanks its head
    s.put(3, 0, "x");
    expect(s.rowText(0)).toBe("ab x ");
  });

  it("boxes and fills", () => {
    const s = new Screen(6, 3);
    s.box(0, 0, 6, 3, {});
    expect(s.toLines()).toEqual(["╭────╮", "│    │", "╰────╯"]);
    s.fill(1, 1, 4, 1, "#");
    expect(s.rowText(1)).toBe("│####│");
  });

  it("diffs only the changed cells against the previous frame", () => {
    const a = new Screen(8, 2);
    a.text(0, 0, "same", {});
    const b = new Screen(8, 2);
    b.text(0, 0, "same", {});
    b.text(0, 1, "new", { fg: 2 });
    const out = b.diff(a);
    expect(out).toContain("new");
    expect(out).not.toContain("same");
    // a full repaint includes everything
    expect(b.diff(null)).toContain("same");
    // no changes → empty
    expect(b.diff(b)).toBe("");
  });

  it("restyles a region without changing glyphs (modal backdrop dim)", () => {
    const s = new Screen(4, 1);
    s.text(0, 0, "abcd", { fg: 10 });
    s.restyle(0, 0, 2, 1, (st) => ({ ...st, dim: true }));
    expect(s.cellAt(0, 0)?.st.dim).toBe(true);
    expect(s.cellAt(2, 0)?.st.dim).toBeUndefined();
    expect(s.rowText(0)).toBe("abcd");
  });
});

describe("text helpers", () => {
  it("clip / padEnd respect cell widths", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abc", 4)).toBe("abc");
    expect(padEnd("ab", 4)).toBe("ab  ");
    expect(padEnd("日本語", 4)).toBe("日… ");
  });

  it("wraps on words and hard-breaks long tokens", () => {
    expect(wrap("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
    expect(wrap("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
    expect(wrap("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });

  it("emits SGR from a style", () => {
    expect(sgr({ fg: 44, bold: true })).toBe("\x1b[0;1;38;5;44m");
    expect(sgr({})).toBe("\x1b[0m");
  });
});
