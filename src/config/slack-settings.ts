import type { Database } from "bun:sqlite";
import { getStringSetting, setStringSetting } from "./app-settings";

// Slack app integration — machine-scoped credential + defaults.
//
// The bot token (xoxb-) authenticates the Skipper Slack app so messages post
// AS the app, not as the operator. Stored plaintext in the runtime app_settings
// table because it must be replayed on every Slack Web API call. Per-team opt-in
// (whether a team's agents actually get the Slack MCP tools) lives on the team
// record — see `isSlackEnabledForTeam` in ../teams/local-teams.ts.
export const SETTING_SLACK_BOT_TOKEN = "slack_bot_token";
export const SETTING_SLACK_DEFAULT_CHANNEL = "slack_default_channel";

export interface SlackConfigView {
  // Presence indicator only — the token itself is never echoed back to the UI.
  botTokenSet: boolean;
  defaultChannel: string;
}

export function getSlackBotToken(db: Database): string {
  return getStringSetting(db, SETTING_SLACK_BOT_TOKEN, "");
}

export function getSlackDefaultChannel(db: Database): string {
  return getStringSetting(db, SETTING_SLACK_DEFAULT_CHANNEL, "");
}

/** A bot token is present, so Slack calls can authenticate. */
export function isSlackConfigured(db: Database): boolean {
  return !!getSlackBotToken(db);
}

export function getSlackConfigView(db: Database): SlackConfigView {
  return {
    botTokenSet: isSlackConfigured(db),
    defaultChannel: getSlackDefaultChannel(db),
  };
}

/**
 * Persist the Slack credential + default channel. Returns an error string on
 * validation failure, or null on success. An empty `botToken` leaves the saved
 * token untouched (so the UI can submit the form without re-entering it).
 */
export function saveSlackConfig(
  db: Database,
  input: { botToken: string; defaultChannel: string },
): string | null {
  const botToken = input.botToken.trim();
  if (botToken && !botToken.startsWith("xoxb-")) {
    return "Bot token must start with 'xoxb-' (a Bot User OAuth Token).";
  }
  if (botToken) setStringSetting(db, SETTING_SLACK_BOT_TOKEN, botToken);
  setStringSetting(db, SETTING_SLACK_DEFAULT_CHANNEL, input.defaultChannel.trim());
  return null;
}
