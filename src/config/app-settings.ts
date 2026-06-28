import type { Database } from "bun:sqlite";

export const SETTING_PARALLEL_TASKS = "parallel_task_execution";
export const SETTING_LOG_RETENTION_HOURS = "log_retention_hours";
export const SETTING_ZEN_MODE = "zen_mode_view";

export const SETTING_SKIPPER_CONNECT_ENABLED = "skipper_connect_enabled";
export const SETTING_SKIPPER_CONNECT_GUID = "skipper_connect_global_id_guid";
export const SETTING_SKIPPER_CONNECT_KEY = "skipper_connect_key";
export const SETTING_SKIPPER_CONNECT_URL = "skipper_connect_url";

type SettingType = "boolean" | "number" | "string" | "json";

interface SettingRow {
  value: string;
  value_type: string;
}

export function getSetting(db: Database, key: string): { value: string; type: string } | null {
  const row = db
    .prepare("SELECT value, value_type FROM app_settings WHERE key = ?")
    .get(key) as SettingRow | null;
  return row ? { value: row.value, type: row.value_type } : null;
}

export function setSetting(db: Database, key: string, value: string, type: SettingType): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, value_type, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, value_type = excluded.value_type, updated_at = datetime('now')`,
  ).run(key, value, type);
}

export function getBoolSetting(db: Database, key: string, defaultValue: boolean): boolean {
  const row = getSetting(db, key);
  if (!row) return defaultValue;
  return row.value === "1" || row.value === "true";
}

export function setBoolSetting(db: Database, key: string, value: boolean): void {
  setSetting(db, key, value ? "1" : "0", "boolean");
}

export function getNumberSetting(db: Database, key: string, defaultValue: number): number {
  const row = getSetting(db, key);
  if (!row) return defaultValue;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : defaultValue;
}

export function setNumberSetting(db: Database, key: string, value: number): void {
  setSetting(db, key, String(value), "number");
}

export function getStringSetting(db: Database, key: string, defaultValue = ""): string {
  const row = getSetting(db, key);
  return row ? row.value : defaultValue;
}

export function setStringSetting(db: Database, key: string, value: string): void {
  setSetting(db, key, value, "string");
}
