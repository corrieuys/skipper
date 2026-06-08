import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";

const LEGACY_CWD_DB = "skipper-runtime.db";

/**
 * PATH for spawning external agent CLIs (claude, codex, opencode, oz).
 *
 * The native Linux installers drop these binaries in `~/.local/bin`, which is
 * only added to PATH by interactive *login* shells (via ~/.profile / ~/.bashrc).
 * When Skipper is launched from any other context — a systemd unit, an IDE run
 * config, nohup, cron — that dir is absent and child spawns fail with ENOENT
 * "Executable not found in $PATH". (On macOS the installers use a dir already on
 * the default PATH, so this only bites Linux.) We prepend `~/.local/bin` so the
 * agent CLIs resolve regardless of launch context.
 *
 * Idempotent: if the dir is already present we return PATH unchanged, so this is
 * a no-op for login-shell launches and for macOS. A non-existent dir on PATH is
 * silently skipped by the OS, so prepending is harmless when ~/.local/bin is unused.
 */
export function agentSpawnPath(): string {
  const localBin = join(homedir(), ".local", "bin");
  const current = process.env.PATH ?? "";
  const entries = current.split(":");
  if (entries.includes(localBin)) return current;
  return current ? `${localBin}:${current}` : localBin;
}

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
