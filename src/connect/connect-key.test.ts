import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "../db/connection";
import { getStringSetting, setStringSetting, SETTING_SKIPPER_CONNECT_KEY } from "../config/app-settings";
import { clearConnectKey, connectKeyFilePath, getConnectKey, hasConnectKey, setConnectKey } from "./connect-key";
import { insecureConnectUrlReason } from "./connect-url";

describe("connect key store", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skipper-connect-key-"));
    db = new Database(join(dir, "runtime.db"));
    initializeDatabase(db);
  });

  afterEach(() => {
    clearConnectKey(db);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the key in a 0600 file beside the DB, not in app_settings", () => {
    setConnectKey(db, "key-1");
    const path = connectKeyFilePath(db)!;
    expect(path).toBe(join(dir, "runtime.db.connect-key"));
    expect(readFileSync(path, "utf8")).toBe("key-1");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(getStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, "")).toBe("");
    expect(getConnectKey(db)).toBe("key-1");
    expect(hasConnectKey(db)).toBe(true);
  });

  it("moves a legacy app_settings key to the file on first read", () => {
    setStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, "legacy-key");
    expect(getConnectKey(db)).toBe("legacy-key");
    expect(readFileSync(connectKeyFilePath(db)!, "utf8")).toBe("legacy-key");
    expect(getStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, "")).toBe("");
  });

  it("reports no key when neither the file nor the row exists", () => {
    expect(getConnectKey(db)).toBe("");
    expect(hasConnectKey(db)).toBe(false);
    expect(existsSync(connectKeyFilePath(db)!)).toBe(false);
  });

  it("uses app_settings for an in-memory DB", () => {
    const mem = new Database(":memory:");
    initializeDatabase(mem);
    expect(connectKeyFilePath(mem)).toBeNull();
    setConnectKey(mem, "mem-key");
    expect(getStringSetting(mem, SETTING_SKIPPER_CONNECT_KEY, "")).toBe("mem-key");
    expect(getConnectKey(mem)).toBe("mem-key");
    mem.close();
  });
});

describe("insecureConnectUrlReason", () => {
  it("accepts TLS URLs", () => {
    expect(insecureConnectUrlReason("wss://connect.example.com")).toBeNull();
    expect(insecureConnectUrlReason("https://connect.example.com/")).toBeNull();
  });

  it("accepts plain ws/http only for loopback hosts", () => {
    expect(insecureConnectUrlReason("ws://localhost:8787")).toBeNull();
    expect(insecureConnectUrlReason("http://127.0.0.1:8787")).toBeNull();
    expect(insecureConnectUrlReason("http://[::1]:8787")).toBeNull();
    expect(insecureConnectUrlReason("ws://connect.example.com")).not.toBeNull();
    expect(insecureConnectUrlReason("http://192.168.1.5:8787")).not.toBeNull();
  });

  it("refuses other schemes and junk", () => {
    expect(insecureConnectUrlReason("ftp://connect.example.com")).not.toBeNull();
    expect(insecureConnectUrlReason("connect.example.com")).not.toBeNull();
  });
});
