import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { clearAgentTypeCache } from "../agents/types";
import { isAllowedProvider, listModelOptions, saveModelSetting } from "./model-settings";

let db: Database;

beforeEach(() => {
  clearAgentTypeCache();
  db = new Database(":memory:");
  initializeDatabase(db);
});

afterEach(() => {
  db.close();
});

function withExperimental<T>(fn: () => T): T {
  process.argv.push("--experimental");
  try {
    return fn();
  } finally {
    const i = process.argv.indexOf("--experimental");
    if (i >= 0) process.argv.splice(i, 1);
  }
}

describe("provider allowlist", () => {
  it("always allows the stable providers", () => {
    expect(isAllowedProvider("claude-code")).toBe(true);
  });

  it("hides experimental providers without the experimental flag", () => {
    for (const name of ["codex", "opencode", "grok"]) {
      expect(isAllowedProvider(name)).toBe(false);
    }
    const offered = listModelOptions().map((o) => o.name);
    expect(offered).toEqual(["claude-code"]);
  });

  it("offers codex, opencode, and grok when experimental is on", () => {
    withExperimental(() => {
      for (const name of ["codex", "opencode", "grok"]) {
        expect(isAllowedProvider(name)).toBe(true);
      }
      const grok = listModelOptions().find((o) => o.name === "grok");
      expect(grok).toBeTruthy();
      expect(grok!.model_flag).toBe("-m");
      expect(grok!.models).toContain("default");
      expect(grok!.models).toContain("grok-4.5");
      const codex = listModelOptions().find((o) => o.name === "codex");
      expect(codex!.model_flag).toBe("-m");
    });
  });

  it("never offers internal aliases", () => {
    withExperimental(() => {
      expect(isAllowedProvider("conversation-skipper")).toBe(false);
      expect(isAllowedProvider("custom")).toBe(false);
    });
  });
});

describe("saveModelSetting with grok", () => {
  it("rejects grok as provider without experimental", () => {
    const err = saveModelSetting(db, "skipper", "grok", "grok-4.5");
    expect(err).toContain("Unknown provider");
  });

  it("accepts grok as skipper provider when experimental", () => {
    withExperimental(() => {
      const err = saveModelSetting(db, "skipper", "grok", "grok-4.5");
      expect(err).toBeNull();
    });
  });
});
