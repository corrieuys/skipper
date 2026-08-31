import { describe, it, expect } from "bun:test";
import { computeLayout } from "./layout";

describe("computeLayout", () => {
  it("uses the rail layout on a large terminal: rail beside a full-height output", () => {
    const l = computeLayout(140, 44);
    expect(l.mode).toBe("rail");
    // rail (tasks over agents) on the left
    expect(l.panes.tasks.x).toBe(1);
    expect(l.panes.agents.x).toBe(1);
    expect(l.panes.agents.y).toBe(l.panes.tasks.y + l.panes.tasks.h);
    // output fills the right, full body height
    expect(l.panes.output.x).toBe(l.panes.tasks.w + 1);
    expect(l.panes.tasks.w + l.panes.output.w).toBe(140);
    expect(l.panes.output.y + l.panes.output.h).toBe(l.footer.y);
    // rail tasks + agents also span the full body height
    expect(l.panes.agents.y + l.panes.agents.h).toBe(l.footer.y);
    // output is the tallest pane (the star)
    expect(l.panes.output.h).toBeGreaterThanOrEqual(l.panes.tasks.h);
  });

  it("stacks output → agents → tasks when small", () => {
    const l = computeLayout(80, 40);
    expect(l.mode).toBe("stacked");
    expect(l.panes.output.w).toBe(80);
    expect(l.panes.agents.y).toBe(l.panes.output.y + l.panes.output.h);
    expect(l.panes.tasks.y).toBe(l.panes.agents.y + l.panes.agents.h);
    expect(l.panes.tasks.y + l.panes.tasks.h).toBe(l.footer.y);
    // output gets the most room
    expect(l.panes.output.h).toBeGreaterThanOrEqual(l.panes.agents.h);
  });

  it("never returns non-positive rects on a tiny terminal", () => {
    const l = computeLayout(1, 1);
    for (const r of [l.header, l.footer, l.panes.tasks, l.panes.agents, l.panes.output]) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
    }
  });
});
