/**
 * Consistent `[slack]` activity logging for the whole integration.
 *
 * Every meaningful inbound/outbound Slack action logs a one-line trace so the
 * integration is debuggable end-to-end. This exists because the push path used to
 * fail *silently*: `SlackPushManager.targetChannel` returns null on any of five
 * gating checks with no output, so an escalation that never reached Slack left no
 * trace of *why*. Now each gate, API call, and dispatch logs.
 *
 * Deliberately excluded: WS heartbeat / keep-alive frames and the ACKs of
 * pass-through envelopes (events_api etc.) — those are per-second noise, not
 * actions. Real inbound commands/interactions and all outbound calls do log.
 *
 * Never logs token values. Channel ids / user ids / message text are fine (they
 * already flow through the surrounding console logs and the DB error_log).
 */
export function slackLog(action: string, details?: Record<string, unknown>): void {
  const suffix = details && Object.keys(details).length ? ` ${fmt(details)}` : "";
  console.log(`[slack] ${action}${suffix}`);
}

function fmt(details: Record<string, unknown>): string {
  return Object.entries(details)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}
