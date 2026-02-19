import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";

export interface RuntimeInfo {
  command: string;
  version: string | null;
  path: string | null;
  available: boolean;
  detected_at: string;
}

interface RuntimeRow {
  command: string;
  version: string | null;
  path: string | null;
  available: number;
  detected_at: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const detectionCache = new Map<string, { info: RuntimeInfo; cachedAt: number }>();

async function runCommand(cmd: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

export async function detectRuntime(
  command: string,
  db?: Database,
): Promise<RuntimeInfo> {
  const now = Date.now();
  const cached = detectionCache.get(command);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.info;
  }

  let path: string | null = null;
  let version: string | null = null;
  let available = false;

  try {
    const whichResult = await runCommand(["which", command]);
    if (whichResult.exitCode === 0 && whichResult.stdout) {
      path = whichResult.stdout;
      available = true;

      try {
        const versionResult = await runCommand([command, "--version"]);
        if (versionResult.exitCode === 0 && versionResult.stdout) {
          version = versionResult.stdout.split("\n")[0] ?? null;
        }
      } catch {
        // version detection is best-effort
      }
    }
  } catch {
    // command not found
  }

  const info: RuntimeInfo = {
    command,
    version,
    path,
    available,
    detected_at: new Date().toISOString(),
  };

  // Persist to DB
  const database = db ?? getDb();
  database
    .prepare(
      `INSERT INTO cli_runtimes (command, version, path, available, detected_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(command) DO UPDATE SET
         version = excluded.version,
         path = excluded.path,
         available = excluded.available,
         detected_at = excluded.detected_at`,
    )
    .run(command, version, path, available ? 1 : 0, info.detected_at);

  detectionCache.set(command, { info, cachedAt: now });
  return info;
}

export async function validateRuntimeAvailable(
  command: string,
  db?: Database,
): Promise<boolean> {
  const info = await detectRuntime(command, db);
  return info.available;
}

export function getCachedRuntime(
  command: string,
  db?: Database,
): RuntimeInfo | null {
  // Check in-memory cache first
  const cached = detectionCache.get(command);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.info;
  }

  // Fall back to DB
  const database = db ?? getDb();
  const row = database
    .prepare("SELECT * FROM cli_runtimes WHERE command = ?")
    .get(command) as RuntimeRow | null;

  if (!row) return null;

  return {
    command: row.command,
    version: row.version,
    path: row.path,
    available: row.available === 1,
    detected_at: row.detected_at,
  };
}

export function clearRuntimeCache(): void {
  detectionCache.clear();
}
