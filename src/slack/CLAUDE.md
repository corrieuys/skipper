# src/slack

Slack app integration. Skipper posts to Slack **as its own app** (bot token
`xoxb-`), not as the operator — the alternative to the external Slack MCP that
authenticates with the user's identity.

| file | use |
|---|---|
| `client.ts` | `SlackClient` — thin Slack Web API wrapper (`chat.postMessage`, `users.lookupByEmail`, `conversations.open`, `conversations.history`, `auth.test`). Bot token read lazily from `app_settings` per call (no restart to pick up config changes) |

## Config + gating

- **Credential** (global, machine-scoped): bot token + default channel in the
  runtime `app_settings` table. Helpers: [../config/slack-settings.ts](../config/slack-settings.ts)
  (`getSlackBotToken`, `isSlackConfigured`, `saveSlackConfig`). Set on `/config`
  (experimental). Token is stored plaintext (replayed on every API call) and never
  echoed back to the UI.
- **Per-team opt-in**: a `slackEnabled` flag on the team's `team_config` JSON
  (runtime `local_teams`). `isSlackEnabledForTeam(db, teamId)` in
  [../teams/local-teams.ts](../teams/local-teams.ts).

The MCP tools `slack_send_message` / `slack_send_dm` / `slack_read_channel` are
registered on a session (`src/mcp/tools.ts`) only when **all** hold:
`isExperimental()` + `isSlackConfigured(db)` + the task's team has `slackEnabled`.
So a team without the checkbox never sees the tools. `slack_read_channel` takes an
optional time window (`oldest`/`latest`, ISO 8601 or Unix epoch seconds) and needs
a channel ID (C…).

## Required Slack bot scopes

`chat:write` (post), `im:write` (open DMs), `users:read` + `users:read.email`
(resolve a user by email for DMs), `channels:history` + `groups:history`
(read public / private channel messages).
