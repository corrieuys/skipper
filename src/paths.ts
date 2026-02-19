import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";

const LEGACY_CWD_DB = "skipper-runtime.db";

export function getDataDir(): string {
  if (process.env.SKIPPER_DATA_DIR) return process.env.SKIPPER_DATA_DIR;
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? join(xdg, "skipper") : join(homedir(), ".skipper");
}

export function ensureDataDir(): string {
  const dir = getDataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getRuntimeDbPath(): string {
  if (process.env.SKIPPER_RUNTIME_DB_PATH) return process.env.SKIPPER_RUNTIME_DB_PATH;
  return join(ensureDataDir(), "skipper-runtime.db");
}

/**
 * One-time relocation of a legacy `./skipper-runtime.db` from the user's
 * cwd into the data dir. Runs only when the target does not yet exist and
 * a non-empty legacy file is present. Original is left in place so the
 * user can verify before deleting.
 */
export function migrateLegacyDbIfNeeded(): { migrated: boolean; from?: string; to?: string } {
  if (process.env.SKIPPER_RUNTIME_DB_PATH) return { migrated: false };
  const target = join(getDataDir(), "skipper-runtime.db");
  if (existsSync(target)) return { migrated: false };
  const legacy = join(process.cwd(), LEGACY_CWD_DB);
  if (!existsSync(legacy)) return { migrated: false };
  try {
    if (statSync(legacy).size === 0) return { migrated: false };
  } catch {
    return { migrated: false };
  }
  ensureDataDir();
  copyFileSync(legacy, target);
  return { migrated: true, from: legacy, to: target };
}
