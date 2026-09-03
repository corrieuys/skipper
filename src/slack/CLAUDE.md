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
| `push.ts` | `SlackPushManager` — outbound subscriber. Posts new escalations + phase reviews (with buttons), task-completion notices, and operator messages (`task:message_posted`, no buttons) into the task's origin thread. Stateless; gating re-checked live per event so the push toggle needs no restart. Singletons `initSlackPush`/`getSlackPush`; `start()` on boot (when experimental), `stop()` on shutdown |
| `interactions.ts` | `handleInteraction` — routes `block_actions` (button) + `view_submission` (modal). Dismiss acts immediately; Respond/Approve/Reject open a modal (`private_metadata` carries kind/action/id + origin channel+ts). On submit: authorize, then `resolveEscalation` / `approveReview` / `rejectReview`, then edit the origin message in place. Legacy Iterate buttons in scrollback self-heal on click (ephemeral pointer to the thread-reply flow) |
| `blocks.ts` | Block Kit builders (escalation + review + **completion** messages, action modal, notices) + the `encodeActionValue`/`decodeActionValue` codec (`<kind>:<action>:<id>`, kinds `esc`/`rev`/`task`) shared by push + interactions. The escalation **question** is agent-authored HTML, run through `htmlToMrkdwn` before it hits a `mrkdwn` field, and the section text is capped at Slack's 3000-char limit |
| `html-to-mrkdwn.ts` | `htmlToMrkdwn(html)` — translate an agent HTML fragment to Slack mrkdwn at the boundary (tags → mrkdwn, `<a>` → `<url\|label>`, entities decoded, `& < >` re-escaped, unknown tags stripped). Agents stay oblivious to Slack; plain text passes through as plain escaping |
| `bindings.ts` | `findSlashCommandConflict` — a command binds to one target only; used by the team + scheduled-task save routes to reject duplicate bindings |
| `slash-command.ts` | `normalizeSlashCommand` (trim/lowercase/single-leading-slash), `mentionsSkipper` + `SLACK_NOTE_PREFIX` (the inbound thread-reply note gate), the `SlackOrigin` type (`{ channel, thread_ts?, user_id?, source? }`), `readTaskSlackOrigin(db, taskId)` (shared reader of `task_config.slack_origin`, used by prompt injection + push thread-routing) + `stampTaskSlackOrigin(db, taskId, origin)` (first-write-wins writer — see Slack origin below), and `findTaskByThread` (`db, channel, thread_ts`) (match an inbound thread reply to its task — active wins over settled; replies feed `daemon.inputTask`, which wakes idle tasks and auto-revives settled ones) |
| `log.ts` | `slackLog(action, details)` — consistent `[slack] <action> k=v …` activity logging across the whole integration (never logs tokens). Excludes WS keep-alive / pass-through ACK noise |

## Outbound: posting as the app

`SlackClient` (bot token) is the only send path. Used by:
- the MCP tools `slack_send_message` / `slack_send_dm` / `slack_read_channel`
  (`src/mcp/tools.ts`) that agents call. `slack_send_message` takes an optional
  `channel` (id `C…` or `#name`, else the default channel) and `thread_ts` (reply
  in-thread). Registered on a session only when **all** hold: **not a delegated
  session** + `isExperimental()` + `isSlackConfigured(db)` + the task's team has
  `slackEnabled`. **Only Skipper talks via Slack** — a task's thread is one
  conversation with the operator, and several delegated voices posting into it
  would read as noise; children reach the operator by escalating, which the push
  forwards into the same thread.
- `SlackPushManager` and `interactions.ts` (below).

The app-level / Socket Mode connection is **receive-only** — you cannot send with
it. Sending always goes through the bot token over HTTPS.

## Push escalations + phase reviews (with buttons)

With a bot token set, new **escalations** and **phase reviews** post with action
buttons, gated per-team by `slackEnabled` on the task's team. There is **no global
push toggle** — the per-team opt-in is the switch (the old `slack_push_enabled`
setting was removed as redundant now that pushes are thread-scoped).
`SlackPushManager` subscribes to `escalation:created`,
`task:needs_review_changed` (posts only when a review opens),
`task:message_posted` and `task:state_changed`. Acting on the buttons
needs Slack **Interactivity** enabled in the app (Socket Mode delivers the events;
no request URL). Only allowlisted users (`slack_allowed_users`) can act.

**Thread routing is origin-only.** A push fires when the task **has** a
`slack_origin` — a slash command started it, or its agent posted/DM'd via the
Slack tools — and posts into that thread (origin `channel` + `thread_ts`), so
escalations, reviews, the completion notice and the agent's own
`slack_send_message` replies all stay scoped to one conversation. There is
deliberately **no default-channel fallback**: a task that never touched Slack has
no thread to be answered in, so dumping its escalation into a shared channel just
detaches the question from its context (skip reason `no_slack_origin`). The
default channel is now only the target an agent gets when it calls
`slack_send_message` without a `channel`. `readTaskSlackOrigin` (in
`slash-command.ts`) is the shared reader; delegation is intra-task (agents share
one `tasks` row), so a delegated child's escalation still resolves to the root
run's origin via its task id.

Each negative gate in `SlackPushManager.targetChannel` logs a `[slack] push.skip
reason=…` line (`no_bot_token`, `team_slack_disabled`, `no_target_channel`, …), so
a silently-dropped push is traceable in the logs.

- **Escalation** → *Respond* (modal, required message → `resolveEscalation`) /
  *Dismiss* (immediate → `dismissEscalation`).
- **Phase review** → *Approve* (modal, optional note → `PhaseManager.approveReview`)
  / *Reject* (modal, required feedback → `PhaseManager.rejectReview`).

Actions are **buttons + modals**, not slash commands, because a slash command
carries no reference to the message it was typed under. Reflecting a web-UI
resolution back onto the Slack message is out of scope — instead, stale buttons
self-heal on click.

**Stale buttons.** Buttons outlive the records behind them: a task gets swept by
`autoDeleteOldTasks` retention, an escalation is answered in the web UI, a review
is approved elsewhere. `interactions.ts:staleReason` checks the item **before any
button acts** (missing task / escalation not `open` /
review no longer open on an active task) and, when stale, posts an ephemeral
explanation to the clicker via `response_url` and edits the message to replace the
dead button, keeping whatever context is still recoverable so the thread does not
lose what it was about. Checking at click time is the only option: the posted
message's `ts` is never stored, and for a deleted task the row it would live on is
gone too, so there is no proactive cleanup path.

The check runs ahead of *every* button, not just the modal ones. For Respond /
Approve / Reject it saves the operator typing a full response into a
modal whose submission would throw and take the text with it. For **Dismiss**,
which acts immediately, it is what keeps `EscalationManager`'s raw throw
("Escalation not found: `<uuid>`") out of the channel. It also covers `rev`
approve/reject, which `PhaseManager` otherwise accepts silently, leaving the
message claiming success.

## Operator messages

Agent-written progress updates (`post_message`, see [../messages/CLAUDE.md](../messages/CLAUDE.md))
post into the task's thread as `:speech_balloon: *<agent>*: <text>`
(`operatorMessageBlocks`), through the same `targetChannel` gates as an escalation —
so a task with a Slack conversation shows what happened *between* the questions and
the sign-off, not just the endpoints. No buttons: there is nothing to act on. Not
capped; the writing rules in `prompts/commands-messages.md` are what keep the volume
sane. No feedback loop — the push posts as the bot, and `handleThreadReply` drops
anything with a `bot_id`.

## Run-settled notice (daemon default)

`SlackPushManager` subscribes to `task:run_completed` / `task:run_failed`; when a
task with a Slack **thread** origin settles a run, it posts a one-line system
notice back into that thread (`completionTarget`). This is a **daemon default**,
gated by experimental + bot token + the team's `slackEnabled` + an origin
`thread_ts`. Tasks with no thread origin (e.g. UI-created, and never posted to
Slack) are silently skipped.

Both notices are section-only (`completionMessageBlocks(taskTitle, failed)`, no
buttons) and tell the operator to **reply in the thread (including the word
"Skipper") to continue the task** — the unified input path. `slack_origin` lives
on `task_config`, so escalations/reviews/notice routing keep working across
wakes, and each re-settled run posts a fresh notice. Legacy Iterate buttons from
old notices self-heal on click with a pointer to the reply flow.

## Inbound thread replies → task input

The socket also handles **`events_api`** envelopes (Events API over Socket Mode).
A human reply inside a task's origin thread becomes **input** on that task
(`socket.ts:handleThreadReply` → `findTaskByThread` → `daemon.inputTask(taskId,
text, "slack")` — wakes an idle task, accumulates while it is busy, and
auto-revives a settled one). Filtered hard: only `type:message` events with a `thread_ts`, **no**
`bot_id` (so Skipper's own anchors / escalations / `slack_send_message` agent replies
are excluded — no feedback loop), **no** `subtype` (edits/deletes/joins skipped), and
the text must **contain the word "skipper"** (`mentionsSkipper`, case-insensitive
substring — `slash-command.ts`; the literal word, *not* an @-mention). A task thread is a normal conversation, so without that gate every
aside between colleagues would land in the agent's prompt as an OPERATOR INSTRUCTION;
a reply that doesn't mention Skipper is dropped with `in.thread_reply.skip
reason=no_skipper_mention` and gets no ack.

Because the gate is a loose substring it also admits people talking *about* Skipper.
Captured notes are therefore prefixed `[Slack]` (`SLACK_NOTE_PREFIX`), and
`prompt-builder.ts:appendNotesSections` appends a caution to the OPERATOR INSTRUCTIONS
section whenever one is present: treat them with suspicion, judge each on relevance and
ignore what isn't meant for the run — but a message addressing Skipper directly is
always relevant. Deciding relevance is the model's job; the gate only keeps the volume
down.
Matched against the task whose `slack_origin` channel + `thread_ts` line up
(active wins over settled on the same thread; drafts never match). Delivery is
`daemon.inputTask` semantics: an idle task wakes through the queue, a busy one
accumulates the input for its next turn, a settled one is revived and
woken. On success the socket posts a short in-thread **ack** reflecting queued
vs accumulated delivery — itself a bot message, so the events frame for it is
filtered out (no capture loop). The "Started …" **anchor** posted at task create
also tells the operator up front that replies here send input to the task, and
that only replies containing the word "Skipper" are delivered
(`THREAD_NOTE_HINT` in `commands.ts`, which quotes the word precisely because
"mention" reads as @-mention in Slack).
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

### Slack origin (the task's one Slack conversation)

`task_config.slack_origin` (`{ channel, thread_ts?, user_id?, source? }`) is where
everything a task emits to Slack lands. It is acquired **two** ways, tagged by
`source`:

- **`slash_command`** — `handleSlashCommand` posts an **anchor message** to the
  invoking channel (best-effort) and stamps the origin onto the run: team tasks via
  `createTask`'s `taskConfig`, scheduled runs via `runTaskNow(..., { slackOrigin })`.
  If the anchor post fails or Slack is unconfigured it falls back to a channel-only
  origin (no thread).
- **`agent_message`** — nobody started the task from Slack, but its agent called
  `slack_send_message` / `slack_send_dm`. That message's thread (its own `ts`, or
  the `thread_ts` it replied into; for a DM, the DM channel) becomes the origin, via
  `stampTaskSlackOrigin` in the tool handlers. This is what gives a **recurring or
  UI-created** task that reports into Slack a home for its escalations, reviews and
  completion notice.

**Carried across a `run_recurring_task` call.** When the root Skipper on a
Slack-rooted task fires another recurring task via the MCP `run_recurring_task`
tool (see [../mcp/CLAUDE.md](../mcp/CLAUDE.md)), that tool reads the caller's origin
with `readTaskSlackOrigin` and passes it as `runTaskNow`'s `slackOrigin`, so the new
run inherits the same thread and its Slack output continues there. The origin's
`source` is preserved (it is copied, not re-tagged). Opt out per call with
`continue_slack_thread: false`.

**First write wins.** `stampTaskSlackOrigin` guards inside the `UPDATE`
(`json_set` + `WHERE json_extract(...slack_origin.channel) IS NULL`) rather than
read-then-write, so concurrent posters (a root and its delegated children) can't
race, an agent posting to a second channel later in the run can't move routing out
from under an in-flight escalation, and a real slash-command origin is never
clobbered by a later agent post. A task whose `task_config` isn't valid JSON is
left alone rather than overwritten.

**Telling the agent.** Two channels, because prompts are only built at spawn /
phase change / delegation / respawn — never mid-turn, so an agent that posts
mid-run cannot learn from its own prompt what just happened:

- the **tool result** of a capturing send carries `thread_ts` + a `note` saying the
  thread is now the task's Slack home and that escalations/reviews/completion post
  there automatically. Lands in the live agent's context immediately.
- `prompt-builder.ts:getSlackOrigin` injects the `SLACK ORIGIN` block on **later**
  builds (next phase, respawn after a crash — delegated children build a different
  prompt and never get it). Wording branches on `source`: a slash origin says "this
  task was started from Slack, reply there" (a human is waiting); an agent origin
  only makes the thread **known** — "this task has an existing Slack thread; if you
  do post, use it rather than opening another" — deliberately not an instruction to
  post, since nobody asked this task to talk to Slack. Injected only when the Slack
  tools are actually available, so we never point the agent at a tool it lacks.

Both branches carry the **length constraint**, and only when an origin exists,
because only then does it apply: escalations and review notes should stay under
`SLACK_ESCALATION_SOFT_LIMIT`, since `escalationMessageBlocks` clips at
`ESCALATION_TEXT_LIMIT` and agents put the ask last. Both constants live in
`blocks.ts` and every surface reads them from there (the prompt block, the
`slack_send_*` capture note, the `escalate` warning, the `push.truncated` log) —
they were duplicated as literals once and drifted apart. `escalate` also returns a
`slack_warning` past that length (see [../mcp/CLAUDE.md](../mcp/CLAUDE.md)), the
only surface reaching an agent whose prompt predates the origin. Oversized pushes
log `push.truncated`.

Replying is left to the existing `slack_send_message` tool (the agent targets it
manually); there is no dedicated reply tool.

## Config + gating

- **Credentials** (global, machine-scoped, runtime `app_settings`): bot token +
  default channel, plus the app-level token, Socket Mode toggle, push toggle, and
  the auth allowlist. Helpers in [../config/slack-settings.ts](../config/slack-settings.ts).
  Tokens stored plaintext (replayed per call), never echoed back to the UI. Set on
  `/config`; saving restarts the socket. `app_settings` keys: `slack_bot_token`,
  `slack_default_channel`, `slack_app_token`, `slack_socket_enabled`,
  `slack_allowed_users` (JSON array of Slack user ids — the auth allowlist;
  **empty ⇒ deny everyone**, fail closed).
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
