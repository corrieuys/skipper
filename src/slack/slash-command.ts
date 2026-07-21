import type { Database } from "bun:sqlite";

/**
 * Where a slash-command-triggered run came from in Slack, stashed on the run's
 * `task_config.slack_origin` so the agent can reply to it. `thread_ts` is the
 * anchor message Skipper posts on trigger (absent if that post failed or Slack
 * is unconfigured, in which case the agent replies to the channel directly).
 */
export interface SlackOrigin {
  channel: string;
  thread_ts?: string;
  user_id?: string;
}

/**
 * Read the Slack origin stashed on a task's `task_config.slack_origin`, or null.
 * Pure lookup with no gating — callers (prompt injection, push routing) apply
 * their own experimental/team gates. Delegation is intra-task (agents share one
 * `tasks` row), so an escalation from a delegated child still resolves to the
 * root run's origin via its task id.
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
      return { channel: o.channel, thread_ts: o.thread_ts, user_id: o.user_id };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Find the currently-running task whose Slack origin matches this thread
 * (channel + `thread_ts`), or null. Used to attach a human reply in the origin
 * thread as a note on the live task. Restricted to `running` so replies to an old,
 * finished thread don't reopen anything.
 */
export function findRunningTaskByThread(
  db: Database,
  channel: string,
  threadTs: string,
): string | null {
  try {
    const row = db
      .prepare(
        `SELECT id FROM tasks
         WHERE status = 'running'
           AND json_extract(task_config, '$.slack_origin.channel') = ?
           AND json_extract(task_config, '$.slack_origin.thread_ts') = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(channel, threadTs) as { id: string } | null;
    return row?.id ?? null;
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
