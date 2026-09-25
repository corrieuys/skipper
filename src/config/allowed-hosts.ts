import type { Database } from "bun:sqlite";
import { isIP } from "node:net";
import { getStringSetting, setStringSetting } from "./app-settings";
import { bindHostnameFromEnv, hostnameOf, setConfiguredAllowedHosts } from "../server";

// Extra hostnames the foreign-request gate (src/server.ts:rejectForeignRequest)
// accepts in the Host header, set in the config page's Allowed Hosts section.
// Machine-scoped, so it lives in runtime `app_settings` (a JSON array of
// lowercased names, no ports), never the committed config. The gate allows the
// union of this list, localhost, IP literals, the bind hostname and
// SKIPPER_ALLOWED_HOSTS; a save swaps the list into the running gate.
export const SETTING_ALLOWED_HOSTS = "allowed_hosts";

export const MAX_ALLOWED_HOSTS = 50;
const MAX_HOSTNAME_LENGTH = 253; // the DNS limit

export interface AllowedHostsInput {
  /** Lowercased, port stripped, deduped. */
  hosts: string[];
  /** One line per refused entry. Any error means nothing is saved. */
  errors: string[];
}

export interface AllowedHostsView {
  /** Saved in the config page's list. */
  hosts: string[];
  /** The address the daemon binds. */
  bindAddress: string;
  /** `SKIPPER_HOST` as set (`skipper start --host` sets it too); null when unset. */
  bindHostEnv: string | null;
  /** The name the bind address adds to the allowlist; null for an IP address or localhost. */
  bindHostname: string | null;
  /** `SKIPPER_ALLOWED_HOSTS` verbatim; null when unset. */
  envAllowedHosts: string | null;
}

/** A bare or bracketed IP address, with or without a port. */
function isIpLiteral(value: string): boolean {
  if (isIP(value) !== 0) return true;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed) return isIP(bracketed[1] ?? "") !== 0;
  const name = hostnameOf(value);
  return name !== null && isIP(name) === 4;
}

function normalizeEntry(entry: string): { name: string } | { error: string } {
  const value = entry.toLowerCase();
  if (value.includes("://")) return { error: "enter just the hostname, not a URL" };
  if (value.includes("*")) return { error: "wildcards are not supported, list each hostname" };
  if (value.includes("/")) return { error: "enter just the hostname, without a path" };
  if (isIpLiteral(value)) return { error: "IP addresses are always allowed, no need to list them" };
  const name = hostnameOf(value);
  if (name === null) return { error: "not a hostname (letters, digits, dots, hyphens and underscores, optionally with :port)" };
  if (name.length > MAX_HOSTNAME_LENGTH) return { error: `longer than ${MAX_HOSTNAME_LENGTH} characters` };
  return { name };
}

/**
 * Validate the section's free text (one per line or comma separated). Each entry
 * is trimmed, lowercased and stripped of a `:port`, and duplicates collapse. Only
 * a name the gate can match passes (src/server.ts:hostnameOf, the Host-header
 * name syntax). IP literals are refused because they are always allowed already;
 * wildcards, URLs and paths because a Host header never carries them. Blank
 * entries are skipped, so an empty text clears the list.
 */
export function parseAllowedHostsInput(raw: string): AllowedHostsInput {
  const entries = raw.split(/[\r\n,]+/).map((s) => s.trim()).filter((s) => s !== "");
  if (entries.length > MAX_ALLOWED_HOSTS) {
    return { hosts: [], errors: [`${entries.length} entries: at most ${MAX_ALLOWED_HOSTS} hostnames`] };
  }
  const hosts: string[] = [];
  const errors: string[] = [];
  for (const entry of entries) {
    const result = normalizeEntry(entry);
    if ("error" in result) {
      errors.push(`${entry.length > 60 ? `${entry.slice(0, 60)}…` : entry}: ${result.error}`);
    } else if (!hosts.includes(result.name)) {
      hosts.push(result.name);
    }
  }
  return { hosts, errors };
}

/** The saved list. A row that is not a JSON array of normalized names reads as empty (junk entries dropped). */
export function getAllowedHosts(db: Database): string[] {
  const raw = getStringSetting(db, SETTING_ALLOWED_HOSTS, "");
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && hostnameOf(x) === x) : [];
  } catch {
    return [];
  }
}

/**
 * Validate and save the section's list, then swap it into the running gate, so
 * it applies from the next request with no restart. Nothing changes when any
 * entry is refused.
 */
export function saveAllowedHosts(db: Database, raw: string): AllowedHostsInput {
  const parsed = parseAllowedHostsInput(raw);
  if (parsed.errors.length > 0) return parsed;
  setStringSetting(db, SETTING_ALLOWED_HOSTS, JSON.stringify(parsed.hosts));
  setConfiguredAllowedHosts(parsed.hosts);
  return parsed;
}

/** Boot: hand the saved list to the gate before the server takes requests. */
export function loadAllowedHosts(db: Database): void {
  setConfiguredAllowedHosts(getAllowedHosts(db));
}

/**
 * What the config section shows. `env` is this process's environment, which is
 * what startServer read at boot (nothing changes it afterwards).
 */
export function getAllowedHostsView(db: Database, env: Record<string, string | undefined> = process.env): AllowedHostsView {
  const bindAddress = bindHostnameFromEnv(env);
  const bindName = hostnameOf(bindAddress);
  const envList = env.SKIPPER_ALLOWED_HOSTS ?? "";
  return {
    hosts: getAllowedHosts(db),
    bindAddress,
    bindHostEnv: env.SKIPPER_HOST || null,
    bindHostname: bindName !== null && bindName !== "localhost" && isIP(bindName) === 0 ? bindName : null,
    envAllowedHosts: envList.trim() ? envList : null,
  };
}
