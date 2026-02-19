# src/ws

WebSocket push from server → browser. Used by dashboard polling-replacement + realtime task UI.

| file | use |
|---|---|
| `ui-push.ts` | `UIWebSocketManager` — broadcast fragment refreshes + notifications |
| `fragment-registry.ts` | Map fragment keys → render fn for diff push |
| `types.ts` | Shared event payload types |
