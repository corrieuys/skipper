import type { Database } from "bun:sqlite";
import { getBoolSetting, setBoolSetting, getStringSetting, setStringSetting } from "./app-settings";
import { APP_VERSION, compareSemver, classifyBump } from "../version";
import { isCompiledBinary } from "../assets";

// Machine-scoped auto-update state, persisted in runtime `app_settings`
// (skipper-runtime.db), NOT the committed config tables. See src/config/CLAUDE.md.

// User toggle: apply patch updates automatically (default OFF).
export const SETTING_AUTO_UPDATE_ENABLED = "auto_update_enabled";
// Highest release seen by the hourly check that is > the running version ("" = none).
export const SETTING_UPDATE_AVAILABLE_VERSION = "update_available_version";
// Version the user closed the "update available" toast for (dedupe the notice).
export const SETTING_UPDATE_NOTICE_DISMISSED_VERSION = "update_notice_dismissed_version";
// Version the process last booted as — used to detect "we were updated" on boot.
export const SETTING_LAST_RUN_VERSION = "last_run_version";
// Pending "app was updated to X" toast ("" = none).
export const SETTING_UPDATE_APPLIED_NOTICE = "update_applied_notice";
// Version already written to disk by a prior auto `skipper update`, awaiting a
// restart — guards against re-downloading the same release every hour.
export const SETTING_UPDATE_DOWNLOADED_VERSION = "update_downloaded_version";

export function isAutoUpdateEnabled(db: Database): boolean {
  return getBoolSetting(db, SETTING_AUTO_UPDATE_ENABLED, false);
}

export function setAutoUpdateEnabled(db: Database, value: boolean): void {
  setBoolSetting(db, SETTING_AUTO_UPDATE_ENABLED, value);
}

/**
 * How the available release will reach this machine.
 * - `staged`: already downloaded by an auto `skipper update`, waiting only for the
 *   system to go idle so the daemon can restart onto it.
 * - `pending`: auto-update will pick it up on its own (enabled, self-updatable
 *   binary, patch bump) but has not downloaded it yet.
 * - `manual`: nothing automatic will happen — the user has to run the CLI.
 */
export type UpdateDelivery = "staged" | "pending" | "manual";

export interface UpdateNoticeView {
  /** A newer release the user hasn't dismissed, or null. */
  availableVersion: string | null;
  /** How `availableVersion` will be applied — drives the toast wording. */
  delivery: UpdateDelivery;
  /** A pending "app was updated to X" notice, or null. */
  appUpdatedTo: string | null;
}

/**
 * Compute what the toast fragment should show. `availableVersion` is only
 * returned when a recorded release is actually newer than the running version
 * and hasn't been dismissed, so a stale record (e.g. after the user upgraded)
 * never re-surfaces.
 */
export function getUpdateNoticeView(db: Database): UpdateNoticeView {
  const available = getStringSetting(db, SETTING_UPDATE_AVAILABLE_VERSION, "");
  const dismissed = getStringSetting(db, SETTING_UPDATE_NOTICE_DISMISSED_VERSION, "");
  // A dev build has no comparable version, so any recorded release counts as
  // newer (also lets a dev server surface a manually-seeded notice for testing).
  const newer = APP_VERSION === "dev" ? !!available : compareSemver(available, APP_VERSION) > 0;
  const showAvailable = !!available && available !== dismissed && newer;

  const applied = getStringSetting(db, SETTING_UPDATE_APPLIED_NOTICE, "");

  return {
    availableVersion: showAvailable ? available : null,
    delivery: showAvailable ? updateDelivery(db, available) : "manual",
    appUpdatedTo: applied || null,
  };
}

/**
 * Mirror of the gates in `updater/auto-updater.ts:checkForUpdates` — the toast has
 * to promise exactly what the updater will actually do, so the conditions are the
 * same ones: opted in, a self-updatable binary, and a patch bump.
 */
function updateDelivery(db: Database, available: string): UpdateDelivery {
  if (getStringSetting(db, SETTING_UPDATE_DOWNLOADED_VERSION, "") === available) return "staged";
  if (!isAutoUpdateEnabled(db) || !isCompiledBinary()) return "manual";
  return classifyBump(APP_VERSION, available) === "patch" ? "pending" : "manual";
}

/** Mark the "update available" notice for `version` as dismissed. */
export function dismissAvailableNotice(db: Database, version: string): void {
  setStringSetting(db, SETTING_UPDATE_NOTICE_DISMISSED_VERSION, version);
}

/** Clear the pending "app was updated" notice (user closed it). */
export function clearAppliedNotice(db: Database): void {
  setStringSetting(db, SETTING_UPDATE_APPLIED_NOTICE, "");
}

/**
 * On daemon boot: reconcile the recorded version against the running one.
 * - If we booted onto a higher version than last time, queue the "updated" toast.
 * - If this boot is the restart that picked up an auto-downloaded release, clear
 *   the download/available markers.
 * Always records the current version as the last-run version.
 * No-op in a dev checkout (APP_VERSION === "dev" isn't comparable).
 */
export function recordBootVersion(db: Database): void {
  const current = APP_VERSION;
  if (current === "dev") {
    setStringSetting(db, SETTING_LAST_RUN_VERSION, current);
    return;
  }

  const last = getStringSetting(db, SETTING_LAST_RUN_VERSION, "");
  if (last && compareSemver(current, last) > 0) {
    setStringSetting(db, SETTING_UPDATE_APPLIED_NOTICE, current);
  }

  const downloaded = getStringSetting(db, SETTING_UPDATE_DOWNLOADED_VERSION, "");
  if (downloaded && compareSemver(current, downloaded) >= 0) {
    // The restart landed on (or past) the downloaded release — clear the markers
    // so we don't keep offering an update we've already applied.
    setStringSetting(db, SETTING_UPDATE_DOWNLOADED_VERSION, "");
    const available = getStringSetting(db, SETTING_UPDATE_AVAILABLE_VERSION, "");
    if (available && compareSemver(available, current) <= 0) {
      setStringSetting(db, SETTING_UPDATE_AVAILABLE_VERSION, "");
    }
  }

  setStringSetting(db, SETTING_LAST_RUN_VERSION, current);
}
