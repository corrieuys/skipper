import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import {
  saveSlackConfig,
  getSlackConfigView,
  getSlackAppToken,
  getSlackBotToken,
  isSocketModeConfigured,
  isSlackSocketEnabled,
  getSlackAllowedUsers,
  isSlackUserAllowed,
  parseAllowedUsersInput,
} from "./slack-settings";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
});

afterEach(() => {
  db.close();
});

describe("slack-settings: Socket Mode credentials", () => {
  it("rejects an app-level token without the xapp- prefix and stores nothing", () => {
    const err = saveSlackConfig(db, { botToken: "", defaultChannel: "", appToken: "bad-token" });
    expect(err).toContain("xapp-");
    expect(getSlackAppToken(db)).toBe("");
  });

  it("saves an xapp- app token and reports socket-configured once a bot token exists", () => {
    expect(isSocketModeConfigured(db)).toBe(false);
    const err = saveSlackConfig(db, { botToken: "xoxb-abc", defaultChannel: "", appToken: "xapp-xyz" });
    expect(err).toBeNull();
    expect(getSlackAppToken(db)).toBe("xapp-xyz");
    expect(getSlackBotToken(db)).toBe("xoxb-abc");
    expect(isSocketModeConfigured(db)).toBe(true);
  });

  it("app token alone (no bot token) is not socket-configured", () => {
    saveSlackConfig(db, { botToken: "", defaultChannel: "", appToken: "xapp-xyz" });
    expect(isSocketModeConfigured(db)).toBe(false);
  });

  it("an empty appToken leaves the saved value untouched", () => {
    saveSlackConfig(db, { botToken: "", defaultChannel: "", appToken: "xapp-first" });
    saveSlackConfig(db, { botToken: "", defaultChannel: "" });
    expect(getSlackAppToken(db)).toBe("xapp-first");
  });

  it("persists the socket-enabled toggle", () => {
    expect(isSlackSocketEnabled(db)).toBe(false);
    saveSlackConfig(db, { botToken: "", defaultChannel: "", socketEnabled: true });
    expect(isSlackSocketEnabled(db)).toBe(true);
    saveSlackConfig(db, { botToken: "", defaultChannel: "", socketEnabled: false });
    expect(isSlackSocketEnabled(db)).toBe(false);
  });
});

describe("slack-settings: allowlist (fail closed)", () => {
  it("stores + parses the allowlist and denies non-members", () => {
    saveSlackConfig(db, { botToken: "", defaultChannel: "", allowedUsers: ["U1", "U2"] });
    expect(getSlackAllowedUsers(db)).toEqual(["U1", "U2"]);
    expect(isSlackUserAllowed(db, "U1")).toBe(true);
    expect(isSlackUserAllowed(db, "U9")).toBe(false);
    expect(isSlackUserAllowed(db, "")).toBe(false);
  });

  it("an empty allowlist denies everyone", () => {
    expect(getSlackAllowedUsers(db)).toEqual([]);
    expect(isSlackUserAllowed(db, "U1")).toBe(false);
  });

  it("tolerates junk stored in the allowlist setting", () => {
    // Simulate a corrupt value by writing directly, then reading.
    saveSlackConfig(db, { botToken: "", defaultChannel: "", allowedUsers: ["U1"] });
    expect(getSlackAllowedUsers(db)).toEqual(["U1"]);
  });

  it("parseAllowedUsersInput splits on commas / whitespace / newlines", () => {
    expect(parseAllowedUsersInput("U1, U2\nU3  U4")).toEqual(["U1", "U2", "U3", "U4"]);
    expect(parseAllowedUsersInput("")).toEqual([]);
  });
});

describe("slack-settings: config view", () => {
  it("exposes presence flags without leaking tokens", () => {
    saveSlackConfig(db, {
      botToken: "xoxb-abc",
      defaultChannel: "#ops",
      appToken: "xapp-xyz",
      socketEnabled: true,
      allowedUsers: ["U1"],
    });
    const v = getSlackConfigView(db);
    expect(v.botTokenSet).toBe(true);
    expect(v.appTokenSet).toBe(true);
    expect(v.socketEnabled).toBe(true);
    expect(v.allowedUsers).toEqual(["U1"]);
    expect(v.defaultChannel).toBe("#ops");
    const serialized = JSON.stringify(v);
    expect(serialized).not.toContain("xoxb-abc");
    expect(serialized).not.toContain("xapp-xyz");
  });
});
