import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { clearAgentTypeCache } from "../agents/types";
import { TaskScheduler } from "./scheduler";
import { cleanTitle, timestampTitle, generateTaskTitle, ensureTaskTitle } from "./title-generator";

let db: Database;
let scheduler: TaskScheduler;

beforeEach(() => {
  clearAgentTypeCache();
  db = new Database(":memory:");
  initializeDatabase(db);
  scheduler = new TaskScheduler(db);
});

afterEach(() => {
  db.close();
});

describe("cleanTitle", () => {
  it("returns null for empty/whitespace", () => {
    expect(cleanTitle(undefined)).toBeNull();
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle("   \n  ")).toBeNull();
  });

  it("takes the first non-empty line and strips quotes and trailing dots", () => {
    expect(cleanTitle('"Fix the login bug".')).toBe("Fix the login bug");
    expect(cleanTitle("\n\nRefactor auth module\n\nextra")).toBe("Refactor auth module");
    expect(cleanTitle("`Ship v2`")).toBe("Ship v2");
  });

  it("caps overly long titles", () => {
    const long = "word ".repeat(40).trim();
    const cleaned = cleanTitle(long)!;
    expect(cleaned.length).toBeLessThanOrEqual(80);
  });
});

describe("timestampTitle", () => {
  it("produces a 'YYYY-MM-DD HH:MM' stamp", () => {
    expect(timestampTitle()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("generateTaskTitle", () => {
  it("returns null when no generator provider is configured", async () => {
    const result = await generateTaskTitle(db, { description: "Do a thing" });
    expect(result).toBeNull();
  });
});

describe("ensureTaskTitle", () => {
  it("leaves an existing title untouched", async () => {
    const task = scheduler.createTask({ title: "Keep me" });
    await ensureTaskTitle(db, scheduler, task.id);
    expect(scheduler.getTask(task.id)!.title).toBe("Keep me");
  });

  it("stamps a timestamp when a blank title has no generator to fall back on", async () => {
    // No generator configured → generateTaskTitle returns null → timestamp safety net.
    const task = scheduler.createTask({ title: "" });
    await ensureTaskTitle(db, scheduler, task.id);
    expect(scheduler.getTask(task.id)!.title).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("no-ops on an unknown task id", async () => {
    await ensureTaskTitle(db, scheduler, "missing");
    // nothing to assert beyond not throwing
    expect(true).toBe(true);
  });
});
