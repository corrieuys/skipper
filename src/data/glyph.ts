import type { Database } from "bun:sqlite";
import { fetchTaskById } from "./queries";

/**
 * Read queries for the glyph renderer agent (src/glyph). The agent is fed
 * curated registers only (notes, operator messages, artifacts, escalations),
 * never raw terminal output, and only what landed since its last wake. Every
 * cursor is a rowid: insert-ordered, monotonic, independent of the mixed
 * second/millisecond `created_at` precisions across these tables.
 */

export interface GlyphCursor {
  notes: number;
  messages: number;
  artifacts: number;
  escalations: number;
  /** `resolved_at` of the newest resolution already reported (ISO-ish string). */
  resolvedAt: string;
  /** realtime_timeline rowid: operator input (typed text, transcripts, transcript summaries). */
  inputs: number;
}

export const EMPTY_GLYPH_CURSOR: GlyphCursor = { notes: 0, messages: 0, artifacts: 0, escalations: 0, resolvedAt: "", inputs: 0 };

export interface GlyphTaskSummary {
  id: string;
  title: string;
  description: string;
  /** Absolute directory the agents work in ("" when none); files under it may be shown in a web view. */
  working_directory: string;
  status: string;
  display_status: string;
  mode: string;
  current_phase: number;
  phases: string[];
  needs_review: boolean;
  open_escalations: number;
}

export interface GlyphNoteRow { rowid: number; id: string; agent: string; content: string; created_at: string }
export interface GlyphMessageRow { rowid: number; id: string; agent: string; content: string; created_at: string }
export interface GlyphArtifactRow {
  rowid: number;
  id: string;
  name: string;
  version: number;
  kind: string;
  description: string | null;
  /** Text artifacts only; null for file artifacts. */
  body: string | null;
  storage: string;
  mime: string | null;
  format: string | null;
  width: number | null;
  height: number | null;
  agent: string;
  created_at: string;
}
/** Operator input from the task timeline: what the human typed or said (or a summary of a spoken window). */
export interface GlyphInputRow { rowid: number; id: string; entry_type: "text" | "transcript" | "summary"; content: string; created_at: string }
export interface GlyphEscalationRow {
  rowid: number;
  id: string;
  agent: string;
  type: string;
  severity: string;
  question: string;
  response: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

export interface GlyphDelta {
  task: GlyphTaskSummary;
  notes: GlyphNoteRow[];
  messages: GlyphMessageRow[];
  artifacts: GlyphArtifactRow[];
  /** Escalations raised since the cursor (any status). */
  newEscalations: GlyphEscalationRow[];
  /** Escalations resolved since the cursor that were raised before it. */
  resolvedEscalations: GlyphEscalationRow[];
  /** Every escalation still open, so the agent can keep them on screen. */
  openEscalations: GlyphEscalationRow[];
  /** Operator input since the cursor (typed, spoken, or spoken-and-summarised). */
  inputs: GlyphInputRow[];
  next: GlyphCursor;
}

export function fetchGlyphTaskSummary(db: Database, taskId: string): GlyphTaskSummary | null {
  const task = fetchTaskById(db, taskId);
  if (!task) return null;
  const open = (db.prepare("SELECT COUNT(*) AS c FROM escalations WHERE task_id = ? AND status = 'open'").get(taskId) as { c: number }).c;
  const wd = (db.prepare("SELECT working_directory FROM tasks WHERE id = ?").get(taskId) as { working_directory: string | null } | null)?.working_directory ?? "";
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? "",
    working_directory: wd,
    status: task.status,
    display_status: task.display_status ?? task.status,
    mode: task.mode ?? "workflow",
    current_phase: task.current_phase,
    phases: (task.phases ?? []).map((p) => p.name),
    needs_review: !!task.needs_review,
    open_escalations: open,
  };
}

/** Everything that landed on the task after `cursor`. Returns null for an unknown task. */
export function fetchGlyphDelta(db: Database, taskId: string, cursor: GlyphCursor): GlyphDelta | null {
  const task = fetchGlyphTaskSummary(db, taskId);
  if (!task) return null;

  const notes = db.prepare(
    `SELECT n.rowid AS rowid, n.id, COALESCE(a.name, n.agent_id) AS agent, n.content, n.created_at
     FROM task_notes n LEFT JOIN agents a ON a.id = n.agent_id
     WHERE n.task_id = ? AND n.rowid > ? AND n.deleted_at IS NULL
     ORDER BY n.rowid`,
  ).all(taskId, cursor.notes) as GlyphNoteRow[];

  const messages = db.prepare(
    `SELECT m.rowid AS rowid, m.id, COALESCE(a.name, m.agent_id) AS agent, m.content, m.created_at
     FROM task_messages m LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.task_id = ? AND m.rowid > ?
     ORDER BY m.rowid`,
  ).all(taskId, cursor.messages) as GlyphMessageRow[];

  const artifacts = db.prepare(
    `SELECT t.rowid AS rowid, t.id, t.name, t.version, t.kind, t.description,
            CASE WHEN t.storage = 'file' THEN NULL ELSE t.body END AS body,
            t.storage, t.mime, t.format, t.width, t.height,
            COALESCE(a.name, t.created_by_agent_id, t.source, 'operator') AS agent, t.created_at
     FROM task_artifacts t LEFT JOIN agents a ON a.id = t.created_by_agent_id
     WHERE t.task_id = ? AND t.rowid > ? AND t.deleted_at IS NULL
     ORDER BY t.rowid`,
  ).all(taskId, cursor.artifacts) as GlyphArtifactRow[];

  const inputs = db.prepare(
    `SELECT rowid AS rowid, id, entry_type, content, created_at
     FROM realtime_timeline
     WHERE task_id = ? AND rowid > ? AND entry_type IN ('text', 'transcript', 'summary')
     ORDER BY rowid`,
  ).all(taskId, cursor.inputs) as GlyphInputRow[];

  const escalationSelect = `SELECT e.rowid AS rowid, e.id, COALESCE(a.name, e.agent_id) AS agent, e.type, e.severity,
            e.question, e.response, e.status, e.created_at, e.resolved_at
     FROM escalations e LEFT JOIN agents a ON a.id = e.agent_id`;

  const newEscalations = db.prepare(
    `${escalationSelect} WHERE e.task_id = ? AND e.rowid > ? ORDER BY e.rowid`,
  ).all(taskId, cursor.escalations) as GlyphEscalationRow[];

  const resolvedEscalations = db.prepare(
    `${escalationSelect}
     WHERE e.task_id = ? AND e.rowid <= ? AND e.status = 'resolved' AND e.resolved_at IS NOT NULL AND e.resolved_at > ?
     ORDER BY e.resolved_at, e.rowid`,
  ).all(taskId, cursor.escalations, cursor.resolvedAt) as GlyphEscalationRow[];

  const openEscalations = db.prepare(
    `${escalationSelect} WHERE e.task_id = ? AND e.status = 'open' ORDER BY e.rowid`,
  ).all(taskId) as GlyphEscalationRow[];

  const maxRowid = (rows: Array<{ rowid: number }>, prev: number): number =>
    rows.reduce((m, r) => Math.max(m, r.rowid), prev);
  let resolvedAt = cursor.resolvedAt;
  for (const e of [...newEscalations, ...resolvedEscalations]) {
    if (e.resolved_at && e.resolved_at > resolvedAt) resolvedAt = e.resolved_at;
  }

  return {
    task,
    notes,
    messages,
    artifacts,
    newEscalations,
    resolvedEscalations,
    openEscalations,
    inputs,
    next: {
      notes: maxRowid(notes, cursor.notes),
      messages: maxRowid(messages, cursor.messages),
      artifacts: maxRowid(artifacts, cursor.artifacts),
      escalations: maxRowid(newEscalations, cursor.escalations),
      resolvedAt,
      inputs: maxRowid(inputs, cursor.inputs),
    },
  };
}
