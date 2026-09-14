// Persistence for the per-task glyph screen (`glyph_screens`, runtime DB): the
// frame as the renderer last left it, the register cursor it had consumed and
// the model session to resume. One row per task, written after every
// successful command, so a daemon restart resumes instead of re-reading.

import type { Database } from "bun:sqlite";
import { EMPTY_GLYPH_CURSOR, type GlyphCursor } from "../data/glyph";

export interface StoredGlyphScreen {
  frame: string;
  cursor: GlyphCursor;
  sessionId: string | null;
  calls: number;
  /** JSON fingerprint of the task summary at the last wake ("" when unknown). */
  summaryFp: string;
  updatedAt: string;
}

export function loadGlyphScreen(db: Database, taskId: string): StoredGlyphScreen | null {
  const row = db.prepare(
    "SELECT frame, cursor, session_id, calls, summary_fp, updated_at FROM glyph_screens WHERE task_id = ?",
  ).get(taskId) as { frame: string; cursor: string; session_id: string | null; calls: number; summary_fp: string; updated_at: string } | null;
  if (!row) return null;
  let cursor: GlyphCursor = { ...EMPTY_GLYPH_CURSOR };
  try {
    cursor = { ...EMPTY_GLYPH_CURSOR, ...(JSON.parse(row.cursor) as Partial<GlyphCursor>) };
  } catch {
    /* unreadable cursor: start the registers from zero, the frame still stands */
  }
  return { frame: row.frame, cursor, sessionId: row.session_id, calls: row.calls, summaryFp: row.summary_fp ?? "", updatedAt: row.updated_at };
}

export function saveGlyphScreen(db: Database, taskId: string, s: { frame: string; cursor: GlyphCursor; sessionId: string | null; calls: number; summaryFp?: string }): void {
  db.prepare(
    `INSERT INTO glyph_screens (task_id, frame, cursor, session_id, calls, summary_fp, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(task_id) DO UPDATE SET frame = excluded.frame, cursor = excluded.cursor,
       session_id = excluded.session_id, calls = excluded.calls, summary_fp = excluded.summary_fp, updated_at = excluded.updated_at`,
  ).run(taskId, s.frame, JSON.stringify(s.cursor), s.sessionId, s.calls, s.summaryFp ?? "");
}

export function deleteGlyphScreen(db: Database, taskId: string): void {
  db.prepare("DELETE FROM glyph_screens WHERE task_id = ?").run(taskId);
}
