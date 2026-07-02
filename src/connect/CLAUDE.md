# src/connect

Skipper Connect: outbound WebSocket from the daemon to a remote integrator service. The operator must supply the remote URL; there is no built-in default. The integrator remote-controls this instance over the socket; the daemon never exposes an inbound connect endpoint. Credentials (key + URL) live in runtime `app_settings` (see `src/config/app-settings.ts`); connect stays disabled until both are set. The instance global id (gid) is not stored: it is derived from the connect key's JWT payload via `gidFromConnectKey()` in `public-links.ts` (unverified decode; the integrator is authoritative and routes by the gid it verifies itself).

| file | use |
|---|---|
| `client.ts` | `ConnectClient` — WS connect/auth/reconnect w/ backoff, dispatches `command` and `request` frames |
| `protocol.ts` | `ClientMessage`/`ServerMessage` frame types + `CONNECT_TOOLS` list |
| `commands.ts` | `command` frame handlers (create/delete/approve task etc.) |
| `resources.ts` | `request` frame handlers: tasks, escalations, reviews, notes, artifacts, outputs. Artifact actions include `publish`/`unpublish`/`read-published` (public links) |
| `events.ts` | Forward domain events to the integrator |
| `public-links.ts` | Build public artifact URLs (`https://<integrator>/p/<gid>/<artifactId>?key=...`); gid decoded from the connect key |

## Public artifact links

Artifact versions can be published: `task_artifacts.publish_key` (stable per version) + `published_at`. The integrator serves `GET /p/:guid/:artifactId?key=...` unauthenticated and relays `artifacts.read-published` to the daemon, which validates the key. Spec for the integrator side: [docs/connect-public-artifacts.md](../../docs/connect-public-artifacts.md).
