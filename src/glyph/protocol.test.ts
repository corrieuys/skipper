import { describe, expect, test } from "bun:test";
import { Tree, parseFrame, parseOps, serializeNode, ProtocolError } from "./protocol";

const FRAME = 'ra[cb[tc"Name"td"Email"]ce[Bf>save"Save"Bg>cancel"Cancel"]]';

describe("frame", () => {
  test("roundtrip", () => {
    expect(serializeNode(parseFrame(FRAME))).toBe(FRAME);
  });
  test("weights, actions, boxes, whitespace", () => {
    const s = 'ra[ cb*2[ bx>go; by ] cc*1 ]';
    const n = parseFrame(s);
    expect(serializeNode(n)).toBe("ra[cb*2[bx>go;by]cc*1]");
    expect(n.children[0]!.children[0]!.action).toBe("go");
  });
  test("web node", () => {
    const n = parseFrame('ra[wb"https://example.com"]');
    expect(n.children[0]!.type).toBe("w");
    expect(serializeNode(n)).toBe('ra[wb"https://example.com"]');
  });
  test("data leaves", () => {
    const f = 'ca[hb"Title"lc"one\ntwo"Td"A|B\n1|2"ke"k|v"]';
    expect(serializeNode(parseFrame(f))).toBe(f);
  });
  test("center", () => {
    const f = 'ca=[cc*0[hd"glyph ui"te"waiting"]bf=;]';
    expect(serializeNode(parseFrame(f))).toBe(f);
    const t = Tree.fromFrame(f);
    t.applyOps("~a=0~c=");
    expect(t.get("a").center).toBeUndefined();
    expect(t.get("c").center).toBe(true);
  });
  test("emphasis", () => {
    expect(serializeNode(parseFrame('ra[cb![tc!"x"]bd!;be]'))).toBe('ra[cb![tc!"x"]bd!;be]');
    const t = Tree.fromFrame(FRAME);
    t.applyOps("~c!");
    expect(t.get("c").emphasis).toBe(true);
    t.applyOps("~c!0~d!1");
    expect(t.get("c").emphasis).toBeUndefined();
    expect(t.get("d").emphasis).toBe(true);
  });
  test("errors carry position", () => {
    expect(() => parseFrame('ra[tb"x"')).toThrow(ProtocolError);
    expect(() => parseFrame('ra[ra]')).toThrow(/duplicate/);
    expect(() => Tree.fromFrame('ra[ra]')).toThrow(/duplicate/);
    expect(() => parseFrame('tb[ra]')).toThrow(/cannot have children/);
    expect(() => parseFrame('ra"x"')).toThrow(/cannot have text/);
    expect(() => parseFrame('ra]')).toThrow(/trailing/);
  });
});

describe("ops", () => {
  test("parse all ops", () => {
    const ops = parseOps('-g~f"OK"+e[Bh>back"Back"]^ce@0%bc~ar~x*2>go');
    expect(ops.map((o) => o.op)).toEqual(["remove", "set", "insert", "move", "swap", "set", "set"]);
    expect(ops[3]).toEqual({ op: "move", id: "c", parent: "e", index: 0 });
    expect(ops[6]).toEqual({ op: "set", id: "x", weight: 2, action: "go" });
  });
  test("flip orientation", () => {
    const t = Tree.fromFrame(FRAME);
    t.applyOps("~ac~br~er");
    expect(t.serialize()).toBe('ca[rb[tc"Name"td"Email"]re[Bf>save"Save"Bg>cancel"Cancel"]]');
  });
  test("remove, insert, move, swap", () => {
    const t = Tree.fromFrame(FRAME);
    t.applyOps("-g");
    expect(t.has("g")).toBe(false);
    t.applyOps('+e@0[Bh>back"Back"]');
    expect(t.get("e").children.map((n) => n.id)).toEqual(["h", "f"]);
    t.applyOps("^cb@1");
    expect(t.get("b").children.map((n) => n.id)).toEqual(["d", "c"]);
    t.applyOps("^ce");
    expect(t.get("e").children.map((n) => n.id)).toEqual(["h", "f", "c"]);
    t.applyOps("%be");
    expect(t.root!.children.map((n) => n.id)).toEqual(["e", "b"]);
    t.applyOps("%dh");
    expect(t.get("b").children.map((n) => n.id)).toEqual(["h"]);
    expect(t.get("e").children.map((n) => n.id)).toEqual(["d", "f", "c"]);
  });
  test("refresh validates only", () => {
    const t = Tree.fromFrame(FRAME);
    t.applyOps("#c");
    expect(t.serialize()).toBe(FRAME);
    expect(() => t.applyOps("#z")).toThrow(/unknown id/);
  });
  test("atomic on failure", () => {
    const t = Tree.fromFrame(FRAME);
    expect(() => t.applyOps("-g-z")).toThrow(/unknown id/);
    expect(t.has("g")).toBe(true);
    expect(t.serialize()).toBe(FRAME);
  });
  test("guards", () => {
    const t = Tree.fromFrame(FRAME);
    expect(() => t.applyOps("^ab")).toThrow(/root/);
    expect(() => t.applyOps("^bc")).toThrow(/not a container/);
    expect(() => t.applyOps("~bt")).toThrow(/retype/);
    expect(() => t.applyOps("+b[tc\"x\"]")).toThrow(/duplicate/);
    expect(() => t.applyOps("%ab")).toThrow(/root/);
    expect(() => t.applyOps("%bc")).toThrow(/nested/);
    t.applyOps("-a");
    expect(t.root).toBeNull();
  });
});
