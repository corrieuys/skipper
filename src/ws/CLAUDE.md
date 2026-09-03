# src/ws

WebSocket push from server → browser. Used by dashboard polling-replacement + realtime task UI.

| file | use |
|---|---|
| `ui-push.ts` | `UIWebSocketManager` — broadcast fragment refreshes + notifications. Dual-format socket: `/ws/ui` (htmx OOB HTML) and `/ws/ui?format=json` (`broadcastJson` envelope `{event, resource, id, data, timestamp}` for machine clients). Both formats honor topic subscriptions. **JSON clients get a one-shot `dashboard:snapshot` on connect** (`buildDashboardSnapshotMessage`: tasks/instances/metrics/phase_indicator/activity) so they hydrate without a REST read — the terminal dashboard (`src/tui`) relies on this. Live JSON push `dashboard:activity` (parsed output feed incl. notes, debounced on `agent:output` + on `task:note_added`); `dashboard:phase-indicator` already carries `{task}`. **Activity feed is poke-driven:** on `agent:output` the v2 task view gets a tiny OOB `#mc-activity-poke-<taskId>` element (`pushV2ActivityPoke`), never a re-rendered feed; `skipper.js` fetches `/activity?after=<newest row id on screen>` and prepends. Heavy debounced renders (`pushLogEntries` 1000 rows, `pushRecentActivity`, `pushDashboardActivity`) skip their queries when no socket is subscribed to the topic (`hasClients`) |
| `dashboard-activity.ts` | `buildDashboardActivity` — recent agent stdout parsed to `{agent, kind:message\|tool\|event, text}` via `terminalJsonSummary`, **merged with `task_notes` as `kind:"note"`** (interleaved by time), JSON-shaped for the TUI output feed. Web feed's classify logic minus HTML; drops noise (rate_limit / system-hook / unparseable) instead of dumping raw JSON |
| `fragment-registry.ts` | Map fragment keys → render fn for diff push |
| `types.ts` | Shared event payload types |
