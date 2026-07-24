import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { getStringSetting, setStringSetting } from "../config/app-settings";
import {
  setAutoUpdateEnabled,
  SETTING_UPDATE_AVAILABLE_VERSION,
  SETTING_UPDATE_DOWNLOADED_VERSION,
} from "../config/auto-update-settings";
import {
  checkForUpdates,
  restartIfUpdatePending,
  isSystemFullyIdle,
  __resetRestartGuardForTests,
  type UpdaterDeps,
} from "./auto-updater";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
  __resetRestartGuardForTests();
});

afterEach(() => db.close());

/** Base fake deps: compiled binary on 1.2.3, idle, spies for update/restart. */
function fakeDeps(over: Partial<UpdaterDeps> = {}): {
  deps: Partial<UpdaterDeps>;
  calls: { update: number; restart: number };
} {
  const calls = { update: 0, restart: 0 };
  const deps: Partial<UpdaterDeps> = {
    currentVersion: "1.2.3",
    isCompiled: true,
    isSystemIdle: () => true,
    runUpdate: async () => {
      calls.update++;
      return true;
    },
    runRestart: () => {
      calls.restart++;
    },
    ...over,
  };
  return { deps, calls };
}

describe("checkForUpdates", () => {
  it("records the available version when a newer release exists", async () => {
    const { deps } = fakeDeps({ fetchLatest: async () => "1.2.4" });
    await checkForUpdates(db, deps);
    expect(getStringSetting(db, SETTING_UPDATE_AVAILABLE_VERSION, "")).toBe("1.2.4");
  });

  it("clears a stale available marker when nothing is newer", async () => {
    db.prepare("INSERT INTO app_settings (key, value, value_type) VALUES (?, '9.9.9', 'string')").run(
      SETTING_UPDATE_AVAILABLE_VERSION,
    );
    const { deps } = fakeDeps({ fetchLatest: async () => "1.2.3" });
    await checkForUpdates(db, deps);
    expect(getStringSetting(db, SETTING_UPDATE_AVAILABLE_VERSION, "")).toBe("");
  });

  it("auto-applies a patch when enabled + idle (update then restart)", async () => {
    setAutoUpdateEnabled(db, true);
    const { deps, calls } = fakeDeps({ fetchLatest: async () => "1.2.4" });
    await checkForUpdates(db, deps);
    expect(calls.update).toBe(1);
    expect(calls.restart).toBe(1);
    expect(getStringSetting(db, SETTING_UPDATE_DOWNLOADED_VERSION, "")).toBe("1.2.4");
  });

  it("does not auto-apply minor or major bumps", async () => {
    setAutoUpdateEnabled(db, true);
    const minor = fakeDeps({ fetchLatest: async () => "1.3.0" });
    await checkForUpdates(db, minor.deps);
    expect(minor.calls.update).toBe(0);
    expect(minor.calls.restart).toBe(0);

    const major = fakeDeps({ fetchLatest: async () => "2.0.0" });
    await checkForUpdates(db, major.deps);
    expect(major.calls.update).toBe(0);
    expect(major.calls.restart).toBe(0);
  });

  it("updates but does not restart when a task is running", async () => {
    setAutoUpdateEnabled(db, true);
    const { deps, calls } = fakeDeps({ fetchLatest: async () => "1.2.4", isSystemIdle: () => false });
    await checkForUpdates(db, deps);
    expect(calls.update).toBe(1);
    expect(calls.restart).toBe(0);
    // Downloaded is recorded so a later idle tick can restart without re-downloading.
    expect(getStringSetting(db, SETTING_UPDATE_DOWNLOADED_VERSION, "")).toBe("1.2.4");
  });

  it("does not re-download when already downloaded (retries restart only)", async () => {
    setAutoUpdateEnabled(db, true);
    // Simulate a prior tick that downloaded 1.2.4 but couldn't restart.
    db.prepare("INSERT INTO app_settings (key, value, value_type) VALUES (?, '1.2.4', 'string')").run(
      SETTING_UPDATE_DOWNLOADED_VERSION,
    );
    const { deps, calls } = fakeDeps({ fetchLatest: async () => "1.2.4" });
    await checkForUpdates(db, deps);
    expect(calls.update).toBe(0);
    expect(calls.restart).toBe(1);
  });

  it("is a no-op in a dev checkout", async () => {
    setAutoUpdateEnabled(db, true);
    const { deps, calls } = fakeDeps({ currentVersion: "dev", fetchLatest: async () => "1.2.4" });
    await checkForUpdates(db, deps);
    expect(calls.update).toBe(0);
    expect(calls.restart).toBe(0);
    expect(getStringSetting(db, SETTING_UPDATE_AVAILABLE_VERSION, "")).toBe("");
  });

  it("notifies but never applies when the binary is not compiled", async () => {
    setAutoUpdateEnabled(db, true);
    const { deps, calls } = fakeDeps({ isCompiled: false, fetchLatest: async () => "1.2.4" });
    await checkForUpdates(db, deps);
    expect(getStringSetting(db, SETTING_UPDATE_AVAILABLE_VERSION, "")).toBe("1.2.4");
    expect(calls.update).toBe(0);
    expect(calls.restart).toBe(0);
  });

  it("downloads but does not restart while a task is queued (approved)", async () => {
    setAutoUpdateEnabled(db, true);
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('q1', 'Queued', 'approved')").run();
    // Real DB-backed idle check (the default): the approved task blocks restart.
    const calls = { update: 0, restart: 0 };
    await checkForUpdates(db, {
      currentVersion: "1.2.3",
      isCompiled: true,
      fetchLatest: async () => "1.2.4",
      runUpdate: async () => { calls.update++; return true; },
      runRestart: () => { calls.restart++; },
    });
    expect(calls.update).toBe(1);
    expect(calls.restart).toBe(0);
    expect(getStringSetting(db, SETTING_UPDATE_DOWNLOADED_VERSION, "")).toBe("1.2.4");
  });
});

const idleAgents = { getRunningAgents: () => ({ size: 0 }) };
const busyAgents = { getRunningAgents: () => ({ size: 1 }) };

describe("isSystemFullyIdle", () => {
  it("is true only when no agents run and no task is active or queued", () => {
    expect(isSystemFullyIdle(db, idleAgents)).toBe(true);

    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('a1', 'A', 'approved')").run();
    expect(isSystemFullyIdle(db, idleAgents)).toBe(false);
  });

  it("is false when an agent process is live even with no queued tasks", () => {
    expect(isSystemFullyIdle(db, busyAgents)).toBe(false);
  });

  it("ignores completed/failed/draft tasks", () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('c1', 'C', 'completed')").run();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('f1', 'F', 'failed')").run();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('d1', 'D', 'draft')").run();
    expect(isSystemFullyIdle(db, idleAgents)).toBe(true);
  });
});

describe("restartIfUpdatePending", () => {
  const pendingDeps = (over: Partial<UpdaterDeps> = {}) => {
    const calls = { restart: 0 };
    return {
      deps: { isCompiled: true, isSystemIdle: () => true, runRestart: () => { calls.restart++; }, ...over },
      calls,
    };
  };

  it("does nothing when no update is downloaded", () => {
    setAutoUpdateEnabled(db, true);
    const { deps, calls } = pendingDeps();
    expect(restartIfUpdatePending(db, deps)).toBe(false);
    expect(calls.restart).toBe(0);
  });

  it("restarts when a download is pending + enabled + idle", () => {
    setAutoUpdateEnabled(db, true);
    setStringSetting(db, SETTING_UPDATE_DOWNLOADED_VERSION, "1.2.4");
    const { deps, calls } = pendingDeps();
    expect(restartIfUpdatePending(db, deps)).toBe(true);
    expect(calls.restart).toBe(1);
  });

  it("does not restart while not idle", () => {
    setAutoUpdateEnabled(db, true);
    setStringSetting(db, SETTING_UPDATE_DOWNLOADED_VERSION, "1.2.4");
    const { deps, calls } = pendingDeps({ isSystemIdle: () => false });
    expect(restartIfUpdatePending(db, deps)).toBe(false);
    expect(calls.restart).toBe(0);
  });

  it("restarts at most once per process", () => {
    setAutoUpdateEnabled(db, true);
    setStringSetting(db, SETTING_UPDATE_DOWNLOADED_VERSION, "1.2.4");
    const { deps, calls } = pendingDeps();
    expect(restartIfUpdatePending(db, deps)).toBe(true);
    expect(restartIfUpdatePending(db, deps)).toBe(false); // guard blocks the second
    expect(calls.restart).toBe(1);
  });
});
