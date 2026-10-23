import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { getStringSetting, setStringSetting, SETTING_SKIPPER_CONNECT_KEY } from "../config/app-settings";

/**
 * The Skipper Connect instance key. It is the instance's identity on the
 * integrator (whoever holds it can connect as this instance), so it is kept
 * out of the runtime DB: a 0600 file beside the on-disk DB
 * (`<runtime db>.connect-key`). DB copies, backups and dumps therefore never
 * carry it, and a daemon started on a copied DB has no key until one is
 * pasted. An in-memory DB (tests) has no file and keeps the legacy
 * `app_settings` row.
 *
 * A key still in `app_settings` (saved before this store existed) moves to the
 * file on first read; the row is deleted with `secure_delete` on so its bytes
 * are zeroed in the DB file.
 */

const cache = new Map<string, string>();

export function connectKeyFilePath(db: Database): string | null {
  const file = db.filename;
  if (!file || file === ":memory:") return null;
  return `${file}.connect-key`;
}

export function getConnectKey(db: Database): string {
  const path = connectKeyFilePath(db);
  if (!path) return getStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, "");
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  if (existsSync(path)) {
    const key = readFileSync(path, "utf8").trim();
    cache.set(path, key);
    return key;
  }
  const legacy = getStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, "");
  if (legacy) {
    writeKeyFile(path, legacy);
    deleteLegacyRow(db);
  }
  cache.set(path, legacy);
  return legacy;
}

export function setConnectKey(db: Database, key: string): void {
  const path = connectKeyFilePath(db);
  if (!path) {
    setStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, key);
    return;
  }
  writeKeyFile(path, key);
  cache.set(path, key);
  deleteLegacyRow(db);
}

export function hasConnectKey(db: Database): boolean {
  return getConnectKey(db) !== "";
}

/** Test hook: forget cached keys (and remove a file-backed key). */
export function clearConnectKey(db: Database): void {
  const path = connectKeyFilePath(db);
  if (!path) {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(SETTING_SKIPPER_CONNECT_KEY);
    return;
  }
  cache.delete(path);
  try {
    unlinkSync(path);
  } catch {
    /* not there */
  }
  deleteLegacyRow(db);
}

function writeKeyFile(path: string, key: string): void {
  writeFileSync(path, key, { mode: 0o600 });
  try {
    // writeFileSync's mode only applies when it creates the file.
    chmodSync(path, 0o600);
  } catch {
    /* windows */
  }
}

function deleteLegacyRow(db: Database): void {
  const row = db.prepare("SELECT 1 FROM app_settings WHERE key = ?").get(SETTING_SKIPPER_CONNECT_KEY);
  if (!row) return;
  db.exec("PRAGMA secure_delete = ON");
  try {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(SETTING_SKIPPER_CONNECT_KEY);
  } finally {
    db.exec("PRAGMA secure_delete = OFF");
  }
}
