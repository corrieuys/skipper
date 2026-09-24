# src/glyph

**Canvas** in the UI (button, overlay, config row); `glyph` in code, after the
protocol it speaks. Experimental, `--experimental` only. A side model, the
**renderer agent**, reads what a task's agents wrote (notes, operator messages,
artifacts, escalations), deduces decisions / open questions / what needs the
operator, and keeps ONE full-screen, one-way screen per task up to date. The
screen is a compact UI-tree string in the glyph protocol
(`~/Repositories/glyph-ui/PROTOCOL.md`); the browser animates between frames by
node id. Opened from the **Glyph** button in the task header.

| file | use |
|---|---|
| `protocol.ts` | Vendored glyph protocol: `parseFrame`, `parseOps`, `serializeNode`, `Tree` (atomic `applyOps`). Byte-compatible with the plain-JS port in `html/public/glyph.js`; keep both in step |
| `screen.ts` | `GlyphScreen` — one `Tree` per task. `render(frame, validate?)` / `patch(ops, validate?)` (returns `#x` refresh ids) / `clear()`; `view(resolve)` serializes a copy with `w` texts rewritten to URLs (what the browser gets). `assertOneWay` rejects `B`/`i` nodes and `>action` props (the screen is read-only; `w` web views are allowed) and, like a failing validator, rolls the tree back |
| `artifact-view.ts` | `artifactViewDocument(name, body, format)`: the page `/api/artifacts/:id/view` serves for an inline artifact. Markdown renders client-side through marked with the same options as the app's `[data-artifact-md]` blocks (escaped source as the fallback); a full html document is served untouched; an html fragment gets the same shell. The shell copies the overlay's `--sk-*` tokens from the parent frame (same origin) so it follows the selected theme, with a light/dark fallback outside the overlay |
| `store.ts` | `glyph_screens` row per task (migration `0026`): frame, register cursor, model session id, call count, task-summary fingerprint. `loadGlyphScreen` / `saveGlyphScreen` / `deleteGlyphScreen`. Written by the engine after every successful command and every consumed delta; deleted on Reset and with the task |
| `sources.ts` | `w` sources: `resolveGlyphSource(db, taskId, text)` turns `artifact:<name>` (latest version; image file → `/api/artifacts/:id/file?glyph=image`, other file → `/file`, inline → `/api/artifacts/:id/view`), an absolute or `~/` path (must be an existing file inside the task's working directory or its artifact store → `/glyph-local/<taskId>/<abs path>`) or an `https:` url into a URL, else throws a model-facing `ProtocolError`. `resolveAllowedFile` is the containment check the local route reuses |
| `renderer.ts` | Pure half of the agent: `buildWakeMessage(delta, currentFrame, {firstWake, lastError})` (task header, current screen, the delta per register, caps + sanitization) and `parseGlyphReply(text)` → `RENDER` / `PATCH` / `NOOP` |
| `engine.ts` | `GlyphEngine` — the loop. Bus events → per-task debounce → `fetchGlyphDelta` → one-shot model call (`agents/oneshot.ts`, session resumed, `/compact` every 15 calls on claude) → apply → `broadcastJson("updated","glyph",taskId,payload,["glyph:<taskId>"])`. `open(taskId)` / `status` / `reset` back the routes. Runner is injectable (`GlyphModelRunner`) so tests never spawn a CLI |

## Why event-driven, gated, delta-only

- **No polling.** Wakes come from `task:note_added`, `task:message_posted`,
  `artifact:created`, `escalation:created/resolved`, `task:phase_changed`,
  `task:needs_review_changed`, `task:state_changed`, `task:run_completed/failed`,
  `realtime:timeline_updated` (operator input: typed text, audio transcripts or
  their summaries).
  Debounced 3s per task.
- **No overlay, no calls.** `requestWake` checks
  `uiPush.hasJsonClients(["glyph:<taskId>"])`, again when the debounce timer
  fires; `open`/`reset` force one wake because the socket may not be connected
  yet.
- **Resume, not restart.** Screen, model session, cursor and resolved sources
  live in memory per task and are mirrored to `glyph_screens` after every
  change. Closing the overlay or switching tasks changes nothing; reopening
  returns the same screen at once and runs a catch-up wake (no model call when
  nothing landed). After a daemon restart the first touch of a task restores
  the row (`engine.ts:restore`): the overlay shows the last screen immediately,
  the first wake carries only the delta since the persisted cursor plus a
  RESTORED note telling the model the screen is the state of record, and the
  stored claude session is resumed; if that session no longer answers, one
  retry runs as a fresh session with the description. Only Reset starts a task
  from scratch. There is no load tool for the model: the screen is in every
  wake already.
- **Deltas, not snapshots.** `data/glyph.ts` cursors are rowids per register;
  the resumed session carries the prior deductions. The cursor advances only
  when the model actually answered (a provider failure re-sends the delta). A
  wake with nothing new and an unchanged task summary is skipped without a call.
- **Never raw terminal output.** Only the curated registers. Operator input
  (`realtime_timeline` text/transcript/summary rows) is fed as its own register,
  labelled as the human talking TO the agents: the prompt tells the renderer it
  is instructions and questions, never task state, and that it must not answer
  for the agents. Only notes/messages/artifacts/escalations move the screen's
  decided/progress/results content. If screens end up
  thin, feed the assistant prose (`ws/dashboard-activity.ts` `kind:"message"`)
  before ever considering tool frames.

## Contract with the model

System prompt: `prompts/glyph.md`: the glyph-ui skill nearly verbatim (protocol,
content-to-structure table, transitions, anti-patterns) minus tools/events/buttons,
plus a short Skipper section (what to deduce, open-escalation and review facts,
keeping the screen current: retire transient items, reshape with move/swap as
content changes; summarise text artifacts into cards rather than embedding
them, a page view of a document is for finished work). Images and html
artifacts are the visual exception and are shown in `w` views. Only `ra`/`cb`/`hc`/`td` are asked to stay stable; the rest of
the layout is the model's. A literal `\n` in a command is normalised to a
newline (`renderer.ts:unescapeNewlines`) because a plain-text channel has no
JSON decoding. Reply: one ```glyph block with `RENDER <frame>`, `PATCH <ops>`
or `NOOP`. A rejected command (no command, parse error, protocol error, one-way
violation) is fed back with the delta stripped (the session already has it):
`renderer.ts:describeRejection` gives the attempt count, the error, a caret at the
parse offset with line/column, the command echoed, the ids currently on screen
and a hint per error class. Up to `MAX_COMMAND_ATTEMPTS` (4) per wake; after the
last the screen stays as it was and `state:"error"` carries the error line. Text fed in has `"` → `'` and `|` → `/` so it can be
pasted into a frame verbatim.

Provider + model: config page "Canvas Renderer" row (`model-settings.ts`
`getGlyphModelChoice`, default claude-code on the CLI's default model).

**Tools.** On claude the renderer gets exactly two MCP tools, `list_artifacts`
and `get_artifact` (`mcp/tools.ts:registerRendererTools`), reached over the
daemon's own `/mcp`: each call mints a per-task in-memory bearer
(`mcp/auth.ts:issueRendererToken`), writes a temp `--mcp-config` pointing at
`127.0.0.1:<port>/mcp`, runs with `--strict-mcp-config --tools "" 
--setting-sources "" --allowedTools <the pair> --dangerously-skip-permissions
--max-turns 12`, then revokes the token and deletes the file. `get_artifact`
returns the full body (never truncated) and an image artifact as the image.
The wake message inlines an artifact body in full up to 6000 chars, above that
it states the size and tells the renderer to read it with the tool; notes,
messages and inputs are inlined whole. Other providers run tool-less. 180s
timeout.

## Surfaces

- Routes (`routes/glyph.ts`): `POST /api/tasks/:id/glyph/open`, `GET
  /api/tasks/:id/glyph`, `POST /api/tasks/:id/glyph/reset`, plus what `w` nodes
  load: `GET /api/artifacts/:id/view` (inline artifact as a page: html verbatim,
  markdown/text in a `<pre>`) and `GET /glyph-local/:task/<abs path>` (a file under
  the task's working directory or artifact store; path-style so a prototype
  page's relative assets resolve). 404 without the flag.
- Web: `html/public/glyph.js` (`Skipper.glyph.open/close/reset`) opens
  `#tc-glyph-modal`, POSTs open for the current frame, and connects its own
  JSON socket `/ws/ui?format=json&topics=glyph:<id>` (topic-scoped, so it does
  not get the dashboard snapshot). Payloads: resource `glyph` `{t, s, frame}`
  (apply `s`, resync from `frame` on any error), `glyph:status` `{state, error}`
  (only an error surfaces in the bar) and `glyph:agents` `{active}` (running +
  pending instances on the task, pushed on `instance:state_changed`; the bar's
  status slot shows "N agents active" with a pulsing dot, or "No agents active"). Payload frames are the resolved **view** (URLs), never the
  model's source texts; `w` renders as `<img>` when the URL carries `?glyph=image`,
  else a sandboxed `<iframe>`; `refresh: [ids]` on a payload reloads those views.
  Every node whose content, type or source changed in a commit, and every new
  node, gets `.gl-fresh` for ~1.1s: its own border takes a dim tint of the
  secondary accent and fades back (border only, no outline/wash/pseudo-element,
  so it sits on the element's box; deliberately faint and short; distinct from
  the model's `!` emphasis ring); skipped on the first commit after opening. The
  screen never scrolls: no container has a scrollbar (overflow hidden); after
  each commit `fitToStage` finds the worst content-vs-slot ratio over every
  container, zooms the stage down by it (CSS `zoom`, so FLIP rects stay
  consistent), and reports the factor to
  `POST /api/tasks/:id/glyph/viewport`; a factor under 0.97 puts a SCREEN
  OVERFLOWS note in the next wake so the renderer cuts content.
  Styles in `html/styles/glyph.ts` (`gl-n-<type>` per node):
  every colour, radius and font is a `--sk-*` token and card containers carry
  `.sk-panel` (set by glyph.js), so each theme's panel rules restyle the screen
  with no glyph-specific CSS. Esc closes, `i` toggles id chips. The bar shows the Skipper logo and, on an
  active task, the task composer (text `POST /api/tasks/:id/input` + Record/Stop
  mirrored from `realtime-audio.js` via `data-rt-start`/`data-rt-stop`/`data-rt-status`),
  so the operator keeps steering with the canvas open.
- The frame string is style-free; a native renderer in the Apple/Android
  clients could subscribe to the same topic later.

State is in memory only: a daemon restart empties every screen and session; the
next open re-reads the task from scratch (first wake includes the description).
