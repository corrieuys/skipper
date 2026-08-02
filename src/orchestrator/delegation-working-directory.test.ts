import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { validateWorkingDirectory } from "./delegation-manager";

let realDir: string;
let realFile: string;

beforeAll(() => {
  realDir = mkdtempSync(join(tmpdir(), "skipper-wd-"));
  realFile = join(realDir, "not-a-dir.txt");
  writeFileSync(realFile, "x");
});

afterAll(() => rmSync(realDir, { recursive: true, force: true }));

describe("validateWorkingDirectory", () => {
  it("accepts an existing directory and returns it trimmed", () => {
    expect(validateWorkingDirectory(`  ${realDir}  `)).toBe(realDir);
  });

  it("rejects an empty or whitespace-only value", () => {
    expect(() => validateWorkingDirectory("")).toThrow(/empty/);
    expect(() => validateWorkingDirectory("   ")).toThrow(/empty/);
  });

  it("rejects a relative path", () => {
    // Resolving it would silently anchor to the daemon's cwd, which is exactly the
    // ambiguity this parameter exists to remove.
    expect(() => validateWorkingDirectory("./src")).toThrow(/absolute/);
    expect(() => validateWorkingDirectory("src/orchestrator")).toThrow(/absolute/);
  });

  it("rejects a path that does not exist", () => {
    expect(() => validateWorkingDirectory(join(realDir, "nope"))).toThrow(/does not exist/);
  });

  it("rejects a file", () => {
    expect(() => validateWorkingDirectory(realFile)).toThrow(/not a directory/);
  });

  it("names the offending path in the error", () => {
    const missing = join(realDir, "missing-repo");
    expect(() => validateWorkingDirectory(missing)).toThrow(missing);
  });
});
