import type { Database } from "bun:sqlite";
import { fetchEscalations, fetchTaskById, fetchTasksWithTeams } from "../data/queries";
import type { EscalationData, TaskData } from "../html/components";
import { deriveDisplayStatus } from "../tasks/status";
import type { ArtifactItem, EscalationItem, MessageItem, NoteItem, TaskDetailItem, TaskListItem, TimelineArtifactRef, TimelineEntryItem } from "./protocol";
import { getPublicArtifactUrl } from "./public-links";

/**
 * Projections shared by fat connect events (events.ts) and the state snapshot
 * (resources.ts). Deliberately small: the integrator web app patches a local
 * store from these, so heavy fields (result, orchestration_state, description,
 * artifact bodies) never cross the wire on the push path.
 */

export function projectTask(db: Database, row: TaskData, phaseCount: number | null): TaskListItem {
  const r = row as unknown as {
    paused?: number | boolean | null;
    wake_requested_at?: string | null;
    started_at?: string | null;
    mode?: string | null;
  };
  const display = deriveDisplayStatus(db, {
    id: row.id,
    status: row.status,
    paused: r.paused,
    needs_review: row.needs_review ? 1 : 0,
    wake_requested_at: r.wake_requested_at ?? null,
    started_at: r.started_at ?? null,
    result: row.result ?? null,
  });
  const mode = r.mode === "conversational" ? "conversational" : "workflow";
  return {
    id: row.id,
    title: row.title,
    // Protocol v3: `status` is the raw unified status (draft | active | settled)
    // and `display_status` carries the 9-value presentation state. The legacy
    // draft/approved/running vocabulary is gone from this surface.
    status: row.status,
    display_status: display,
    mode,
    paused: !!r.paused,
    team_id: row.team_id ?? null,
    team_name: row.team_name ?? null,
    current_phase: row.current_phase,
    phase_count: phaseCount,
    needs_review: !!row.needs_review,
    created_at: row.created_at,
    updated_at: (row as unknown as { updated_at?: string | null }).updated_at ?? null,
    started_at: (row as unknown as { started_at?: string | null }).started_at ?? null,
    source_scheduled_task_id:
      (row as unknown as { source_scheduled_task_id?: string | null }).source_scheduled_task_id ?? null,
  };
}

export function toTaskListItem(db: Database, taskId: string): TaskListItem | null {
  const task = fetchTaskById(db, taskId);
  if (!task) return null;
  return projectTask(db, task, task.phases?.length ?? null);
}

/**
 * Detail projection for `tasks/read`: the list shape plus the fields a task
 * screen needs. Still a projection, not a raw row - orchestration_state and
 * task_config never cross the wire.
 */
export function toTaskDetailItem(db: Database, taskId: string): TaskDetailItem | null {
  const task = fetchTaskById(db, taskId);
  if (!task) return null;
  const r = task as unknown as {
    description?: string | null;
    working_directory?: string | null;
    run_input?: string | null;
    completed_at?: string | null;
    settled_at?: string | null;
    regression_count?: number | null;
  };
  return {
    ...projectTask(db, task, task.phases?.length ?? null),
    description: r.description ?? null,
    result: task.result ?? null,
    working_directory: r.working_directory ?? null,
    run_input: r.run_input ?? null,
    completed_at: r.completed_at ?? null,
    settled_at: r.settled_at ?? null,
    regression_count: r.regression_count ?? 0,
    phases: task.phases ?? null,
  };
}

/** All tasks projected, with team phase counts resolved in one extra query. */
export function snapshotTasks(db: Database): TaskListItem[] {
  const phaseCounts = new Map<string, number>();
  const teamRows = db.prepare("SELECT id, phases FROM teams").all() as { id: string; phases: string | null }[];
  for (const t of teamRows) {
    try {
      const phases = t.phases ? (JSON.parse(t.phases) as unknown[]) : [];
      phaseCounts.set(t.id, Array.isArray(phases) ? phases.length : 0);
    } catch {
      // unparsable phases → unknown count
    }
  }
  return fetchTasksWithTeams(db).map((row) =>
    projectTask(db, row, row.team_id ? (phaseCounts.get(row.team_id) ?? null) : null),
  );
}

export function toEscalationItem(row: EscalationData & { agent_name?: string | null }): EscalationItem {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    agentName: row.agent_name ?? null,
    type: row.type,
    status: row.status,
    question: row.question,
    response: row.response,
    createdAt: row.created_at,
  };
}

export function fetchEscalationItem(db: Database, escalationId: string): EscalationItem | null {
  const row = db
    .prepare(
      `SELECT e.*, a.name AS agent_name
       FROM escalations e
       LEFT JOIN agents a ON a.id = e.agent_id
       WHERE e.id = ?`,
    )
    .get(escalationId) as (EscalationData & { agent_name: string | null }) | null;
  return row ? toEscalationItem(row) : null;
}

export function snapshotOpenEscalations(db: Database): EscalationItem[] {
  return fetchEscalations(db, "open").map((row) => toEscalationItem(row));
}

export function fetchNoteItem(db: Database, noteId: string): NoteItem | null {
  const row = db
    .prepare(
      `SELECT n.id, n.task_id, n.content, n.created_at, a.name AS agent_name
       FROM task_notes n
       LEFT JOIN agents a ON a.id = n.agent_id
       WHERE n.id = ?`,
    )
    .get(noteId) as { id: string; task_id: string; content: string; created_at: string; agent_name: string | null } | null;
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    agentName: row.agent_name ?? null,
    content: row.content,
    createdAt: row.created_at,
  };
}

export function fetchMessageItem(db: Database, messageId: string): MessageItem | null {
  const row = db
    .prepare(
      `SELECT m.id, m.task_id, m.content, m.format, m.created_at, a.name AS agent_name
       FROM task_messages m
       LEFT JOIN agents a ON a.id = m.agent_id
       WHERE m.id = ?`,
    )
    .get(messageId) as { id: string; task_id: string; content: string; format: string | null; created_at: string; agent_name: string | null } | null;
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    agentName: row.agent_name ?? null,
    content: row.content,
    format: row.format ?? null,
    createdAt: row.created_at,
  };
}

/** Raw `realtime_timeline` row shape read by the projections below (LEFT JOINed to its file artifact). */
interface TimelineRow {
  id: string;
  task_id: string;
  entry_type: string;
  content: string;
  fed_to_skipper: number;
  created_at: string;
  artifact_id: string | null;
  a_name: string | null;
  a_version: number | null;
  a_kind: string | null;
  a_storage: string | null;
  a_mime: string | null;
  a_bytes: number | null;
  a_width: number | null;
  a_height: number | null;
  a_sha256: string | null;
  a_source: string | null;
  a_agent_name: string | null;
}

const TIMELINE_SELECT = `SELECT t.id, t.task_id, t.entry_type, t.content, t.fed_to_skipper, t.created_at, t.artifact_id,
         a.name AS a_name, a.version AS a_version, a.kind AS a_kind, a.storage AS a_storage, a.mime AS a_mime,
         a.bytes AS a_bytes, a.width AS a_width, a.height AS a_height, a.sha256 AS a_sha256, a.source AS a_source,
         ag.name AS a_agent_name
       FROM realtime_timeline t
       LEFT JOIN task_artifacts a ON a.id = t.artifact_id
       LEFT JOIN agents ag ON ag.id = a.source`;

/** Operator-side sources of a file artifact (web upload, connect upload); anything else is an agent id. */
function isOperatorArtifactSource(source: string | null): boolean {
  return !source || source === "operator" || source === "user" || source === "web" || source.startsWith("connect:");
}

function toTimelineEntryItem(row: TimelineRow): TimelineEntryItem {
  const item: TimelineEntryItem = {
    id: row.id,
    taskId: row.task_id,
    entryType: row.entry_type,
    content: row.content,
    fedToSkipper: !!row.fed_to_skipper,
    createdAt: row.created_at,
  };
  if (row.artifact_id && row.a_name != null) {
    const artifact: TimelineArtifactRef = {
      id: row.artifact_id,
      name: row.a_name,
      version: row.a_version ?? 1,
      kind: row.a_kind ?? "upload",
      storage: row.a_storage ?? "file",
      mime: row.a_mime,
      bytes: row.a_bytes,
      width: row.a_width,
      height: row.a_height,
      sha256: row.a_sha256,
      source: row.a_source ?? "operator",
      authorName: isOperatorArtifactSource(row.a_source) ? null : (row.a_agent_name ?? row.a_source),
    };
    item.artifact = artifact;
  }
  return item;
}

/** One operator-input entry by id, for the `realtime:timeline_updated` fat event. */
export function fetchTimelineEntryItem(db: Database, entryId: string): TimelineEntryItem | null {
  const row = db
    .prepare(`${TIMELINE_SELECT} WHERE t.id = ?`)
    .get(entryId) as TimelineRow | null;
  return row ? toTimelineEntryItem(row) : null;
}

/**
 * A task's operator-input entries, oldest first, for `timeline/list`. The web
 * UI's timeline fragment reads the same rows, so remote clients render the same
 * operator side of the conversation.
 */
export function snapshotTimelineEntries(db: Database, taskId: string, limit = 200, before?: string): TimelineEntryItem[] {
  const capped = Math.max(1, Math.min(1000, Math.floor(limit) || 200));
  // Take the newest `limit` rows (older than `before` when paging), then flip
  // to oldest-first so a truncated window keeps the most recent input rather
  // than the oldest.
  const rows = (before
    ? db.prepare(
        `${TIMELINE_SELECT}
         WHERE t.task_id = ? AND t.created_at < ?
         ORDER BY t.created_at DESC, t.rowid DESC
         LIMIT ?`,
      ).all(taskId, before, capped)
    : db.prepare(
        `${TIMELINE_SELECT}
         WHERE t.task_id = ?
         ORDER BY t.created_at DESC, t.rowid DESC
         LIMIT ?`,
      ).all(taskId, capped)) as TimelineRow[];
  return rows.reverse().map(toTimelineEntryItem);
}

export function fetchArtifactItem(db: Database, artifactId: string): ArtifactItem | null {
  const row = db
    .prepare(
      `SELECT id, task_id, name, kind, version, description, format, created_at, published_at, publish_key,
              storage, mime, bytes, width, height, sha256, source
       FROM task_artifacts WHERE id = ?`,
    )
    .get(artifactId) as {
      id: string; task_id: string; name: string; kind: string; version: number;
      description: string | null; format: string | null; created_at: string; published_at: string | null; publish_key: string | null;
      storage: string; mime: string | null; bytes: number | null; width: number | null; height: number | null; sha256: string | null;
      source: string | null;
    } | null;
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    name: row.name,
    kind: row.kind,
    version: row.version,
    description: row.description,
    format: row.format ?? null,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    publicUrl: row.published_at ? getPublicArtifactUrl(db, { id: row.id, publish_key: row.publish_key }) : null,
    storage: row.storage ?? "inline",
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    source: row.source ?? null,
  };
}
