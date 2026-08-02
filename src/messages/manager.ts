import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { eventBus } from "../events/bus";

/** Hard cap on a message body. Long enough for two or three sentences. */
export const MESSAGE_MAX_LENGTH = 500;

/** Window in which an identical message from the same agent is treated as a repeat. */
const DEDUP_WINDOW_SECONDS = 5;

export interface TaskMessage {
  id: string;
  task_id: string;
  agent_id: string;
  agent_instance_id: string | null;
  content: string;
  created_at: string;
  /** Joined display name of the posting agent, when the caller asked for it. */
  agent_name?: string | null;
}

export interface PostMessageInput {
  taskId: string;
  agentId: string;
  agentInstanceId?: string | null;
  content: string;
}

export interface PostMessageResult {
  id: string;
  status: "created" | "duplicate";
}

/**
 * Operator messages. An agent posts one when something happens that the human
 * watching the task would want to know: work started on a part of the task, a
 * decision was made, something surprising turned up, the task is nearly done.
 *
 * Deliberately one-way. Unlike notes, messages are never read back into an agent
 * prompt, so nothing here feeds agent context — that keeps the register plain and
 * operator-facing instead of drifting into agent-to-agent shorthand.
 */
export class MessageManager {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDb();
  }

  /**
   * Record a message for the operator. Whitespace is collapsed to a single line
   * and the body is capped at MESSAGE_MAX_LENGTH — this is a status line in a
   * narrow column, not a document. An identical body from the same agent within
   * DEDUP_WINDOW_SECONDS returns the original id instead of a second row, which
   * absorbs the retry an agent makes when a tool result is slow to come back.
   */
  postMessage(input: PostMessageInput): PostMessageResult {
    const content = normalizeContent(input.content);
    if (!content) throw new Error("Message content is empty");

    const duplicate = this.db
      .prepare(
        `SELECT id FROM task_messages
         WHERE task_id = ? AND agent_id = ? AND content = ?
           AND created_at >= datetime('now', ?)
         LIMIT 1`,
      )
      .get(input.taskId, input.agentId, content, `-${DEDUP_WINDOW_SECONDS} seconds`) as { id: string } | null;

    if (duplicate) return { id: duplicate.id, status: "duplicate" };

    const id = crypto.randomUUID();
    this.db
      .prepare(
        "INSERT INTO task_messages (id, task_id, agent_id, agent_instance_id, content) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, input.taskId, input.agentId, input.agentInstanceId ?? null, content);

    eventBus.emit("task:message_posted", {
      messageId: id,
      taskId: input.taskId,
      agentId: input.agentId,
      content,
    });

    return { id, status: "created" };
  }

  /**
   * Messages for a task, newest first — the order the UI column renders them in.
   * Two agents can post inside the same millisecond, and ids are random UUIDs, so
   * the tiebreaker is rowid: insertion order, which is the order they happened.
   */
  listMessages(taskId: string, limit = 50): TaskMessage[] {
    return this.db
      .prepare(
        `SELECT m.*, a.name AS agent_name
         FROM task_messages m
         LEFT JOIN agents a ON a.id = m.agent_id
         WHERE m.task_id = ?
         ORDER BY m.created_at DESC, m.rowid DESC
         LIMIT ?`,
      )
      .all(taskId, limit) as TaskMessage[];
  }

  /** Count for the panel badge. */
  countMessages(taskId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM task_messages WHERE task_id = ?")
      .get(taskId) as { c: number } | null;
    return row?.c ?? 0;
  }
}

/**
 * Messages render in a narrow column, so a body that arrives as a wrapped
 * paragraph or a bullet list is flattened to one line before storage. Truncation
 * is marked with an ellipsis so the operator can tell the agent overran rather
 * than stopped mid-thought.
 */
function normalizeContent(raw: string): string {
  const collapsed = (raw ?? "").replace(/\s+/g, " ").trim();
  if (collapsed.length <= MESSAGE_MAX_LENGTH) return collapsed;
  return collapsed.slice(0, MESSAGE_MAX_LENGTH - 1).trimEnd() + "…";
}
