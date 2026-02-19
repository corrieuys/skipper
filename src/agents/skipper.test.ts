import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "fs";
import { initializeDatabase } from "../db/connection";
import { getSkipperConfig, updateSkipperConfig } from "./skipper";

const TEST_DB = "test-skipper.db";

let db: Database;

describe("skipper config defaults", () => {
  beforeEach(() => {
    db = new Database(TEST_DB);
    db.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(db);
  });

  afterEach(() => {
    db.close();
    try {
      unlinkSync(TEST_DB);
    } catch { }
  });

  it("provides fallback main and realtime prompts when config rows are missing", () => {
    db.prepare("DELETE FROM skipper_config WHERE key IN ('prompt', 'realtime_prompt')").run();

    const config = getSkipperConfig(db);
    expect(config.prompt.length).toBeGreaterThan(0);
    expect(config.realtime_prompt.length).toBeGreaterThan(0);
    expect(config.prompt).toContain("ROLE: You are Skipper");
    expect(config.realtime_prompt).toContain("real-time monitoring mode");
    expect(config.realtime_prompt).toContain("passive listener");
    expect(config.realtime_prompt).toContain("librarian");
  });

  it("returns explicitly configured prompts when set", () => {
    updateSkipperConfig(
      {
        prompt: "CUSTOM_MAIN_PROMPT",
        realtime_prompt: "CUSTOM_REALTIME_PROMPT",
      },
      db,
    );

    const config = getSkipperConfig(db);
    expect(config.prompt).toBe("CUSTOM_MAIN_PROMPT");
    expect(config.realtime_prompt).toBe("CUSTOM_REALTIME_PROMPT");
  });
});

