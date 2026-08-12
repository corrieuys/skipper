// Read queries for realtime-task views. One definition per query — these were
// previously copy-pasted across src/routes/realtime.ts, src/routes/data/
// realtime-tasks.ts and src/ws/ui-push.ts.
import type { Database } from "bun:sqlite";
import type { TimelineEntry, TaskNote, RunningAgentInstance, PipelineStatus } from "../contracts/types";

export function fetchRealtimeTimeline(db: Database, taskId: string): TimelineEntry[] {
  return db.prepare(
    "SELECT * FROM realtime_timeline WHERE task_id = ? ORDER BY created_at DESC",
  ).all(taskId) as TimelineEntry[];
}

export function fetchRealtimeNotes(db: Database, taskId: string): TaskNote[] {
  return db.prepare(
    `SELECT n.id, n.agent_id, COALESCE(a.name, n.agent_id) AS agent_name, n.content, n.created_at
     FROM task_notes n
     LEFT JOIN agents a ON a.id = n.agent_id
     WHERE n.task_id = ?
     ORDER BY n.created_at DESC
     LIMIT 50`,
  ).all(taskId) as TaskNote[];
}

/** Running + recently finished (last hour) agents for a realtime task. */
export function fetchRealtimeTaskAgents(db: Database, taskId: string): RunningAgentInstance[] {
  return db.prepare(
    `SELECT ai.id, ai.template_agent_id, a.name AS agent_name, ai.status, ai.created_at
     FROM agent_instances ai
     JOIN agents a ON a.id = ai.template_agent_id
     WHERE ai.task_id = ?
       AND (ai.status IN ('running', 'pending')
            OR (ai.status IN ('completed', 'failed')
                AND ai.created_at > datetime('now', '-1 hour')))
     ORDER BY
       CASE WHEN ai.status IN ('running', 'pending') THEN 0 ELSE 1 END,
       ai.created_at DESC
     LIMIT 20`,
  ).all(taskId) as RunningAgentInstance[];
}

/** Only currently running/pending agents (legacy running-agents view). */
export function fetchRealtimeRunningAgents(db: Database, taskId: string): RunningAgentInstance[] {
  return db.prepare(
    `SELECT ai.id, ai.template_agent_id, a.name AS agent_name, ai.status, ai.created_at
     FROM agent_instances ai
     JOIN agents a ON a.id = ai.template_agent_id
     WHERE ai.task_id = ? AND ai.status IN ('running', 'pending')
     ORDER BY ai.created_at DESC`,
  ).all(taskId) as RunningAgentInstance[];
}

/**
 * Pipeline state row merged with live segment/timeline counters, or null when
 * no pipeline row exists yet.
 */
export function fetchRealtimePipelineStatus(db: Database, taskId: string): PipelineStatus | null {
  const pipelineStatus = db
    .prepare("SELECT * FROM realtime_pipeline_state WHERE task_id = ?")
    .get(taskId) as PipelineStatus | null;
  if (!pipelineStatus) return null;

  const counts = db.prepare(
    `SELECT
        (SELECT COUNT(*) FROM task_input_streams WHERE task_id = ?) AS total_segments,
        (SELECT COUNT(*) FROM task_input_streams WHERE task_id = ? AND transcription_status = 'pending') AS pending_transcription,
        (SELECT COUNT(*) FROM task_input_streams WHERE task_id = ? AND transcription_status = 'failed') AS failed_transcription,
        (SELECT COUNT(*) FROM task_input_streams WHERE task_id = ? AND summary_batch_id IS NULL AND transcription_status != 'pending') AS pending_summarization,
        (SELECT COUNT(*) FROM realtime_timeline WHERE task_id = ?) AS timeline_entry_count`,
  ).get(taskId, taskId, taskId, taskId, taskId) as {
    total_segments: number;
    pending_transcription: number;
    failed_transcription: number;
    pending_summarization: number;
    timeline_entry_count: number;
  };

  return { ...pipelineStatus, ...counts };
}

/** Zero-valued counter payload returned when a task has no pipeline row yet. */
export const EMPTY_PIPELINE_COUNTS = {
  total_segments: 0,
  pending_transcription: 0,
  failed_transcription: 0,
  pending_summarization: 0,
  timeline_entry_count: 0,
} as const;
