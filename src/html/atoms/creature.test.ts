import { describe, it, expect } from "bun:test";
import {
  CREATURE_IDS, isCreatureId, sanitizeColor, shade, inkFor,
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
