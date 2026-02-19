import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";

export interface RealtimeConfig {
  transcription_provider: "local" | "openai";
  transcription_endpoint: string;
  openai_transcription_model: string;
  summarization_model: string;
  summary_max_tokens: number;
  cadence_seconds: number;
  overlap_seconds: number;
}

const DEFAULTS: RealtimeConfig = {
  transcription_provider: "local",
  transcription_endpoint: "",
  openai_transcription_model: "gpt-4o-transcribe",
  summarization_model: "claude-sonnet-4-6",
  summary_max_tokens: 500,
  cadence_seconds: 60,
  overlap_seconds: 5,
};

export function getRealtimeConfig(db?: Database): RealtimeConfig {
  const database = db ?? getDb();
  const rows = database
    .prepare("SELECT key, value FROM realtime_config")
    .all() as { key: string; value: string }[];
  const config = { ...DEFAULTS };
  for (const row of rows) {
    switch (row.key) {
      case "transcription_provider":
        if (row.value === "local" || row.value === "openai") {
          config.transcription_provider = row.value;
        }
        break;
      case "transcription_endpoint":
        config.transcription_endpoint = row.value;
        break;
      case "openai_transcription_model":
        config.openai_transcription_model = row.value || DEFAULTS.openai_transcription_model;
        break;
      case "summarization_model":
        config.summarization_model = row.value;
        break;
      case "summary_max_tokens":
        config.summary_max_tokens =
          parseInt(row.value, 10) || DEFAULTS.summary_max_tokens;
        break;
      case "cadence_seconds":
        config.cadence_seconds =
          parseInt(row.value, 10) || DEFAULTS.cadence_seconds;
        break;
      case "overlap_seconds": {
        const val = parseInt(row.value, 10);
        config.overlap_seconds = isNaN(val) ? DEFAULTS.overlap_seconds : Math.max(0, val);
        break;
      }
    }
  }
  return config;
}

export function updateRealtimeConfig(
  updates: Partial<RealtimeConfig>,
  db?: Database,
): RealtimeConfig {
  const database = db ?? getDb();
  for (const [key, value] of Object.entries(updates)) {
    const serialized = Array.isArray(value) ? JSON.stringify(value) : String(value);
    database
      .prepare(
        "INSERT INTO realtime_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
      )
      .run(key, serialized, serialized);
  }
  return getRealtimeConfig(database);
}
