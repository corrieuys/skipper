# src/ws

WebSocket push from server → browser. Used by dashboard polling-replacement + realtime task UI.

| file | use |
|---|---|
| `ui-push.ts` | `UIWebSocketManager` — broadcast fragment refreshes + notifications. Dual-format socket: `/ws/ui` (htmx OOB HTML) and `/ws/ui?format=json` (`broadcastJson` envelope `{event, resource, id, data, timestamp}` for machine clients). Both formats honor topic subscriptions |
| `fragment-registry.ts` | Map fragment keys → render fn for diff push |
| `types.ts` | Shared event payload types |
