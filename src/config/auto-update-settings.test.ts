import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { getStringSetting, setStringSetting } from "./app-settings";
import {
  isAutoUpdateEnabled,
  setAutoUpdateEnabled,
  getUpdateNoticeView,
  dismissAvailableNotice,
  clearAppliedNotice,
  recordBootVersion,
  SETTING_UPDATE_AVAILABLE_VERSION,
  SETTING_UPDATE_APPLIED_NOTICE,
  SETTING_UPDATE_DOWNLOADED_VERSION,
  SETTING_LAST_RUN_VERSION,
} from "./auto-update-settings";
import { renderUpdateNotice } from "../html/fragments/update-toast";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
});

afterEach(() => db.close());

describe("auto-update toggle", () => {
  it("defaults off and round-trips", () => {
    expect(isAutoUpdateEnabled(db)).toBe(false);
    setAutoUpdateEnabled(db, true);
    expect(isAutoUpdateEnabled(db)).toBe(true);
  });
});

describe("getUpdateNoticeView + dismiss", () => {
  it("surfaces an available version until it is dismissed", () => {
    setStringSetting(db, SETTING_UPDATE_AVAILABLE_VERSION, "9.9.9");
    expect(getUpdateNoticeView(db).availableVersion).toBe("9.9.9");

    dismissAvailableNotice(db, "9.9.9");
    expect(getUpdateNoticeView(db).availableVersion).toBeNull();
  });

  it("re-surfaces when a newer version supersedes the dismissed one", () => {
    setStringSetting(db, SETTING_UPDATE_AVAILABLE_VERSION, "9.9.9");
    dismissAvailableNotice(db, "9.9.9");
    // A later check records an even newer release.
    setStringSetting(db, SETTING_UPDATE_AVAILABLE_VERSION, "9.9.10");
    expect(getUpdateNoticeView(db).availableVersion).toBe("9.9.10");
  });

  it("reports a downloaded release as staged", () => {
    setStringSetting(db, SETTING_UPDATE_AVAILABLE_VERSION, "9.9.9");
    expect(getUpdateNoticeView(db).delivery).toBe("manual");

    setStringSetting(db, SETTING_UPDATE_DOWNLOADED_VERSION, "9.9.9");
    expect(getUpdateNoticeView(db).delivery).toBe("staged");
  });

  it("stays manual when auto-update is on but this is not a self-updatable binary", () => {
    // bun test runs from a checkout, so isCompiledBinary() is false — the same
    // gate the updater applies before it will download anything.
    setAutoUpdateEnabled(db, true);
    setStringSetting(db, SETTING_UPDATE_AVAILABLE_VERSION, "9.9.9");
    expect(getUpdateNoticeView(db).delivery).toBe("manual");
  });

  it("surfaces and clears the app-updated notice", () => {
    setStringSetting(db, SETTING_UPDATE_APPLIED_NOTICE, "9.9.9");
    expect(getUpdateNoticeView(db).appUpdatedTo).toBe("9.9.9");
    clearAppliedNotice(db);
    expect(getUpdateNoticeView(db).appUpdatedTo).toBeNull();
  });
});

describe("recordBootVersion", () => {
  it("records the running version as last-run", () => {
    recordBootVersion(db);
    // APP_VERSION is "dev" under bun test.
    expect(getStringSetting(db, SETTING_LAST_RUN_VERSION, "")).toBe("dev");
    // No upgrade detected from a clean slate.
    expect(getStringSetting(db, SETTING_UPDATE_APPLIED_NOTICE, "")).toBe("");
  });
});

describe("renderUpdateNotice", () => {
  it("renders both toasts with dismiss affordances", () => {
    const html = renderUpdateNotice({ availableVersion: "9.9.9", delivery: "manual", appUpdatedTo: "9.9.8" });
    expect(html).toContain('data-kind="available"');
    expect(html).toContain('data-version="9.9.9"');
    expect(html).toContain("skipper update");
    expect(html).toContain("skipper restart");
    expect(html).toContain('data-kind="applied"');
    expect(html).toContain("was updated to v9.9.8");
    expect(html).toContain("data-sk-toast-close");
  });

  it("says the update is staged instead of asking for a manual upgrade", () => {
    const html = renderUpdateNotice({ availableVersion: "9.9.9", delivery: "staged", appUpdatedTo: null });
    expect(html).toContain("Update ready");
    expect(html).toContain("downloaded and will be applied automatically");
    expect(html).not.toContain("skipper update");
  });

  it("says auto-update will handle a release it has not downloaded yet", () => {
    const html = renderUpdateNotice({ availableVersion: "9.9.9", delivery: "pending", appUpdatedTo: null });
    expect(html).toContain("Auto-update will install it");
    expect(html).not.toContain("skipper restart");
  });

  it("renders nothing when nothing is pending", () => {
    expect(renderUpdateNotice({ availableVersion: null, delivery: "manual", appUpdatedTo: null })).toBe("");
  });
});
