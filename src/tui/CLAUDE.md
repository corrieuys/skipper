# src/tui

Full-screen terminal dashboard. Launched by `skipper dashboard` (alias `tui`)
from [bin/cli.ts](../../bin/cli.ts) — a foreground CLI process that attaches to a
**running daemon**. Three panes: the **live agent OUTPUT feed** (the star) beside
a left rail of active tasks + active agents (animated spinners/cubes). Agent
notes (`create_note`) are folded into the feed as `★` entries, interleaved by
time — there is no separate notes pane. The **task phase indicator** shows both
as a header chip (`⟨phase 2/4⟩`) and a segmented strip under the focus task in the
tasks pane. A steady animation tick (~8 fps) keeps spinners/pulse/cursor moving.
Read-only today; built for the scope to grow (new layout, new render backend,
full write-interactivity over Skipper Connect) without churning the layers.

## Why a client, not in the daemon

The daemon is spawned detached (no controlling terminal), so the TUI cannot live
inside it. It runs in the `skipper dashboard` process and consumes the daemon
over the network — exactly like the web UI.

## Layers (each swappable in isolation)

```
transport ─► store ─► renderer
     ▲                    ▲
   input ────────────────┘ (controller wires them in run.ts)
```

| dir/file | role |
|---|---|
| `run.ts` | Controller/entry. Health-checks the daemon, runs the transport menu, wires transport→store→renderer, owns the input loop + coalesced repaint (≤~16 fps) + the animation heartbeat (advances `ui.frame`) + shutdown. The ONLY place the three layers meet. |
| `startup.ts` | Pre-flight transport menu (local vs connect), on the normal screen before the alt buffer. |
| `model/types.ts` | Domain + `TransportEvent` wire shapes. TUI never imports server/html types. |
| `model/store.ts` | Folds events into world state. Task/agent/message events **replace the whole collection** (the daemon sends the full active set each push), so churn needs no per-id delete tracking. |
| `transport/types.ts` | `Transport` interface. `execute?`/`resync?` are the seams for future write-interactivity; read-only transports omit them. |
| `transport/local.ts` | Reads this machine's daemon over the **open, unauthenticated** `/ws/ui?format=json&topics=dashboard` socket (loopback-bound → no API key). Snapshot on connect, live `dashboard:*` frames after, backoff-reconnect (next snapshot resyncs). |
| `transport/connect.ts` | Stub for monitoring a REMOTE instance via the Skipper Connect integrator. Throws until the integrator's client-facing API (reader auth + gid routing + state/event stream) exists — it is NOT in this repo. |
| `render/types.ts` | `Renderer` interface + `RenderModel`/`UIState`. A future ink/blessed backend implements `Renderer`; nothing else changes. |
| `render/layout.ts` | **Pure** size→rects (`computeLayout`). wide / narrow / short modes. Unit-tested; no I/O. |
| `render/terminal.ts` | The only file that touches stdout/stdin: alt screen, raw mode, resize, cell-accurate clip/pad. Zero deps — colors are plain ANSI, width via `Bun.stringWidth`. |
| `render/ansi-renderer.ts` | Built-in hand-rolled backend. Draws one fully-tiled frame (no per-frame clear → no flicker; clears once on resize). |
| `input/keyboard.ts` | Raw stdin → `KeyEvent` intents. New bindings go here only. |

## Data source (local mode)

No new REST — the daemon's `/ws/ui?format=json` already carries everything and
needs no key on loopback. The server sends a one-shot `dashboard:snapshot` on
JSON-client connect and live `dashboard:{tasks,instances,activity,phase-indicator,metrics}`
frames after (see [src/ws/ui-push.ts](../ws/ui-push.ts) —
`buildDashboardSnapshotMessage`, `pushDashboardActivity`).

- **output feed** ← `dashboard:activity`: recent parsed agent stdout across
  active work (classified message/tool/event) **plus `task_notes` merged in as
  `kind:"note"`**, interleaved by time. Built by
  [src/ws/dashboard-activity.ts](../ws/dashboard-activity.ts) (same
  `terminalJsonSummary` the web Recent Activity feed uses); pushed debounced on
  `agent:output` and on `task:note_added`. Noise frames (rate_limit, hook/system
  plumbing, unparseable JSON) are dropped, never dumped raw.
- **phase indicator** ← `dashboard:phase-indicator`: the single focus task's
  phase (`fetchDashboardPhaseIndicatorTask`), rendered as the header chip + the
  per-task strip.

## Future interactivity

When local/connect writes land: implement `Transport.execute` (mapped to the
Connect `CONNECT_TOOLS` set), add key bindings in `input/keyboard.ts`, and route
them through the controller. Local write actions will need a scoped loopback
exemption on `/data/*` (its own change + `auth.test.ts` update) — deliberately
NOT done for this read-only view.

## Compiled binary

Pure TS, no native deps, so `bun build --compile` bakes it in. Nothing here is a
runtime-read asset, so no `gen-assets` rule is needed.
