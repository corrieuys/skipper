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
| `socket.ts` | `SlackSocketManager` — inbound **Socket Mode** WS. `apps.connections.open` (app-level token) → WS → ACK `slash_commands` + `interactive` envelopes within 3s, then do the (slower) work out-of-band. Mirrors `connect/client.ts` connect/reconnect/backoff. Singletons `initSlackSocket`/`getSlackSocket`; started/stopped in `index.ts` (gated `isExperimental() && isSocketModeConfigured && isSlackSocketEnabled`) and restarted by `/api/config/slack` |
| `commands.ts` | `handleSlashCommand` (async) — authorize against the allowlist, then: scheduled-task binding → `runTaskNow` (arg text = run input); team binding → `createTask` + `approveTask` (arg text = description, cwd = daemon's); else unbound. Also captures the **Slack origin** (see below). Returns the reply text; never throws into the socket loop |
| `push.ts` | `SlackPushManager` — outbound subscriber. Posts new escalations + phase reviews (with buttons) to the default channel. Stateless; gating re-checked live per event so the push toggle needs no restart. Singletons `initSlackPush`/`getSlackPush`; `start()` on boot (when experimental), `stop()` on shutdown |
| `interactions.ts` | `handleInteraction` — routes `block_actions` (button) + `view_submission` (modal). Dismiss acts immediately; Respond/Approve/Reject open a modal (`private_metadata` carries kind/action/id + origin channel+ts). On submit: authorize, then `resolveEscalation` / `approveReview` / `rejectReview`, then edit the origin message in place |
| `blocks.ts` | Block Kit builders (escalation + review messages, action modal, notices) + the `encodeActionValue`/`decodeActionValue` codec (`<kind>:<action>:<id>`) shared by push + interactions |
| `bindings.ts` | `findSlashCommandConflict` — a command binds to one target only; used by the team + scheduled-task save routes to reject duplicate bindings |
| `slash-command.ts` | `normalizeSlashCommand` (trim/lowercase/single-leading-slash) + the `SlackOrigin` type (`{ channel, thread_ts?, user_id? }`) |

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

When `slack_push_enabled` is on (+ bot token + default channel), new **escalations**
and **phase reviews** post to the default channel with action buttons, gated
per-team by `slackEnabled` on the task's team. `SlackPushManager` subscribes to
`escalation:created` and `task:needs_review_changed` (posts only when a review
opens). Acting on the buttons needs Slack **Interactivity** enabled in the app
(Socket Mode delivers the events; no request URL). Only allowlisted users
(`slack_allowed_users`) can act.

- **Escalation** → *Respond* (modal, required message → `resolveEscalation`) /
  *Dismiss* (immediate → `dismissEscalation`).
- **Phase review** → *Approve* (modal, optional note → `PhaseManager.approveReview`)
  / *Reject* (modal, required feedback → `PhaseManager.rejectReview`).

Actions are **buttons + modals**, not slash commands, because a slash command
carries no reference to the message it was typed under. Acting on an
already-handled item is a no-op (`approve`/`reject`) or shows an "already resolved"
edit (`respond`). Reflecting a web-UI resolution back onto the Slack message is out
of scope (stale buttons self-heal on click).

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
