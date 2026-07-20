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
