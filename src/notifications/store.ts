import type { Database } from "bun:sqlite";
import { NOTIFICATION_EVENTS, type NotificationEventKey } from "./types";

export interface NotificationPreference {
  event_key: NotificationEventKey;
  audio_enabled: boolean;
}

export function listPreferences(db: Database): NotificationPreference[] {
  const rows = db.prepare(
    "SELECT event_key, audio_enabled FROM notification_preferences"
  ).all() as Array<{ event_key: string; audio_enabled: number }>;
  const byKey = new Map(rows.map((r) => [r.event_key, r.audio_enabled === 1]));
  return NOTIFICATION_EVENTS.map((meta) => ({
    event_key: meta.key,
    audio_enabled: byKey.get(meta.key) ?? false,
  }));
}

export function setPreference(db: Database, key: NotificationEventKey, enabled: boolean): void {
  db.prepare(
    `INSERT INTO notification_preferences (event_key, audio_enabled, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(event_key) DO UPDATE SET audio_enabled = excluded.audio_enabled, updated_at = CURRENT_TIMESTAMP`
  ).run(key, enabled ? 1 : 0);
}

export function isEnabled(db: Database, key: NotificationEventKey): boolean {
  const row = db.prepare(
    "SELECT audio_enabled FROM notification_preferences WHERE event_key = ?"
  ).get(key) as { audio_enabled: number } | null;
  return row?.audio_enabled === 1;
}
