import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { unlinkSync } from "fs";
import { getRealtimeConfig, updateRealtimeConfig, clampCadenceSeconds } from "./config";

const TEST_DB = "test-realtime-config.db";
let db: Database | null = null;
afterEach(() => {
  db?.close();
  db = null;
  try { unlinkSync(TEST_DB); } catch { /* ignore */ }
});

describe("realtime config", () => {
  it("defaults to a 60 s cadence with the summary on, and round-trips updates", () => {
    db = new Database(TEST_DB);
    initializeDatabase(db);
    const initial = getRealtimeConfig(db);
    expect(initial.cadence_seconds).toBe(60);
    expect(initial.summary_enabled).toBe(true);
    const updated = updateRealtimeConfig({ cadence_seconds: 120, summary_enabled: false }, db);
    expect(updated.cadence_seconds).toBe(120);
    expect(updated.summary_enabled).toBe(false);
    expect(getRealtimeConfig(db).summary_enabled).toBe(false);
  });

  it("clamps a stored cadence into the supported range", () => {
    db = new Database(TEST_DB);
    initializeDatabase(db);
    updateRealtimeConfig({ cadence_seconds: 5000 }, db);
    expect(getRealtimeConfig(db).cadence_seconds).toBe(600);
    expect(clampCadenceSeconds(2)).toBe(5);
    expect(clampCadenceSeconds("abc", 60)).toBe(60);
    expect(clampCadenceSeconds(90.7)).toBe(90);
  });
});
