import { describe, it, expect } from "bun:test";
import { computeLayout, centered } from "./layout";

describe("computeLayout", () => {
  it("uses three columns on a wide terminal: rail | detail | feed", () => {
    const l = computeLayout(180, 50);
    expect(l.mode).toBe("triple");
    expect(l.rail!.x).toBe(0);
    expect(l.main.x).toBe(l.rail!.w);
    expect(l.feed!.x).toBe(l.rail!.w + l.main.w);
    expect(l.rail!.w + l.main.w + l.feed!.w).toBe(180);
    // body spans header → footer
    expect(l.main.y).toBe(l.header.h);
    expect(l.main.y + l.main.h).toBe(l.footer.y);
    // detail is the widest column
    expect(l.main.w).toBeGreaterThanOrEqual(l.rail!.w);
  });

  it("drops the feed column at medium widths", () => {
    const l = computeLayout(120, 40);
    expect(l.mode).toBe("double");
    expect(l.feed).toBeNull();
    expect(l.rail!.w + l.main.w).toBe(120);
  });

  it("goes single-column when narrow", () => {
    const l = computeLayout(80, 30);
    expect(l.mode).toBe("single");
    expect(l.rail).toBeNull();
    expect(l.main.w).toBe(80);
  });

  it("never returns non-positive rects on a tiny terminal", () => {
    const l = computeLayout(1, 1);
    for (const r of [l.header, l.footer, l.main]) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
    }
  });

  it("centers a modal and clamps it inside the screen", () => {
    const r = centered(100, 40, 60, 20);
    expect(r.x).toBe(20);
    expect(r.y).toBe(10);
    const big = centered(50, 20, 200, 200);
    expect(big.w).toBeLessThanOrEqual(50);
    expect(big.h).toBeLessThanOrEqual(20);
    expect(big.x).toBeGreaterThanOrEqual(0);
  });
});
