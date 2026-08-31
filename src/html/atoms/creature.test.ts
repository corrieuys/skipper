import { describe, it, expect } from "bun:test";
import {
  CREATURE_IDS, creatureSvg, creatureShapes, isCreatureId, sanitizeColor, shade, inkFor,
} from "./creature";

describe("sanitizeColor", () => {
  it("accepts #rgb and #rrggbb, lowercased", () => {
    expect(sanitizeColor("#ABC")).toBe("#abc");
    expect(sanitizeColor("#6EA8FE")).toBe("#6ea8fe");
  });
  it("rejects junk → default", () => {
    expect(sanitizeColor("red")).toBe("#6ea8fe");
    expect(sanitizeColor("javascript:alert(1)")).toBe("#6ea8fe");
    expect(sanitizeColor(null)).toBe("#6ea8fe");
    expect(sanitizeColor("#12")).toBe("#6ea8fe");
  });
});

describe("isCreatureId", () => {
  it("is true only for the six known ids", () => {
    for (const id of CREATURE_IDS) expect(isCreatureId(id)).toBe(true);
    expect(isCreatureId("dragon")).toBe(false);
    expect(isCreatureId("")).toBe(false);
    expect(isCreatureId(null)).toBe(false);
  });
});

describe("shade / inkFor", () => {
  it("darkens toward the leg/outline ink", () => {
    expect(shade("#ffffff", -45)).toBe("#d2d2d2");
    expect(inkFor("#6ea8fe")).toBe(shade("#6ea8fe", -45));
  });
  it("clamps at 0", () => {
    expect(shade("#000000", -45)).toBe("#000000");
  });
});

describe("creatureSvg", () => {
  it("resolves all six ids to an <svg> with the creature class", () => {
    for (const id of CREATURE_IDS) {
      const svg = creatureSvg(id);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain("zen-orb__creature");
      expect(svg).toContain("var(--agent-color)");
      expect(svg).toContain("var(--agent-ink)");
    }
  });
  it("bakes the color inline when given one", () => {
    const svg = creatureSvg("blob", "#7bd88f");
    expect(svg).toContain("--agent-color:#7bd88f");
    expect(svg).toContain("--agent-ink:" + inkFor("#7bd88f"));
  });
  it("omits the inline style when no color is given (inherits from ancestor)", () => {
    expect(creatureSvg("pod")).not.toContain("--agent-color:#");
  });
  it("shapes carry two eyes (white sclera + dark pupil)", () => {
    const shapes = creatureShapes("mite");
    expect(shapes).toContain('fill="#fff"');
    expect(shapes).toContain('fill="#1a2030"');
  });
});
