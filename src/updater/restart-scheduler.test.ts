import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { setStringSetting } from "../config/app-settings";
import { setAutoUpdateEnabled, SETTING_UPDATE_DOWNLOADED_VERSION } from "../config/auto-update-settings";
import { __resetRestartGuardForTests } from "./auto-updater";
import { initUpdateRestartOnIdle } from "./restart-scheduler";
import { eventBus } from "../events/bus";

let db: Database;
let stop: (() => void) | null = null;

const idleAgents = { getRunningAgents: () => ({ size: 0 }) };

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  __resetRestartGuardForTests();
});

afterEach(() => {
  stop?.();
  stop = null;
  db.close();
});

/**
 * These exercise the real default runRestart via the module, which would spawn a
 * process — so we keep the guard from firing by leaving the environment un-idle or
 * without a pending download, and assert the DOWNLOADED marker gating instead.
 * (The restart decision itself is unit-tested in auto-updater.test.ts with a spy.)
 */
describe("initUpdateRestartOnIdle", () => {
  it("does not restart on a state change when no update is pending", () => {
    setAutoUpdateEnabled(db, true);
    stop = initUpdateRestartOnIdle(db, idleAgents);
    // No SETTING_UPDATE_DOWNLOADED_VERSION → restartIfUpdatePending bails before
    // ever reaching runRestart, so emitting is safe (no process spawned).
    expect(() =>
      eventBus.emit("task:state_changed", { taskId: "t1", previousStatus: "running", newStatus: "completed" }),
    ).not.toThrow();
  });

  it("does not restart while a task is still queued, even with a pending download", () => {
    setAutoUpdateEnabled(db, true);
    setStringSetting(db, SETTING_UPDATE_DOWNLOADED_VERSION, "1.2.4");
    // An approved task in the queue means not fully idle → the real idle check
    // blocks the restart, so no process is spawned.
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('q1', 'Queued', 'approved')").run();
    stop = initUpdateRestartOnIdle(db, idleAgents);
    expect(() =>
      eventBus.emit("task:state_changed", { taskId: "q1", previousStatus: "running", newStatus: "completed" }),
    ).not.toThrow();
    // Still pending — a later idle event (or hourly tick) will apply it.
    expect(
      db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SETTING_UPDATE_DOWNLOADED_VERSION),
    ).toBeTruthy();
  });

  it("stop() unsubscribes so later events are ignored", () => {
    stop = initUpdateRestartOnIdle(db, idleAgents);
    stop();
    stop = null;
    expect(() =>
      eventBus.emit("task:state_changed", { taskId: "t1", previousStatus: "running", newStatus: "completed" }),
    ).not.toThrow();
  });
});
