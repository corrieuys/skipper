// The single source of truth for the app version surfaced at runtime.
//
// Baked in at compile time by scripts/build-binary.ts via
//   `--define __SKIPPER_VERSION__=…`  (derived from the git tag in CI, so a
//   tagged release and `skipper --version` always match). The `--define` replaces
//   this identifier across the whole compiled bundle, so any module — CLI, server,
//   HTML renderers — reads the same value. Undefined under `bun run` (dev checkout),
//   where we fall back to "dev".
declare const __SKIPPER_VERSION__: string;

export const APP_VERSION: string =
  typeof __SKIPPER_VERSION__ !== "undefined" ? __SKIPPER_VERSION__ : "dev";

/** Header label: "v0.2.0" for a real release, "dev" in a dev checkout. */
export const APP_VERSION_LABEL: string = APP_VERSION === "dev" ? "dev" : `v${APP_VERSION}`;

// A fresh id per daemon process. The open UI tab compares this (via SERVER_ID)
// on every WS reconnect and hard-reloads when it changes, so a plain
// `skipper restart` — same binary, same APP_VERSION — still refreshes the tab
// instead of leaving it on the old process. Stable within one process, so a
// transient WS blip (same daemon) does not trigger a needless reload.
export const BOOT_ID: string = crypto.randomUUID();

/**
 * Identity of the running server the tab checks on reconnect: version + boot id.
 * Changes on a self-update (version differs) AND on any restart (boot differs).
 */
export const SERVER_ID: string = `${APP_VERSION} ${BOOT_ID}`;

// ── Semver helpers (used by the auto-update checker) ───────────────────────
// Deliberately dependency-free: we only need X.Y.Z ordering and bump
// classification against our own release tags, not full semver range logic.

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse "vX.Y.Z" (leading "v" optional; any "-prerelease"/"+build" suffix is
 * dropped for comparison). Returns null when the core isn't three integers.
 */
export function parseSemver(v: string): Semver | null {
  if (typeof v !== "string") return null;
  const core = v.trim().replace(/^v/i, "").split(/[-+]/)[0] ?? "";
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(core);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Order two version strings: -1 if a < b, 1 if a > b, 0 if equal or either is
 * unparseable (callers treat 0 as "not newer", i.e. no action).
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

/**
 * Classify the bump from `from` to `to`. A prerelease target (e.g. "1.2.4-beta")
 * is never "patch" — auto-update applies to stable patch releases only, so a
 * "-"/"+" suffix on `to` disqualifies it (returns "none"). "downgrade" when `to`
 * is lower, "none" when unparseable or equal.
 */
export function classifyBump(from: string, to: string): "none" | "patch" | "minor" | "major" | "downgrade" {
  const pf = parseSemver(from);
  const pt = parseSemver(to);
  if (!pf || !pt) return "none";
  const cmp = compareSemver(from, to);
  if (cmp === 0) return "none";
  if (cmp > 0) return "downgrade";
  if (pt.major !== pf.major) return "major";
  if (pt.minor !== pf.minor) return "minor";
  // Same major.minor, higher patch — but only a clean stable target counts.
  if (/[-+]/.test(to.trim())) return "none";
  return "patch";
}
