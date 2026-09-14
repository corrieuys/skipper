import { describe, it, expect } from "bun:test";
import { GlyphScreen, assertOneWay } from "./screen";
import { parseFrame, ProtocolError } from "./protocol";

const FRAME = 'ra[cb[hc"Title"td"sub"re*0[tf"nothing pending"]]]';

describe("GlyphScreen", () => {
  it("renders and serializes", () => {
    const s = new GlyphScreen();
    expect(s.isEmpty()).toBe(true);
    s.render(FRAME);
    expect(s.serialize()).toBe(FRAME);
    expect(s.isEmpty()).toBe(false);
  });

  it("patches atomically and reports ops + frame", () => {
    const s = new GlyphScreen();
    s.render(FRAME);
    expect(s.patch('~f"one escalation"!')).toEqual([]);
    expect(s.serialize()).toContain('tf!"one escalation"');
    const after = s.serialize();
    expect(() => s.patch('~f"x"-z')).toThrow(ProtocolError);
    expect(s.serialize()).toBe(after);
  });

  it("rejects buttons, inputs and actions (one-way); web views are allowed", () => {
    const s = new GlyphScreen();
    expect(() => s.render('ra[Bb>go"Go"]')).toThrow(/one-way/);
    expect(() => s.render('ra[ib"type"]')).toThrow(/one-way/);
    s.render('ra[wb"https://x"]');
    expect(s.serialize()).toBe('ra[wb"https://x"]');
    s.clear();
    expect(() => s.render('ra[tb>open"x"]')).toThrow(/click actions/);
    expect(s.isEmpty()).toBe(true);
    s.render(FRAME);
    expect(() => s.patch('+e[Bz>go"Go"]')).toThrow(/one-way/);
    expect(s.serialize()).toBe(FRAME);
    expect(() => s.patch("~f>go")).toThrow(/click actions/);
    expect(s.serialize()).toBe(FRAME);
  });

  it("clear empties the screen", () => {
    const s = new GlyphScreen();
    s.render(FRAME);
    s.clear();
    expect(s.isEmpty()).toBe(true);
  });

  it("assertOneWay accepts the plain subset", () => {
    expect(() => assertOneWay(parseFrame('ra[cb=[hc!"x"ld"a\nb"Te"A|B\n1|2"kf"k|v"bg]]'))).not.toThrow();
    expect(() => assertOneWay(null)).not.toThrow();
  });
});

describe("GlyphScreen validators and views", () => {
  it("a validator rejection rolls back a render and a patch", () => {
    const s = new GlyphScreen();
    const noX = (root: import("./protocol").UNode | null) => {
      if (root && JSON.stringify(root).includes("bad")) throw new ProtocolError("bad source", -1);
    };
    expect(() => s.render('ra[wb"bad"]', noX)).toThrow(/bad source/);
    expect(s.isEmpty()).toBe(true);
    s.render('ra[wb"artifact:ok"tc"x"]', noX);
    expect(() => s.patch('~b"bad"', noX)).toThrow(/bad source/);
    expect(s.serialize()).toBe('ra[wb"artifact:ok"tc"x"]');
  });

  it("patch returns refresh ids and view rewrites w sources", () => {
    const s = new GlyphScreen();
    s.render('ra[wb"artifact:ok"cc[wd"/p"]]');
    expect(s.patch("#b#d~c*2")).toEqual(["b", "d"]);
    expect(s.view((t) => `url(${t})`)).toBe('ra[wb"url(artifact:ok)"cc*2[wd"url(/p)"]]');
    expect(s.serialize()).toBe('ra[wb"artifact:ok"cc*2[wd"/p"]]');
    expect(s.view(() => "x")).not.toBe(s.serialize());
    s.clear();
    expect(s.view(() => "x")).toBe("");
  });
});
