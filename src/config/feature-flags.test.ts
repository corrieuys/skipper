import { describe, expect, test } from "bun:test";
import { resolveExperimentalLaunch } from "./feature-flags";

describe("resolveExperimentalLaunch", () => {
  test("explicit --experimental wins regardless of the recorded state", () => {
    expect(resolveExperimentalLaunch(["restart", "--experimental"], false)).toBe(true);
    expect(resolveExperimentalLaunch(["restart", "--experimental"], undefined)).toBe(true);
  });

  test("explicit --no-experimental turns it off even when recorded on", () => {
    expect(resolveExperimentalLaunch(["restart", "--no-experimental"], true)).toBe(false);
    expect(resolveExperimentalLaunch(["start", "--no-experimental", "--experimental"], true)).toBe(false);
  });

  test("no flag honours the recorded state of the last boot", () => {
    expect(resolveExperimentalLaunch(["restart", "--no-open"], true)).toBe(true);
    expect(resolveExperimentalLaunch(["restart"], false)).toBe(false);
    expect(resolveExperimentalLaunch(["start"], undefined)).toBe(false);
  });
});
