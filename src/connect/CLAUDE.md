# src/connect

Skipper Connect: outbound WebSocket from the daemon to a remote integrator service. The operator must supply the remote URL; there is no built-in default. The integrator remote-controls this instance over the socket. The daemon exposes exactly one inbound socket, `GET /connect/local` (`local-endpoint.ts`), for clients on this machine; it is unauthenticated and loopback only. Credentials (key + URL) live in runtime `app_settings` (see `src/config/app-settings.ts`); connect stays disabled until both are set. The instance global id (gid) is not stored: it is derived from the connect key's JWT payload via `gidFromConnectKey()` in `public-links.ts` (unverified decode; the integrator is authoritative and routes by the gid it verifies itself).

| file | use |
|---|---|
| `client.ts` | `ConnectClient` - WS connect/auth/reconnect w/ backoff. Handles `auth_ok`/`auth_error`/`command` itself and hands every other frame to a `ConsumerSession`. `getResourceDeps()` exposes the one `ResourceDeps` object, built here and shared with the local endpoint (wired in `index.ts`) |
| `consumer-session.ts` | `ConsumerSession(sender, deps, opts)` - one consumer's view of the daemon over any socket: `handleFrame(raw)` / `handleMessage(msg)` + `destroy()`. Owns `subscribeConnectEvents(sender)` (constructing the session therefore emits `connect:capabilities` at once) and one `OutputTailManager`. Dispatches `request` → `response`; the worker's provider-side `output_subscribe`/`output_unsubscribe` (no acks); the consumer-side `subscribe`/`unsubscribe` with `channel:"outputs"` → `subscribed` / `unsubscribed` / `sub_error` acks, capped at `MAX_OUTPUT_SUBS_PER_SESSION` (4, mirroring the worker; the ack-less provider path is deliberately uncapped since the worker already caps its own consumers and forwards their union); `ping` → `pong`, plus `pong` → `onPong` for daemon-side liveness |
| `local-endpoint.ts` | `createConnectLocalEndpoint(deps)` - the inbound `GET /connect/local` WebSocket for apps on this machine (the Mac app). **Loopback only, always**: the upgrade is refused unless `server.requestIP(req)` is 127.0.0.0/8 or `::1`, even when `SKIPPER_HOST` exposes the daemon; a refused or non-WS request falls through to a 403 route. **No auth and no scope checks**: the local socket is exactly as privileged as the local web UI. On open it sends `{type:"auth_ok"}` then attaches a `ConsumerSession`, so the app gets version + features from `connect:capabilities` immediately (a later reconnect can also read `features` from `state/snapshot`). Daemon-side `ping` every 30s, close after 2 missed pongs; close detaches the session (events + tail). Chunked artifact upload / read-bytes work unchanged; the 1 MiB frame cap is a worker constraint and does not apply here, but clients keep chunking so one code path serves both server kinds |
| `protocol.ts` | `ClientMessage`/`ServerMessage` frame types, `CONNECT_TOOLS`, `CONNECT_PROTOCOL_VERSION` (**v3**), entity projections (`TaskListItem`, `TaskDetailItem` etc.), `StateSnapshot` |
| `commands.ts` | `command` frame handlers (create/delete/approve task etc.) |
| `resources.ts` | `request` frame handlers: tasks (see the v3 action list below; `create` takes `mode` + optional `kind: 'recurring'`), teams (`list` - light id/name/goal/phase_count projection for the remote create-task picker; `list-all`/`create`/`update`/`delete` for full team management), escalations, reviews, notes, messages, timeline (`list` - operator input entries, see below), artifacts, outputs, state (`snapshot` - one-shot store hydration for the web app), webhooks (`trigger` - public static-URL trigger for recurring tasks; validates `scheduled_tasks.webhook_key` timing-safe, then `runWebhookTask` with the payload as run input; per-task leading-edge debounce (`webhook_debounce_minutes`, floor 1) ignores webhooks inside the window with a "Debounced" error, ignored webhooks restamp the window; opaque error for bad key/id, no enumeration). Artifact actions include `publish`/`unpublish`/`read-published` (public links) |
| `events.ts` | Forward domain events as **fat events** (incl. `instance:state_changed`, carrying the task projection, so clients refresh the agent roster without polling): payload keeps the bus shape plus the changed entity's projection (task/escalation/note/message/artifact/timeline entry) so integrators patch a local store without refetching. Coalesces `delegation_group:progress` (500ms/group). Sends `connect:capabilities` on subscribe (the daemon-side subscribe, i.e. once per attach; a consumer that connects later must read the same `features` list from `state/snapshot`) |
| `serializers.ts` | Entity projections shared by events + snapshot + reads (`projectTask`, `toTaskListItem`, `toTaskDetailItem`, `snapshotTimelineEntries`, `fetchTimelineEntryItem`). Never ship heavy fields (orchestration_state, task_config, artifact bodies); the detail projection does carry description + result |
| `output-tail.ts` | `OutputTailManager` - live agent output as coalesced `output_batch` frames, only while the server reports a subscribed consumer (`output_subscribe`/`output_unsubscribe`). Detached from bus when idle. **On subscribe it first replays recent `terminal_outputs` for the task as a one-shot `output_batch` with `backfill: true` (oldest-first, `backfillEntries` cap, default 200, AND a `backfillMaxBytes` budget, default 1MB, spent from the newest row so a phone never gets a multi-MB seed frame; backfill entries carry `id` = the `outputs/list` `beforeId` cursor for paging older history), then streams live** — so the integrator seeds a task's timeline (agent prose, tool calls, sys frames) from a single subscribe with no separate `outputs/list` read and no read-then-subscribe gap. Attach-then-backfill runs synchronously, so a line is either in the backfill or a later live frame, never both/neither |
| `public-links.ts` | Build public artifact URLs (`https://<integrator>/p/<gid>/<artifactId>?key=...`) and webhook trigger URLs (`.../wh/<gid>/<scheduledTaskId>?key=...`); gid decoded from the connect key |

## Protocol v3: the task contract

`CONNECT_PROTOCOL_VERSION = 3`. Every task-carrying payload (snapshot, fat
events, `tasks/list`, `tasks/read`, action replies) uses the unified model:

| field | value |
|---|---|
| `status` | raw stored status: `draft` / `active` / `settled` |
| `display_status` | derived: `draft` / `queued` / `working` / `idle` / `paused` / `review` / `blocked` / `completed` / `failed` |
| `mode` | `workflow` (autopilot on) / `conversational` (operator drives) |
| `paused` | boolean flag on an active task |
| `needs_review` | boolean review gate |

Dropped in v3: `task_type`, `iteration_count`, `unified_status`, and the legacy
`draft/approved/running/...` status mapping (`legacyStatusFor` is gone from the
codebase). `settled` never surfaces as UX copy: a settled task presents as
Completed, or Failed when its result carries an `.error`.

**tasks actions:** `list`, `read`, `create`, `update`, `delete`, `approve`,
`unapprove`, `input`, `pause`, `resume-from-pause`, `revive`, `settle`,
`cancel`, `run-recurring`. `input` is the ONLY way text reaches a task (draft
appends to the description, settled auto-revives + wakes, a review gate treats
it as the review response, idle wakes through the queue, busy accumulates).
`settle` finishes without an error (Completed), `cancel` settles with
`{ error: 'Cancelled by user' }` (Failed); both close a live input session and
kill the task's agent trees first (`killTaskRuntimes` dep, wired in index.ts),
matching POST /api/tasks/:id/{settle,cancel}. The retired v2 verbs
(`iterate` / `retry` / `resume` / `reopen` / `complete`) still resolve, but only
to an error naming their replacement, so an old client fails loudly.

**teams over connect:** `mode` is `workflow` | `conversational` only, on read
and on write. Legacy stored values (`regular` / `realtime`) are still read via
`normalizeTeamMode`, never emitted, and rejected on the wire with the
replacement named. `unified_mode` is gone. `teams/list` is unified: every
visible team is pickable regardless of mode (a team's mode is only the
autopilot default for new tasks on it), and any task-type/mode filter param is
ignored.

**paging cursors (mobile "load older"):** `outputs/list` takes `beforeId` (a row `id`; rows are
newest-first, `limit` cap 100), `messages/list` takes `limit` (default 50, cap 500) + `before`
(a `createdAt`), `timeline/list` takes `before` (a `createdAt`). Each returns the window
older than the cursor. Stored output rows are ≤32KB each (see
[../agents/CLAUDE.md](../agents/CLAUDE.md) terminal output storage).

**operator input timeline:** `timeline/list` (params `taskId`, optional `limit`,
default 200, capped 1000, optional `before`) returns the task's `realtime_timeline` rows as
`TimelineEntryItem` projections, oldest first:

```
{ id, taskId, entryType, content, fedToSkipper, createdAt }
```

`entryType` is `text` (typed composer input, a "You" card), `summary` (a
transcribed audio digest, an "Audio" transcript card), `error` (a quiet
input-pipeline line), or `image` / `file` (a file artifact: `content` is the
caption, else the filename, and the item carries `artifact?: { id, name,
version, kind, storage, mime, bytes, width, height, sha256, source, authorName }`
- metadata only, bytes via `artifacts/read-bytes`) - the same presentations the
web timeline fragment renders. `source` is `operator` / `connect:<clientId>` for
an operator upload, else the id of the agent that attached the file with
`create_file_artifact`; `authorName` is that agent's display name (null for
operator sources). Clients label the card with `authorName` when present, else
"You". An agent-attached entry arrives with `fedToSkipper: true` (it is the
agent's output, never queued input). `fedToSkipper: false` means the entry has not reached the agent yet, so
clients tag it "queued for agent". An unknown task returns an empty list, like
`notes`/`messages`. Over `limit` the newest entries win (the query takes the
newest rows, then flips to oldest-first).

`realtime:timeline_updated` is a fat event: the bus payload
(`{ taskId, entryId, entryType }`) plus an `entry` field carrying the inserted
row's projection, so clients append without refetching. `connect:capabilities`
lists the `timeline` feature.

**realtime input:** `clientId` names the owner of the single-writer recording
lock, so it is required for `acquire`, `release` and audio `ingest` only. A
`format: 'text'` ingest is sessionless and needs no `clientId`.

## File artifacts (operator uploads)

`connect:capabilities` lists the `artifact_files` feature. `artifacts/list`,
`artifacts/read` and the fat-event artifact projection (`fetchArtifactItem`)
carry `storage` (`inline` | `file`), `mime`, `bytes`, `width`, `height`,
`sha256`, `source` (file artifacts: `operator` / `connect:<clientId>` or the
attaching agent's id; null for inline rows); a `storage: 'file'` artifact never
ships a `body` (its `description` is the caption). Actions on the `artifacts` resource:

| action | params | result |
|---|---|---|
| `upload-begin` | `{ taskId, name, mime?, bytes, sha256, description?, clientId? }` | `{ uploadId, chunkBytes }` - size (25 MB cap), mime and sha256 shape checked here; source recorded as `connect:<clientId>` |
| `upload-chunk` | `{ uploadId, index, data }` (base64, <= 256 KB decoded, sequential `index` from 0) | `{ received }` |
| `upload-commit` | `{ uploadId }` | `{ artifact, entry, delivered }` - verifies size + sha256, creates the kind `upload` file artifact, then `ingestArtifactUpload` puts it on the task's timeline with the same wake semantics as `tasks/input`; `artifact` is the `ArtifactItem` projection, `entry` the `TimelineEntryItem` (with `artifact` ref) |
| `upload-abort` | `{ uploadId }` | `{ aborted }` |
| `read-bytes` | `{ id, offset?, length? }` (length <= 512 KB) | `{ id, mime, bytes (total), offset, length, data (base64) }` |

Sessions are in-memory on the daemon and expire after 2 idle minutes. The
integrator scope map (`skipper-connect/src/protocol.ts`) puts `upload-*` under
`artifacts:write` and `read-bytes` under `artifacts:read`. Protocol version stays 3.

## Public artifact links

Artifact versions can be published: `task_artifacts.publish_key` (stable per version) + `published_at`. The integrator serves `GET /p/:guid/:artifactId?key=...` unauthenticated and relays `artifacts.read-published` to the daemon, which validates the key. Spec for the integrator side: [docs/connect-public-artifacts.md](../../docs/connect-public-artifacts.md).
