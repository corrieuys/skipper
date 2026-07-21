# src/slack

Slack app integration. Skipper talks to Slack **as its own app** (bot token
`xoxb-`), not as the operator — the alternative to the external Slack MCP that
authenticates with the user's identity. Two directions:

- **Outbound** (Web API over HTTPS, bot token): post/update messages, open modals,
  read channels, DM users. Works whenever a bot token is set — no socket needed.
- **Inbound** (Socket Mode WS, app-level token `xapp-`): receive slash commands +
  interactive button/modal events. No public URL, no signing secret.

Everything here is **experimental** (`isExperimental()`), consistent with the
"experimental flag for new features" convention.

| file | use |
|---|---|
| `client.ts` | `SlackClient` — thin Web API wrapper (`chat.postMessage` w/ Block Kit, `chat.update`, `views.open`, `users.lookupByEmail`, `conversations.open`, `conversations.history`, `auth.test`). Bot token read lazily from `app_settings` per call (config changes need no restart) |
| `socket.ts` | `SlackSocketManager` — inbound **Socket Mode** WS. `apps.connections.open` (app-level token) → WS → ACK `slash_commands` + `interactive` + `events_api` envelopes within 3s, then do the (slower) work out-of-band. `events_api` message events in a task's origin thread become notes (see below). Mirrors `connect/client.ts` connect/reconnect/backoff. Singletons `initSlackSocket`/`getSlackSocket`; started/stopped in `index.ts` (gated `isExperimental() && isSocketModeConfigured && isSlackSocketEnabled`) and restarted by `/api/config/slack` |
| `commands.ts` | `handleSlashCommand` (async) — authorize against the allowlist, then: scheduled-task binding → `runTaskNow` (arg text = run input); team binding → `createTask` + `approveTask` (arg text = description, cwd = daemon's); else unbound. Also captures the **Slack origin** (see below). Returns the reply text; never throws into the socket loop |
| `push.ts` | `SlackPushManager` — outbound subscriber. Posts new escalations + phase reviews (with buttons) to the default channel. Stateless; gating re-checked live per event so the push toggle needs no restart. Singletons `initSlackPush`/`getSlackPush`; `start()` on boot (when experimental), `stop()` on shutdown |
| `interactions.ts` | `handleInteraction` — routes `block_actions` (button) + `view_submission` (modal). Dismiss acts immediately; Respond/Approve/Reject/**Iterate** open a modal (`private_metadata` carries kind/action/id + origin channel+ts). On submit: authorize, then `resolveEscalation` / `approveReview` / `rejectReview` / **`iterateTask`**, then edit the origin message in place |
| `blocks.ts` | Block Kit builders (escalation + review + **completion** messages, action modal, notices) + the `encodeActionValue`/`decodeActionValue` codec (`<kind>:<action>:<id>`, kinds `esc`/`rev`/`task`) shared by push + interactions. The escalation **question** is agent-authored HTML, run through `htmlToMrkdwn` before it hits a `mrkdwn` field, and the section text is capped at Slack's 3000-char limit |
| `html-to-mrkdwn.ts` | `htmlToMrkdwn(html)` — translate an agent HTML fragment to Slack mrkdwn at the boundary (tags → mrkdwn, `<a>` → `<url\|label>`, entities decoded, `& < >` re-escaped, unknown tags stripped). Agents stay oblivious to Slack; plain text passes through as plain escaping |
| `bindings.ts` | `findSlashCommandConflict` — a command binds to one target only; used by the team + scheduled-task save routes to reject duplicate bindings |
| `slash-command.ts` | `normalizeSlashCommand` (trim/lowercase/single-leading-slash), the `SlackOrigin` type (`{ channel, thread_ts?, user_id? }`), `readTaskSlackOrigin(db, taskId)` (shared reader of `task_config.slack_origin`, used by prompt injection + push thread-routing), and `findRunningTaskByThread` / `findCompletedTaskByThread` (`db, channel, thread_ts`) (match an inbound thread reply to its live task → note, or its completed task → Iterate nudge) |
| `log.ts` | `slackLog(action, details)` — consistent `[slack] <action> k=v …` activity logging across the whole integration (never logs tokens). Excludes WS keep-alive / pass-through ACK noise |

## Outbound: posting as the app

`SlackClient` (bot token) is the only send path. Used by:
- the MCP tools `slack_send_message` / `slack_send_dm` / `slack_read_channel`
  (`src/mcp/tools.ts`) that agents call. `slack_send_message` takes an optional
  `channel` (id `C…` or `#name`, else the default channel) and `thread_ts` (reply
  in-thread). Registered on a session only when **all** hold: `isExperimental()` +
  `isSlackConfigured(db)` + the task's team has `slackEnabled`.
- `SlackPushManager` and `interactions.ts` (below).

The app-level / Socket Mode connection is **receive-only** — you cannot send with
it. Sending always goes through the bot token over HTTPS.

## Push escalations + phase reviews (with buttons)

When `slack_push_enabled` is on (+ bot token), new **escalations** and **phase
reviews** post with action buttons, gated per-team by `slackEnabled` on the task's
team. `SlackPushManager` subscribes to `escalation:created` and
`task:needs_review_changed` (posts only when a review opens). Acting on the buttons
needs Slack **Interactivity** enabled in the app (Socket Mode delivers the events;
no request URL). Only allowlisted users (`slack_allowed_users`) can act.

**Thread routing.** If the task carries a `slack_origin` (it was started from a
slash command — see below), the push posts **into that thread** (origin `channel` +
`thread_ts`), so escalations, reviews, and the agent's own `slack_send_message`
replies all stay scoped to the one originating conversation. Tasks with no origin
(e.g. UI-created) fall back to the **default channel** — which is therefore only
required when there is no origin. `readTaskSlackOrigin` (in `slash-command.ts`) is
the shared reader; delegation is intra-task (agents share one `tasks` row), so a
delegated child's escalation still resolves to the root run's origin via its task id.

Each negative gate in `SlackPushManager.targetChannel` logs a `[slack] push.skip
reason=…` line (`push_disabled`, `team_slack_disabled`, `no_target_channel`, …), so
a silently-dropped push is now traceable in the logs.

- **Escalation** → *Respond* (modal, required message → `resolveEscalation`) /
  *Dismiss* (immediate → `dismissEscalation`).
- **Phase review** → *Approve* (modal, optional note → `PhaseManager.approveReview`)
  / *Reject* (modal, required feedback → `PhaseManager.rejectReview`).

Actions are **buttons + modals**, not slash commands, because a slash command
carries no reference to the message it was typed under. Acting on an
already-handled item is a no-op (`approve`/`reject`) or shows an "already resolved"
edit (`respond`). Reflecting a web-UI resolution back onto the Slack message is out
of scope (stale buttons self-heal on click).

## Task-completion notice (daemon default)

`SlackPushManager` also subscribes to `task:state_changed`; when a task with a
Slack **thread** origin reaches `completed`/`failed`, it posts a one-line system
notice back into that thread (`completionTarget`). This is a **daemon default** —
unlike escalations/reviews it is **not** gated by the push toggle (it's a courtesy
reply to a user-started slash command, not the chatty stream), only by experimental
+ bot token + the team's `slackEnabled` + an origin `thread_ts`. Tasks with no
thread origin (e.g. UI-created) are silently skipped.

The **completed** notice carries an **Iterate** button (`completionMessageBlocks`);
clicking it opens a modal for the next iteration's prompt (mirrors the web UI iterate
flow), and on submit calls `TaskScheduler.iterateTask(taskId, prompt)` — completed →
approved, re-run picked up on the next daemon tick. `slack_origin` survives iteration
(it lives on `task_config`), so escalations/reviews/completion routing keep working
on the re-run, and each re-completion posts a fresh Iterate button. The **failed**
notice has no button (a failed task isn't iterable). Acting is allowlist-gated; a
stale click (task no longer `completed`) self-heals — `iterateTask` throws and the
handler edits the notice to an error line.

## Inbound thread replies → task notes

The socket also handles **`events_api`** envelopes (Events API over Socket Mode).
A plain human reply inside a task's origin thread becomes a **note** on that task
(`socket.ts:handleThreadReply` → `findRunningTaskByThread` → `TaskScheduler.addExternalNote`,
source `user`). Filtered hard: only `type:message` events with a `thread_ts`, **no**
`bot_id` (so Skipper's own anchors / escalations / `slack_send_message` agent replies
are excluded — no feedback loop) and **no** `subtype` (edits/deletes/joins skipped).
Matched only against a **running** task whose `slack_origin` channel + `thread_ts`
line up. The note surfaces to the agent on its next prompt build (not injected into a
live turn). A reply that matches instead a **completed** task in the same thread does
**not** auto-iterate (a full re-run is too costly to trigger on a stray reply) —
`findCompletedTaskByThread` detects it and the socket posts a nudge to click the
**Iterate** button on the completion notice. On success the socket posts a short in-thread **ack** (":memo: Added to
this task's notes.") — itself a bot message, so the events frame for it is filtered
out (no capture loop). The "Started …" **anchor** posted at task create also tells the
operator up front that replies here become notes (`THREAD_NOTE_HINT` in `commands.ts`).
Requires the app to subscribe to the `message.channels` / `message.groups` bot events
(see setup).

## Inbound slash commands → tasks

Socket Mode delivers `slash_commands` envelopes. The socket ACKs immediately, runs
`handleSlashCommand`, and delivers the user-facing reply via the command's
`response_url` (the work — anchor post + task spawn — can exceed the 3s ACK budget).

Bindings (no schema change — JSON keys; commands are pre-registered in Slack, then
bound in Skipper's UI — Slack won't mint commands at runtime):
- **team** → `local_teams.team_config.slashCommand` (`findTeamBySlashCommand`).
  `/software-team "add a webhook feature"` creates + auto-approves a task on that
  team. Set on the team edit form.
- **scheduled task** → `scheduled_tasks.task_config.slashCommand`
  (`ScheduledTaskScheduler.findScheduledTaskBySlashCommand`). Runs it now with the
  arg text as run input. Set on the recurring-task form. Only fires when approved.

### Slack origin (reply back to where it came from)

On a slash-command trigger, `handleSlashCommand` posts an **anchor message** to the
invoking channel (best-effort) and stamps `task_config.slack_origin`
(`{ channel, thread_ts?, user_id? }`) onto the run — team tasks via `createTask`'s
`taskConfig`, scheduled runs via `runTaskNow(..., { slackOrigin })`. If the anchor
post fails or Slack is unconfigured, it falls back to a channel-only origin (no
thread). `prompt-builder.ts:getSlackOrigin` then injects a `SLACK ORIGIN` block
into the run's prompt telling the agent to reply with `slack_send_message` targeting
that `channel` + `thread_ts` — but only when the Slack tools are actually available
(experimental + configured + team `slackEnabled`), so we never point the agent at a
tool it lacks. Replying is left to the existing `slack_send_message` tool (the agent
targets it manually); there is no dedicated reply tool.

## Config + gating

- **Credentials** (global, machine-scoped, runtime `app_settings`): bot token +
  default channel, plus the app-level token, Socket Mode toggle, push toggle, and
  the auth allowlist. Helpers in [../config/slack-settings.ts](../config/slack-settings.ts).
  Tokens stored plaintext (replayed per call), never echoed back to the UI. Set on
  `/config`; saving restarts the socket. `app_settings` keys: `slack_bot_token`,
  `slack_default_channel`, `slack_app_token`, `slack_socket_enabled`,
  `slack_push_enabled`, `slack_allowed_users` (JSON array of Slack user ids — the
  auth allowlist; **empty ⇒ deny everyone**, fail closed).
- **Per-team opt-in**: `slackEnabled` on the team's `team_config` JSON (runtime
  `local_teams`), `isSlackEnabledForTeam(db, teamId)`. Gates the MCP tools, push,
  and the origin prompt injection for that team's tasks.

## Slack app setup (one-time)

- **Bot scopes**: `chat:write` (post/update), `im:write` (open DMs), `users:read` +
  `users:read.email` (resolve a user by email for DMs), `channels:history` +
  `groups:history` (read public / private channels), `channels:read` + `groups:read`
  (resolve `#name` → channel id — the modern API rejects `#name` in
  `chat.postMessage`, so `SlackClient` looks the id up via `conversations.list`).
- **Channel membership**: the bot must be **added to** any channel it posts to /
  reads (`/invite @YourApp`), else Slack returns `not_in_channel`. An unknown or
  not-visible `#name` returns `channel_not_found`.
- **Socket Mode** (for slash commands + buttons): enable Socket Mode; create an
  **app-level token** (`xapp-…`, scope `connections:write`); add each slash command
  under "Slash Commands" + the `commands` scope; enable **Interactivity** (needed
  for the push buttons/modals); reinstall.
- **Event Subscriptions** (for thread-reply → note): enable Events, and under "Subscribe
  to bot events" add `message.channels` (public) and/or `message.groups` (private) —
  these arrive as `events_api` envelopes over the same socket. Needs the matching
  `channels:history` / `groups:history` scopes (already required for reading). Without
  this the daemon never sees thread replies; escalations/reviews/completion push still
  work (they are outbound-only).
