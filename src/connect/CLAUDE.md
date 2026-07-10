# src/connect

Skipper Connect: outbound WebSocket from the daemon to a remote integrator service. The operator must supply the remote URL; there is no built-in default. The integrator remote-controls this instance over the socket; the daemon never exposes an inbound connect endpoint. Credentials (key + URL) live in runtime `app_settings` (see `src/config/app-settings.ts`); connect stays disabled until both are set. The instance global id (gid) is not stored: it is derived from the connect key's JWT payload via `gidFromConnectKey()` in `public-links.ts` (unverified decode; the integrator is authoritative and routes by the gid it verifies itself).

| file | use |
|---|---|
| `client.ts` | `ConnectClient` - WS connect/auth/reconnect w/ backoff, dispatches `command`/`request`/`output_subscribe` frames |
| `protocol.ts` | `ClientMessage`/`ServerMessage` frame types, `CONNECT_TOOLS`, `CONNECT_PROTOCOL_VERSION` (v2), entity projections (`TaskListItem` etc.), `StateSnapshot` |
| `commands.ts` | `command` frame handlers (create/delete/approve task etc.) |
| `resources.ts` | `request` frame handlers: tasks (incl. `create` with optional `taskType`), teams (`list` - light id/name/goal/phase_count projection for the remote create-task picker), escalations, reviews, notes, artifacts, outputs, state (`snapshot` - one-shot store hydration for the web app), webhooks (`trigger` - public static-URL trigger for recurring tasks; validates `scheduled_tasks.webhook_key` timing-safe, then `runWebhookTask` with the payload as run input; per-task leading-edge debounce (`webhook_debounce_minutes`, floor 1) ignores webhooks inside the window with a "Debounced" error, ignored webhooks restamp the window; opaque error for bad key/id, no enumeration). Artifact actions include `publish`/`unpublish`/`read-published` (public links) |
| `events.ts` | Forward domain events as **fat events**: payload keeps the bus shape plus the changed entity's projection (task/escalation/note/artifact) so integrators patch a local store without refetching. Coalesces `delegation_group:progress` (500ms/group). Sends `connect:capabilities` on subscribe |
| `serializers.ts` | Entity projections shared by events + snapshot. Never ship heavy fields (result, orchestration_state, bodies) |
| `output-tail.ts` | `OutputTailManager` - live agent output as coalesced `output_batch` frames, only while the server reports a subscribed consumer (`output_subscribe`/`output_unsubscribe`). Detached from bus when idle |
| `public-links.ts` | Build public artifact URLs (`https://<integrator>/p/<gid>/<artifactId>?key=...`) and webhook trigger URLs (`.../wh/<gid>/<scheduledTaskId>?key=...`); gid decoded from the connect key |

## Public artifact links

Artifact versions can be published: `task_artifacts.publish_key` (stable per version) + `published_at`. The integrator serves `GET /p/:guid/:artifactId?key=...` unauthenticated and relays `artifacts.read-published` to the daemon, which validates the key. Spec for the integrator side: [docs/connect-public-artifacts.md](../../docs/connect-public-artifacts.md).
