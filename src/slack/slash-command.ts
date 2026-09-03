import type { Database } from "bun:sqlite";

/**
 * How a task acquired its Slack origin. `slash_command` — a human typed a bound
 * command, so Skipper posted an anchor and owns the thread from the start.
 * `agent_message` — nobody triggered this from Slack, but the run's agent posted
 * (or DM'd) via the Slack MCP tools, and that message became the task's thread.
 */
export type SlackOriginSource = "slash_command" | "agent_message";

/**
 * Where a task's Slack conversation lives, stashed on `task_config.slack_origin`
 * so everything the task emits (agent replies, escalations, reviews, the
 * completion notice) lands in one thread.
 *
 * For a slash command, `thread_ts` is the anchor message Skipper posts on trigger
 * (absent if that post failed or Slack is unconfigured, in which case the agent
 * replies to the channel directly). For an agent message it is that message's own
 * `ts` — or the thread it replied into.
 */
export interface SlackOrigin {
  channel: string;
  thread_ts?: string;
  user_id?: string;
  source?: SlackOriginSource;
}

/**
 * Read the Slack origin stashed on a task's `task_config.slack_origin`, or null.
 * Pure lookup with no gating — callers (prompt injection, push routing) apply
 * their own experimental/team gates. Delegation is intra-task (agents share one
 * `tasks` row), so an escalation from a delegated child still resolves to the
 * root run's origin via its task id.
 *
 * `source` defaults to `slash_command`: rows stamped before origins carried a
 * source could only have come from a slash command.
 */
export function readTaskSlackOrigin(db: Database, taskId: string): SlackOrigin | null {
  try {
    const row = db
      .prepare("SELECT task_config FROM tasks WHERE id = ?")
      .get(taskId) as { task_config: string | null } | null;
    if (!row?.task_config) return null;
    const config = JSON.parse(row.task_config) as Record<string, unknown>;
    const o = config.slack_origin as Partial<SlackOrigin> | undefined;
    if (o && typeof o.channel === "string" && o.channel) {
      return {
        channel: o.channel,
        thread_ts: o.thread_ts,
        user_id: o.user_id,
        source: o.source === "agent_message" ? "agent_message" : "slash_command",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Stamp a Slack origin onto a task, **first write wins**. Returns true when this
 * call is the one that set it.
 *
 * A task has exactly one origin thread, and the first Slack surface it touches
 * owns it. The guard is part of the UPDATE rather than a read-then-write so
 * concurrent writers (a root and its delegated children can all post at once)
 * can't race, and so an agent posting to a second channel later in the run can
 * never move routing out from under an in-flight escalation. It also means a real
 * slash-command origin is never clobbered by a subsequent agent post.
 *
 * Best-effort by design: a task whose `task_config` isn't valid JSON throws
 * inside `json_extract` and is left alone rather than overwritten.
 */
export function stampTaskSlackOrigin(db: Database, taskId: string, origin: SlackOrigin): boolean {
  if (!taskId || !origin.channel) return false;
  try {
    const res = db
      .prepare(
        `UPDATE tasks
            SET task_config = json_set(coalesce(task_config, '{}'), '$.slack_origin', json(?)),
                updated_at = datetime('now')
          WHERE id = ?
            AND json_extract(task_config, '$.slack_origin.channel') IS NULL`,
      )
      .run(JSON.stringify(origin), taskId);
    return res.changes > 0;
  } catch {
    return false;
  }
}

/**
 * Find the task whose Slack origin matches this thread (channel + `thread_ts`),
 * or null. Active tasks win over settled ones; within each status the newest
 * matches. Used to feed a human reply in the origin thread to the task through
 * the unified input path (`daemon.inputTask`), which auto-revives a settled
 * task and wakes an idle one. `slack_origin` lives on `task_config`, which no
 * lifecycle transition clears, so the thread stays matchable for the task's
 * whole life.
 */
export function findTaskByThread(
  db: Database,
  channel: string,
  threadTs: string,
): { id: string; status: string } | null {
  try {
    const row = db
      .prepare(
        `SELECT id, status FROM tasks
         WHERE status IN ('active', 'settled')
           AND json_extract(task_config, '$.slack_origin.channel') = ?
           AND json_extract(task_config, '$.slack_origin.thread_ts') = ?
         ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
         LIMIT 1`,
      )
      .get(channel, threadTs) as { id: string; status: string } | null;
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Normalize a Slack slash-command string for storage + comparison: trim,
 * lowercase, collapse to a single leading slash. Empty/blank input → "".
 * Slack delivers commands as "/software-team"; operators may bind them with or
 * without the leading slash, so both sides pass through here.
 */
export function normalizeSlashCommand(raw: string | null | undefined): string {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return "";
  return "/" + s.replace(/^\/+/, "");
}

/**
 * The word an inbound Slack thread reply must contain before it is fed to the
 * task as input. A task's thread is a normal conversation (most of what gets
 * typed in it is people talking to each other, not to Skipper), so without a
 * gate every aside would land in the agent's context as an instruction.
 *
 * Deliberately a loose substring test, matched case-insensitively: it is the
 * cheap first pass. Mentioning the word is not the same as addressing Skipper,
 * so captured replies carry a "Slack reply from ..." attribution and the agent
 * judges relevance itself.
 */
export const SKIPPER_MENTION = "skipper";

/** Prefix stamped on legacy notes captured from a Slack thread (prompt-builder
 * still flags notes carrying it). */
export const SLACK_NOTE_PREFIX = "[Slack]";

/** Whether an inbound Slack message mentions Skipper (case-insensitive). */
export function mentionsSkipper(text: string | null | undefined): boolean {
  return (text ?? "").toLowerCase().includes(SKIPPER_MENTION);
}
