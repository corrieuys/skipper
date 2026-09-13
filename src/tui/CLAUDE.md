# src/tui

Interactive full-screen terminal dashboard ("Skipper bridge"). Launched by
`skipper dashboard` (alias `tui`) from [bin/cli.ts](../../bin/cli.ts) — a
foreground CLI process that attaches to a **running daemon** on this machine and
gives the operator the whole task surface: create/edit tasks, import teams from
JSON, pause/resume/approve/cancel/settle/revive/delete, star, autopilot, memory,
icon, send input, answer escalations, approve/reject review gates, run recurring
tasks, browse/export/delete teams, plus live activity indicators (animated
status glyphs, agent orbs, phase strips, a global live feed and a per-task output
tail). Everything reconciles from daemon events; no polling, no manual refresh.

## Why a client, not in the daemon

The daemon is spawned detached (no controlling terminal), so the TUI cannot live
inside it. It runs in the `skipper dashboard` process and consumes the daemon
over the network — exactly like the web UI and the native apps.

## Servers: local daemon or a Skipper Connect remote

`skipper dashboard` opens a picker (`startup.ts`): the local daemon plus every
saved remote; `a` adds one (name, integrator URL, integrator key), `d` deletes.
`--local` / `--server <name>` skip the picker. Inside the app `@` opens the
same list: switch live (fresh store + transport, no alt-screen exit), add or
delete a remote. Saved in `<data dir>/dashboard-servers.json`
(mode 0600; holds the keys). `servers.ts` owns the store + the pure URL
builders: local → `ws://127.0.0.1:<port>/connect/local`; remote →
`wss://<integrator>/connect?token=<key>` plus `Authorization: Bearer` (the same
recipe as the Apple apps' `ServerConfig.socketURL`). A 4001 close from the
worker is a permanent key failure: the transport stops reconnecting and the
header shows the error.

The transport advertises `capabilities()`; the UI degrades on a remote:

| capability | local | remote |
|---|---|---|
| global live feed column + roster lane (`/ws/ui`) | yes | no: feed column hidden, roster rebuilt from `instance:state_changed` fat events (name = template id tail) |
| team import/export | loopback HTTP routes, full shape (skipper_prompt, hooks, config) | `teams/create` / `teams/update` / `teams/list-all` over Connect: name, phases, agents, mode only (the form says so) |
| edit an active/settled task | loopback `POST /api/tasks/:id/update` | `tasks/update` (daemon refuses non-drafts) |
| `w` open in web UI | yes | hidden |

## Data + writes: the Connect consumer protocol

The transport speaks to two loopback sockets, both unauthenticated by design
(the daemon is loopback-bound; the local web UI has no auth either):

| socket | carries |
|---|---|
| `GET /connect/local` ([src/connect/local-endpoint.ts](../connect/local-endpoint.ts)) | the same consumer protocol the Mac/iOS apps use: `state/snapshot` hydration, **fat events** (`task:*`, `escalation:*`, `task:note_added`, `task:message_posted`, `realtime:timeline_updated`, `artifact:*`, `instance:state_changed`), every `request` write action (`tasks/*`, `teams/*`, `reviews/*`, `escalations/*`, `notes/create`, `recurring/*`), and the `subscribe outputs` live tail for the selected task |
| `GET /ws/ui?format=json&topics=dashboard` ([src/ws/ui-push.ts](../ws/ui-push.ts)) | the dashboard lanes the web UI already pushes: live agent roster (`dashboard:instances`), the summarized global activity feed (`dashboard:activity`, notes folded in), header metrics |

Team import/export go over plain loopback HTTP (`POST /api/teams/import`,
`GET /api/teams/export`) because that route already understands the full
round-trippable export shape (id/skipper_prompt/hooks/config; same id = update).

Live output lines are classified + summarized client-side with
`summarizeTerminalLine` from [src/html/terminalJsonSummary.ts](../html/terminalJsonSummary.ts),
the same pure pipeline `dashboard-activity.ts` uses for the web feed, so the two
feeds always agree.

## Layers

```
transport ─► store ─► renderer (Screen cell buffer, diff paint)
     ▲                    ▲
   input (KeyDecoder) ────┘   controller (run.ts) wires them + owns ui state/actions
```

| dir/file | role |
|---|---|
| `run.ts` | Controller/entry. Server resolve (`--server`/picker), local health-check, wires transport→store→renderer, key routing (modal › composer › search › global nav › action registry), per-task bundle loads (`tasks/read` + notes/messages/timeline/artifacts in parallel, 60s stale), one output-tail subscription at a time, coalesced repaint + 8 fps animation heartbeat, toasts, shutdown |
| `servers.ts` | Saved server list (local + Connect remotes), `dashboard-servers.json` IO, pure socket/HTTP URL builders |
| `startup.ts` | Pre-flight server picker on the normal screen (add/delete remotes) |
| `model/types.ts` | Domain shapes (mirror Connect v3 projections) + `TransportEvent`. TUI never imports server types |
| `model/store.ts` | World state: tasks/escalations by id patched from fat events; per-task `TaskBundle` (detail, notes, messages, timeline, artifacts, capped live output); roster/activity/metrics lanes; `version` counter |
| `transport/types.ts` | `Transport` interface: `start/close/resync`, `request(resource, action, params)`, `subscribeOutputs`, `importTeams`, `exportTeams` |
| `transport/local.ts` | `LocalTransport(server)` for local AND remote targets (Connect socket + optional dashboard socket, reconnecting with backoff, request/response correlation with timeouts, re-snapshot + re-subscribe on reconnect) + the wire→domain mappers (`mapConnectEvent`, `parseDashboardFrame`, `toTask`…) |
| `ui/state.ts` | `UIState` (focus, filter, search, selection, tabs, scroll, composer, modal stack, toasts, cached teams/recurring) + modal types (`form`, `confirm`, `list`, `text`) |
| `ui/actions.ts` | The action registry: every operator action with its key, availability predicate and runner, plus the modal builders (task form, recurring form, import, teams browser, review/escalation forms, icon picker, palette, help). Footer hints + palette + key bindings all derive from this one list |
| `ui/view-model.ts` | Pure selectors: rail rows per filter/search/sort, conversation merge (timeline + messages + notes + escalations by time), time helpers, sparkline buckets |
| `ui/hints.ts` | Footer hint strings per context |
| `render/screen.ts` | Cell buffer with styles, wide-char safe `put/text/box/fill/restyle`, `wrap/clip/pad`, and `diff(prev)` → minimal ANSI |
| `render/renderer.ts` | `Renderer` (Screen per frame, diff paint, cursor placement) + `drawFrame` (header, rail, feed, footer, toasts, modals). Pure and unit-tested |
| `render/detail.ts` | The main pane: title/status pill, meta, phase strip + names, agent orbs, escalation/review banners, tabs (timeline / activity / notes / artifacts / details, named as in the web UI; internal ids stay conversation/output/info), composer. Timeline and Activity are bottom-anchored (newest at the bottom, live); Notes and Artifacts are newest-first, top-anchored |
| `ui/plain-text.ts` | `htmlToText` / `toPlainText` / `toOneLine`: agent-authored HTML (escalations, messages, notes, artifact bodies) rendered as terminal text (bullets, backticks, links); markdown passes through |
| `render/widgets.ts` | Shared drawing helpers: panel, pills, phase strip, sparkline, scrollbar, key hints, dim backdrop, shadow |
| `render/layout.ts` | **Pure** size→rects: `triple` (rail / detail / feed, ≥150 cols), `double` (≥96), `single` (Tab switches views). Modal centering |
| `render/theme.ts` | 256-colour palette, status colours/labels/glyphs, animation frame sets, brand ramp, agent colours |
| `render/terminal.ts` | The only file touching stdout/stdin: alt screen, raw mode, **bracketed paste**, resize, cursor |
| `input/keyboard.ts` | `KeyDecoder`: raw bytes → `KeyEvent[]` (chars, ctrl, CSI/SS3 keys with modifiers, alt+char, multi-key chunks, bracketed paste → one `paste` event) |
| `input/text-editor.ts` | `TextBuffer`: grapheme-aware single/multi-line editing (word ops, kill line, vertical moves, soft-wrap view with caret mapping) |

## Keys (summary; `?` in the app has the full list)

`1-6` filters · `↑↓ jk` select/scroll · `tab` focus · `[ ]` detail tabs · `/` search · `o` hide feed
`n` new · `ctrl+n` new recurring · `e` edit (any status) · `a` approve · `u` unapprove · `p` pause/resume
`s` star · `A` autopilot · `m` memory · `c` icon · `+` note · `i` input · `S` settle · `x` cancel · `v` revive · `D` delete
`y`/`N` review approve/reject · `E` escalation · `T` teams · `I` import team · `R` run recurring · `@` servers · `:` palette · `?` help · `q` quit
`enter` on the Artifacts tab opens the selected artifact (inline bodies shown as text; files show metadata)

## Conventions

- **New tasks are followed.** A `task:created` (or a draft starting) selects the new task and switches the filter to show it, unless a modal, the composer or the search is active. Answered escalations stay in the conversation (`escalations/list status=resolved`, narrowed by task).
- The task form carries the audio settings (`Transcript summary` global/on/off, `Audio chunk seconds`) which map to Connect `summaryEnabled` / `windowSeconds`; a raw transcript arrives as a `transcript` timeline entry (shown as `you ⟨transcript⟩`).
- **A mutation never refreshes the view.** Actions send the request and let the
  fat event patch the store; the reply is only used for the toast. Same contract
  as the web/native clients (root CLAUDE.md, UI update contract).
- New operator action → add one entry to `ACTIONS` in `ui/actions.ts`. Footer
  hints, palette and key dispatch pick it up. Needs a Connect verb the daemon
  lacks → add it to `src/connect/resources.ts` first (and emit a fat event).
- New key sequence → `input/keyboard.ts` only. New colour/glyph → `render/theme.ts`.
- Pure layers (`screen`, `layout`, `renderer.drawFrame`, `store`, `view-model`,
  `keyboard`, `text-editor`, `servers`, wire mappers) are unit-tested without a
  TTY; the controller is exercised against a live daemon (`tmux` + `capture-pane`
  works). A remote can be exercised with a tiny fake integrator that checks
  `?token=` and proxies frames to the local `/connect/local`.

## Compiled binary

Pure TS, no native deps, so `bun build --compile` bakes it in. Nothing here is a
runtime-read asset, so no `gen-assets` rule is needed.
