import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../paths";

/**
 * Saved dashboard targets. The local daemon is always present; remote entries
 * are Skipper Connect integrators (URL + integrator key), the same shape the
 * Apple apps' ServerConfig uses. Persisted in the data dir (`dashboard-servers.json`,
 * mode 0600 because it holds keys); never in the repo or the binary.
 */
export interface ServerConfig {
  id: string;
  name: string;
  kind: "local" | "remote";
  /** Local: `http://127.0.0.1:<port>`; remote: the integrator origin (https://…). */
  baseURL: string;
  /** Remote only. */
  integratorKey: string;
}

export interface ServerFile {
  servers: ServerConfig[];
  activeId: string | null;
}

export const LOCAL_SERVER_ID = "local";

export function localServer(host = process.env.SKIPPER_HOST || "127.0.0.1", port = Number(process.env.PORT) || 5005): ServerConfig {
  const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return { id: LOCAL_SERVER_ID, name: "local", kind: "local", baseURL: `http://${h}:${port}`, integratorKey: "" };
}

export function serversPath(dir = getDataDir()): string {
  return join(dir, "dashboard-servers.json");
}

export function loadServers(dir = getDataDir()): ServerFile {
  const p = serversPath(dir);
  if (!existsSync(p)) return { servers: [], activeId: null };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<ServerFile>;
    const servers = Array.isArray(raw.servers)
      ? raw.servers
          .filter((s): s is ServerConfig => !!s && typeof s === "object" && typeof (s as ServerConfig).baseURL === "string")
          .map((s) => ({
            id: String(s.id || crypto.randomUUID()),
            name: String(s.name || s.baseURL),
            kind: s.kind === "local" ? "local" : "remote",
            baseURL: String(s.baseURL),
            integratorKey: String(s.integratorKey ?? ""),
          }))
          .filter((s) => s.kind === "remote")
      : [];
    return { servers, activeId: typeof raw.activeId === "string" ? raw.activeId : null };
  } catch {
    return { servers: [], activeId: null };
  }
}

export function saveServers(file: ServerFile, dir = getDataDir()): void {
  mkdirSync(dir, { recursive: true });
  const p = serversPath(dir);
  writeFileSync(p, JSON.stringify({ servers: file.servers.filter((s) => s.kind === "remote"), activeId: file.activeId }, null, 2));
  try {
    chmodSync(p, 0o600);
  } catch {
    /* windows */
  }
}

/** Every pickable target: the local daemon first, then saved remotes. */
export function allServers(dir = getDataDir()): ServerConfig[] {
  return [localServer(), ...loadServers(dir).servers];
}

export function findServer(nameOrId: string, dir = getDataDir()): ServerConfig | null {
  const q = nameOrId.trim().toLowerCase();
  return allServers(dir).find((s) => s.id.toLowerCase() === q || s.name.toLowerCase() === q) ?? null;
}

// ── URL builders (pure) ──────────────────────────────────────────────────────

/** The consumer WebSocket URL. Local: loopback `/connect/local`, no auth. Remote: `/connect?token=<key>`. */
export function socketURL(s: ServerConfig): string {
  const u = new URL(s.baseURL.trim());
  if (s.kind === "local") {
    u.protocol = "ws:";
    u.pathname = "/connect/local";
    u.search = "";
    return u.toString();
  }
  u.protocol = u.protocol === "http:" || u.protocol === "ws:" ? "ws:" : "wss:";
  u.pathname = "/connect";
  u.search = "";
  u.searchParams.set("token", s.integratorKey);
  return u.toString();
}

/** The dashboard JSON socket (roster / global feed / metrics). Local only. */
export function dashboardURL(s: ServerConfig): string | null {
  if (s.kind !== "local") return null;
  const u = new URL(s.baseURL.trim());
  u.protocol = "ws:";
  u.pathname = "/ws/ui";
  u.search = "?format=json&topics=dashboard";
  return u.toString();
}

/** Plain HTTP base for the loopback-only routes (team import/export, any-status edit). Local only. */
export function httpBase(s: ServerConfig): string | null {
  return s.kind === "local" ? s.baseURL.replace(/\/+$/, "") : null;
}

export function authHeaders(s: ServerConfig): Record<string, string> {
  return s.kind === "remote" && s.integratorKey ? { Authorization: `Bearer ${s.integratorKey}` } : {};
}

/** Human label for the header, e.g. "local" or "acme ⇅". */
export function serverLabel(s: ServerConfig): string {
  return s.kind === "local" ? "local" : `${s.name} ⇅`;
}
