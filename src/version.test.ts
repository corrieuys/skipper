import { describe, it, expect } from "bun:test";
import { parseSemver, compareSemver, classifyBump } from "./version";

describe("parseSemver", () => {
  it("parses X.Y.Z with an optional leading v", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("v0.10.0")).toEqual({ major: 0, minor: 10, patch: 0 });
  });

  it("drops prerelease/build suffixes for the core", () => {
    expect(parseSemver("1.2.3-beta.1")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("1.2.3+build.5")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("returns null for non-semver", () => {
    expect(parseSemver("dev")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
    expect(compareSemver("1.3.0", "1.2.9")).toBe(1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("treats unparseable operands as 0 (not newer)", () => {
    expect(compareSemver("dev", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0", "garbage")).toBe(0);
  });
});

describe("classifyBump", () => {
  it("classifies patch, minor, major", () => {
    expect(classifyBump("1.2.3", "1.2.4")).toBe("patch");
    expect(classifyBump("1.2.3", "1.3.0")).toBe("minor");
    expect(classifyBump("1.2.3", "2.0.0")).toBe("major");
  });

  it("does not treat a prerelease target as a patch", () => {
    expect(classifyBump("1.2.3", "1.2.4-beta.1")).toBe("none");
  });

  it("handles downgrade and equal", () => {
    expect(classifyBump("1.2.4", "1.2.3")).toBe("downgrade");
    expect(classifyBump("1.2.3", "1.2.3")).toBe("none");
  });

  it("returns none for unparseable inputs (e.g. dev)", () => {
    expect(classifyBump("dev", "1.2.3")).toBe("none");
  });
});
