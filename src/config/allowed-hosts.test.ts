import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { getStringSetting, setStringSetting } from "./app-settings";
import {
  SETTING_ALLOWED_HOSTS,
  MAX_ALLOWED_HOSTS,
  parseAllowedHostsInput,
  saveAllowedHosts,
  getAllowedHosts,
  getAllowedHostsView,
} from "./allowed-hosts";
import { setConfiguredAllowedHosts } from "../server";

// The config page's Allowed Hosts list: validation, storage, and the view of the
// environment's part. The gate picking a save up live is covered end to end in
// src/routes/config-allowed-hosts.test.ts.

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initializeDatabase(db);
});

afterEach(() => {
  db.close();
  setConfiguredAllowedHosts([]); // saves reach the gate's module state
});

describe("parseAllowedHostsInput", () => {
  it("trims, lowercases, strips a port and dedupes; one per line or comma separated", () => {
    const { hosts, errors } = parseAllowedHostsInput(" My-Mac.local:5005 \r\n skipper.example.com, my-mac.local,,\n\n build_box ");
    expect(errors).toEqual([]);
    expect(hosts).toEqual(["my-mac.local", "skipper.example.com", "build_box"]);
  });

  it("accepts an empty text (clears the list)", () => {
    expect(parseAllowedHostsInput("")).toEqual({ hosts: [], errors: [] });
    expect(parseAllowedHostsInput("  \n , \n")).toEqual({ hosts: [], errors: [] });
  });

  it("refuses IP literals and says they are always allowed", () => {
    for (const entry of ["10.0.0.5", "10.0.0.5:5005", "::1", "[::1]", "[::1]:5005", "fe80::1"]) {
      const { hosts, errors } = parseAllowedHostsInput(entry);
      expect(hosts).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("always allowed");
    }
  });

  it("refuses wildcards, URLs, paths and anything a Host header cannot name", () => {
    const cases: [string, string][] = [
      ["*.local", "wildcards"],
      ["http://my-mac.local", "not a URL"],
      ["https://my-mac.local:5005/", "not a URL"],
      ["my-mac.local/config", "without a path"],
      ["my mac.local", "not a hostname"],
      ["user@my-mac.local", "not a hostname"],
      [":5005", "not a hostname"],
      ["my-mac.local:123456", "not a hostname"],
      ["[evil.example]", "not a hostname"],
    ];
    for (const [entry, reason] of cases) {
      const { hosts, errors } = parseAllowedHostsInput(entry);
      expect(hosts).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(reason);
    }
  });

  it("names each refused entry and keeps checking the rest", () => {
    const { errors } = parseAllowedHostsInput("ok.local\n10.0.0.5\n*.lan");
    expect(errors).toHaveLength(2);
    expect(errors[0]).toStartWith("10.0.0.5:");
    expect(errors[1]).toStartWith("*.lan:");
  });

  it("refuses absurd input: too many entries, or a name over 253 characters", () => {
    const many = Array.from({ length: MAX_ALLOWED_HOSTS + 1 }, (_, i) => `host-${i}.local`).join("\n");
    const tooMany = parseAllowedHostsInput(many);
    expect(tooMany.hosts).toEqual([]);
    expect(tooMany.errors).toEqual([`${MAX_ALLOWED_HOSTS + 1} entries: at most ${MAX_ALLOWED_HOSTS} hostnames`]);
    expect(parseAllowedHostsInput(Array.from({ length: MAX_ALLOWED_HOSTS }, (_, i) => `h${i}`).join(",")).errors).toEqual([]);

    expect(parseAllowedHostsInput("a".repeat(253)).hosts).toEqual(["a".repeat(253)]);
    const long = parseAllowedHostsInput("a".repeat(254));
    expect(long.hosts).toEqual([]);
    expect(long.errors[0]).toContain("longer than 253 characters");
    // The echo of an absurd entry is cut short.
    expect(long.errors[0]!.length).toBeLessThan(120);
  });
});

describe("saveAllowedHosts / getAllowedHosts", () => {
  it("round-trips the normalized list through runtime app_settings", () => {
    const result = saveAllowedHosts(db, "My-Mac.local:5005\nskipper.example.com");
    expect(result).toEqual({ hosts: ["my-mac.local", "skipper.example.com"], errors: [] });
    expect(getStringSetting(db, SETTING_ALLOWED_HOSTS)).toBe(JSON.stringify(["my-mac.local", "skipper.example.com"]));
    expect(getAllowedHosts(db)).toEqual(["my-mac.local", "skipper.example.com"]);

    saveAllowedHosts(db, "");
    expect(getAllowedHosts(db)).toEqual([]);
  });

  it("saves nothing when any entry is refused", () => {
    saveAllowedHosts(db, "keep.local");
    const result = saveAllowedHosts(db, "new.local, 10.0.0.5");
    expect(result.errors).toHaveLength(1);
    expect(getAllowedHosts(db)).toEqual(["keep.local"]);
  });

  it("is empty when unset, and reads junk in the row as no hosts", () => {
    expect(getAllowedHosts(db)).toEqual([]);
    setStringSetting(db, SETTING_ALLOWED_HOSTS, "not json");
    expect(getAllowedHosts(db)).toEqual([]);
    setStringSetting(db, SETTING_ALLOWED_HOSTS, JSON.stringify({ host: "a.local" }));
    expect(getAllowedHosts(db)).toEqual([]);
    setStringSetting(db, SETTING_ALLOWED_HOSTS, JSON.stringify(["ok.local", 5, "NOT-NORMALIZED.local", "has space"]));
    expect(getAllowedHosts(db)).toEqual(["ok.local"]);
  });
});

describe("getAllowedHostsView", () => {
  it("reports unset environment variables as null and the loopback default bind", () => {
    expect(getAllowedHostsView(db, {})).toEqual({
      hosts: [],
      bindAddress: "127.0.0.1",
      bindHostEnv: null,
      bindHostname: null,
      envAllowedHosts: null,
    });
    expect(getAllowedHostsView(db, { SKIPPER_HOST: "", SKIPPER_ALLOWED_HOSTS: " " }).envAllowedHosts).toBeNull();
  });

  it("shows set values verbatim, the saved list, and the name a bind hostname adds", () => {
    saveAllowedHosts(db, "saved.local");
    expect(getAllowedHostsView(db, { SKIPPER_HOST: "My-Mac.local", SKIPPER_ALLOWED_HOSTS: "a.local, B.local:8443" })).toEqual({
      hosts: ["saved.local"],
      bindAddress: "My-Mac.local",
      bindHostEnv: "My-Mac.local",
      bindHostname: "my-mac.local",
      envAllowedHosts: "a.local, B.local:8443",
    });
  });

  it("adds no hostname for an IP bind address or localhost", () => {
    for (const bind of ["0.0.0.0", "192.168.1.20", "::", "localhost"]) {
      const view = getAllowedHostsView(db, { SKIPPER_HOST: bind });
      expect(view.bindHostEnv).toBe(bind);
      expect(view.bindHostname).toBeNull();
    }
  });
});
