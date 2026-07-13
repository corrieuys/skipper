import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, copyFileSync, statSync, writeFileSync } from "node:fs";
import { isCompiledBinary, listAssets, assetBytesSync } from "./assets";

const LEGACY_CWD_DB = "skipper-runtime.db";

/**
 * PATH for spawning external agent CLIs (claude, codex, opencode, grok).
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
 * Directory holding the mutable config snapshots (`agent_types.json`,
 * `appearance.json`, …).
 *
 * - `SKIPPER_CONFIG_DIR` override always wins.
 * - Compiled binary: `<data dir>/config`, seeded from the embedded defaults on
 *   first run (see `ensureConfigSeeded`). The repo `config/` is not on disk next
 *   to a packaged binary, and `appearance.json` is written back at runtime.
 * - Dev (`bun run`): the repo `./config` as before, so version-controlled config
 *   is what you edit and see.
 */
export function getConfigDir(): string {
  if (process.env.SKIPPER_CONFIG_DIR) return resolve(process.env.SKIPPER_CONFIG_DIR);
  if (isCompiledBinary()) return join(ensureDataDir(), "config");
  return resolve(process.cwd(), "config");
}

/**
 * Seed the data-dir config from embedded defaults on first run of a compiled
 * binary. Only writes files that are absent, so user edits (persisted back to
 * `appearance.json`) survive upgrades. No-op in dev and when `SKIPPER_CONFIG_DIR`
 * is set. Must run before the config store first reads.
 */
export function ensureConfigSeeded(): void {
  if (process.env.SKIPPER_CONFIG_DIR) return;
  if (!isCompiledBinary()) return;
  const dir = join(ensureDataDir(), "config");
  mkdirSync(dir, { recursive: true });
  for (const logical of listAssets("config/")) {
    const name = logical.slice("config/".length);
    if (!name.endsWith(".json")) continue;
    const dest = join(dir, name);
    if (existsSync(dest)) continue;
    writeFileSync(dest, assetBytesSync(logical));
  }
}

/** Directory for user-uploaded wallpapers (served alongside embedded defaults). */
export function getUploadedWallpaperDir(): string {
  return join(getDataDir(), "wallpapers");
}

/** PID file for the `skipper start`/`stop` daemon lifecycle. */
export function getPidFile(): string {
  return join(getDataDir(), "skipper.pid");
}

/** Log file the detached daemon writes stdout/stderr to. */
export function getLogFile(): string {
  return join(getDataDir(), "skipper.log");
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
