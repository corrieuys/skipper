import type { Database } from "bun:sqlite";
import { fetchEscalations, fetchTaskById, fetchTasksWithTeams } from "../data/queries";
import type { EscalationData, TaskData } from "../html/components";
import type { ArtifactItem, EscalationItem, NoteItem, TaskListItem } from "./protocol";
import { getPublicArtifactUrl } from "./public-links";

/**
 * Projections shared by fat connect events (events.ts) and the state snapshot
 * (resources.ts). Deliberately small: the integrator web app patches a local
 * store from these, so heavy fields (result, orchestration_state, description,
 * artifact bodies) never cross the wire on the push path.
 */

function projectTask(row: TaskData, phaseCount: number | null): TaskListItem {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    task_type: row.task_type ?? "standard",
    team_id: row.team_id ?? null,
    team_name: row.team_name ?? null,
    current_phase: row.current_phase,
    phase_count: phaseCount,
    needs_review: !!row.needs_review,
    created_at: row.created_at,
    updated_at: (row as unknown as { updated_at?: string | null }).updated_at ?? null,
  };
}

export function toTaskListItem(db: Database, taskId: string): TaskListItem | null {
  const task = fetchTaskById(db, taskId);
  if (!task) return null;
  return projectTask(task, task.phases?.length ?? null);
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
    projectTask(row, row.team_id ? (phaseCounts.get(row.team_id) ?? null) : null),
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

export function fetchArtifactItem(db: Database, artifactId: string): ArtifactItem | null {
  const row = db
    .prepare(
      `SELECT id, task_id, name, kind, version, description, created_at, published_at, publish_key
       FROM task_artifacts WHERE id = ?`,
    )
    .get(artifactId) as {
      id: string; task_id: string; name: string; kind: string; version: number;
      description: string | null; created_at: string; published_at: string | null; publish_key: string | null;
    } | null;
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    name: row.name,
    kind: row.kind,
    version: row.version,
    description: row.description,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    publicUrl: row.published_at ? getPublicArtifactUrl(db, { id: row.id, publish_key: row.publish_key }) : null,
  };
}
