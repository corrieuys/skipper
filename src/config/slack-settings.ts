import type { Database } from "bun:sqlite";
import { getBoolSetting, getStringSetting, setBoolSetting, setStringSetting } from "./app-settings";

// Slack app integration — machine-scoped credential + defaults.
//
// The bot token (xoxb-) authenticates the Skipper Slack app so messages post
// AS the app, not as the operator. Stored plaintext in the runtime app_settings
// table because it must be replayed on every Slack Web API call. Per-team opt-in
// (whether a team's agents actually get the Slack MCP tools) lives on the team
// record — see `isSlackEnabledForTeam` in ../teams/local-teams.ts.
export const SETTING_SLACK_BOT_TOKEN = "slack_bot_token";
export const SETTING_SLACK_DEFAULT_CHANNEL = "slack_default_channel";
// Socket Mode (inbound slash commands): the app-level token (xapp-) authenticates
// `apps.connections.open`, distinct from the bot token. The enable flag gates the
// long-lived socket. The allowlist is a JSON array of Slack user ids (U…) permitted
// to trigger actions — an empty list denies everyone (fail closed).
export const SETTING_SLACK_APP_TOKEN = "slack_app_token";
export const SETTING_SLACK_SOCKET_ENABLED = "slack_socket_enabled";
export const SETTING_SLACK_ALLOWED_USERS = "slack_allowed_users";
// Outbound push (escalations + phase reviews) has no dedicated toggle: it is
// scoped to each task's origin thread (or the default channel for UI-created
// tasks) and gated per-team by `slackEnabled`. The former `slack_push_enabled`
// switch was removed as redundant — the per-team opt-in is the control.

export interface SlackConfigView {
  // Presence indicators only — the tokens themselves are never echoed back to the UI.
  botTokenSet: boolean;
  defaultChannel: string;
  appTokenSet: boolean;
  socketEnabled: boolean;
  allowedUsers: string[];
}

export function getSlackBotToken(db: Database): string {
  return getStringSetting(db, SETTING_SLACK_BOT_TOKEN, "");
}

export function getSlackDefaultChannel(db: Database): string {
  return getStringSetting(db, SETTING_SLACK_DEFAULT_CHANNEL, "");
}

export function getSlackAppToken(db: Database): string {
  return getStringSetting(db, SETTING_SLACK_APP_TOKEN, "");
}

export function isSlackSocketEnabled(db: Database): boolean {
  return getBoolSetting(db, SETTING_SLACK_SOCKET_ENABLED, false);
}

/** Parsed allowlist of Slack user ids. Junk/missing → []. */
export function getSlackAllowedUsers(db: Database): string[] {
  const raw = getStringSetting(db, SETTING_SLACK_ALLOWED_USERS, "");
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  } catch {
    return [];
  }
}

/** Fail-closed authorization: only ids on the allowlist may trigger actions. */
export function isSlackUserAllowed(db: Database, userId: string): boolean {
  if (!userId) return false;
  return getSlackAllowedUsers(db).includes(userId);
}

/** A bot token is present, so Slack calls can authenticate. */
export function isSlackConfigured(db: Database): boolean {
  return !!getSlackBotToken(db);
}

/** Both credentials Socket Mode needs are present (bot token + app-level token). */
export function isSocketModeConfigured(db: Database): boolean {
  return isSlackConfigured(db) && !!getSlackAppToken(db);
}

export function getSlackConfigView(db: Database): SlackConfigView {
  return {
    botTokenSet: isSlackConfigured(db),
    defaultChannel: getSlackDefaultChannel(db),
    appTokenSet: !!getSlackAppToken(db),
    socketEnabled: isSlackSocketEnabled(db),
    allowedUsers: getSlackAllowedUsers(db),
  };
}

/** Parse a free-text list of Slack user ids (comma / whitespace / newline separated). */
export function parseAllowedUsersInput(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Persist the Slack credentials + Socket Mode config. Returns an error string on
 * validation failure, or null on success. An empty `botToken`/`appToken` leaves
 * the saved value untouched (so the UI can submit the form without re-entering a
 * secret).
 */
export function saveSlackConfig(
  db: Database,
  input: {
    botToken: string;
    defaultChannel: string;
    appToken?: string;
    socketEnabled?: boolean;
    allowedUsers?: string[];
  },
): string | null {
  const botToken = input.botToken.trim();
  if (botToken && !botToken.startsWith("xoxb-")) {
    return "Bot token must start with 'xoxb-' (a Bot User OAuth Token).";
  }
  const appToken = (input.appToken ?? "").trim();
  if (appToken && !appToken.startsWith("xapp-")) {
    return "App-level token must start with 'xapp-' (needed for Socket Mode).";
  }
  if (botToken) setStringSetting(db, SETTING_SLACK_BOT_TOKEN, botToken);
  setStringSetting(db, SETTING_SLACK_DEFAULT_CHANNEL, input.defaultChannel.trim());
  if (appToken) setStringSetting(db, SETTING_SLACK_APP_TOKEN, appToken);
  if (input.allowedUsers !== undefined) {
    setStringSetting(db, SETTING_SLACK_ALLOWED_USERS, JSON.stringify(input.allowedUsers));
  }
  if (input.socketEnabled !== undefined) {
    setBoolSetting(db, SETTING_SLACK_SOCKET_ENABLED, input.socketEnabled);
  }
  return null;
}
