import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLaunchFlagsFile, readLaunchFlags, writeLaunchFlags } from "./paths";

describe("launch flags", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skipper-launch-"));
    prev = process.env.SKIPPER_DATA_DIR;
    process.env.SKIPPER_DATA_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.SKIPPER_DATA_DIR;
    else process.env.SKIPPER_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  test("nothing recorded reads as empty", () => {
    expect(readLaunchFlags()).toEqual({});
  });

  test("round-trips the experimental flag through the data dir", () => {
    writeLaunchFlags({ experimental: true });
    expect(getLaunchFlagsFile()).toBe(join(dir, "launch-flags.json"));
    expect(JSON.parse(readFileSync(getLaunchFlagsFile(), "utf8"))).toEqual({ experimental: true });
    expect(readLaunchFlags()).toEqual({ experimental: true });
    writeLaunchFlags({ experimental: false });
    expect(readLaunchFlags()).toEqual({ experimental: false });
  });

  test("ignores a malformed or foreign file", () => {
    writeFileSync(getLaunchFlagsFile(), "{not json");
    expect(readLaunchFlags()).toEqual({});
    writeFileSync(getLaunchFlagsFile(), JSON.stringify({ experimental: "yes" }));
    expect(readLaunchFlags()).toEqual({});
  });
});
