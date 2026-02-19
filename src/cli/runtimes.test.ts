import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import {
  detectRuntime,
  validateRuntimeAvailable,
  getCachedRuntime,
  clearRuntimeCache,
} from "./runtimes";
import { unlinkSync } from "fs";

const TEST_DB = "test-runtimes.db";

let db: Database;

beforeEach(() => {
  clearRuntimeCache();
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

describe("detectRuntime", () => {
  it("detects an available command (bun)", async () => {
    const info = await detectRuntime("bun", db);
    expect(info.command).toBe("bun");
    expect(info.available).toBe(true);
    expect(info.path).toBeTruthy();
    expect(info.version).toBeTruthy();
  });

  it("returns unavailable for nonexistent command", async () => {
    const info = await detectRuntime("nonexistent-cmd-xyz-12345", db);
    expect(info.command).toBe("nonexistent-cmd-xyz-12345");
    expect(info.available).toBe(false);
    expect(info.path).toBeNull();
  });

  it("persists detection to database", async () => {
    await detectRuntime("bun", db);
    const row = db
      .prepare("SELECT * FROM cli_runtimes WHERE command = ?")
      .get("bun") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.available).toBe(1);
    expect(row.path).toBeTruthy();
  });

  it("updates existing DB entry on re-detection", async () => {
    await detectRuntime("bun", db);
    clearRuntimeCache();
    await detectRuntime("bun", db);
    const count = db
      .prepare("SELECT COUNT(*) as cnt FROM cli_runtimes WHERE command = ?")
      .get("bun") as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("uses in-memory cache on repeated calls", async () => {
    const first = await detectRuntime("bun", db);
    // Delete from DB to prove cache is used
    db.prepare("DELETE FROM cli_runtimes WHERE command = ?").run("bun");
    const second = await detectRuntime("bun", db);
    expect(second).toEqual(first);
  });
});

describe("validateRuntimeAvailable", () => {
  it("returns true for available command", async () => {
    const result = await validateRuntimeAvailable("bun", db);
    expect(result).toBe(true);
  });

  it("returns false for unavailable command", async () => {
    const result = await validateRuntimeAvailable(
      "nonexistent-cmd-xyz-12345",
      db,
    );
    expect(result).toBe(false);
  });
});

describe("getCachedRuntime", () => {
  it("returns null when no cache exists", () => {
    const result = getCachedRuntime("bun", db);
    expect(result).toBeNull();
  });

  it("returns from in-memory cache after detection", async () => {
    await detectRuntime("bun", db);
    const result = getCachedRuntime("bun", db);
    expect(result).not.toBeNull();
    expect(result!.available).toBe(true);
  });

  it("falls back to DB when in-memory cache is cleared", async () => {
    await detectRuntime("bun", db);
    clearRuntimeCache();
    const result = getCachedRuntime("bun", db);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("bun");
    expect(result!.available).toBe(true);
  });
});
