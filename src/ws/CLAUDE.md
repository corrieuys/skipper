# src/ws

WebSocket push from server → browser. Used by dashboard polling-replacement + realtime task UI.

**UI update contract (see root [CLAUDE.md](../../CLAUDE.md)):** every state
mutation must emit a domain event so all surfaces reconcile, and a button must
update in place, never full-refresh the view. When you add a task control, add
its event handling here (targeted OOB fragment push, not a full `#mc-main`
refresh, which is guarded on real status transitions only).

Not all of the daemon's sockets live here. `types.ts:WSData` is the shared
upgrade-payload union for every one of them (all registered in `index.ts` via
`setWebSocketUpgradeHandlers` / `setWebSocketHandlers`): `ui-push` and
`realtime` in this dir, `monkey` in [../monkey/CLAUDE.md](../monkey/CLAUDE.md),
and `connect-local` - the inbound local consumer socket `GET /connect/local`
(unauthenticated, loopback only), which lives in
[../connect/CLAUDE.md](../connect/CLAUDE.md) (`local-endpoint.ts`).

| file | use |
|---|---|
| `ui-push.ts` | `UIWebSocketManager` — broadcast fragment refreshes + notifications. Dual-format socket: `/ws/ui` (htmx OOB HTML) and `/ws/ui?format=json` (`broadcastJson` envelope `{event, resource, id, data, timestamp}` for machine clients). Both formats honor topic subscriptions. **JSON clients subscribed to `dashboard` (or to nothing) get a one-shot `dashboard:snapshot` on connect** (`buildDashboardSnapshotMessage`: tasks/instances/metrics/phase_indicator/activity) so they hydrate without a REST read — the terminal dashboard (`src/tui`) relies on this; a topic-scoped JSON socket (the glyph overlay on `glyph:<taskId>`, pushed by `src/glyph/engine.ts` as resource `glyph` / `glyph:status`) skips it. `hasJsonClients(topics)` is the public gate out-of-file pushers use before doing expensive work. Live JSON push `dashboard:activity` (parsed output feed incl. notes, debounced on `agent:output` + on `task:note_added`); `dashboard:phase-indicator` already carries `{task}`. **Activity feed is poke-driven:** on `agent:output` the v2 task view gets a tiny OOB `#mc-activity-poke-<taskId>` element (`pushV2ActivityPoke`), never a re-rendered feed; `skipper.js` fetches `/activity?after=<newest row id on screen>` and prepends. Heavy debounced renders (`pushLogEntries` 1000 rows, `pushRecentActivity`, `pushDashboardActivity`) skip their queries when no socket is subscribed to the topic (`hasClients`) |
| `dashboard-activity.ts` | `buildDashboardActivity` — recent agent stdout parsed to `{agent, kind:message\|tool\|event, text}` via `summarizeTerminalLine` (the pure classify+summarize step in `src/html/terminalJsonSummary.ts`, shared with the TUI's per-task output tail), **merged with `task_notes` as `kind:"note"`** (interleaved by time), JSON-shaped for the TUI output feed. Web feed's classify logic minus HTML; drops noise (rate_limit / system-hook / unparseable) instead of dumping raw JSON |
| `fragment-registry.ts` | Map fragment keys → render fn for diff push |
| `types.ts` | Shared event payload types |
