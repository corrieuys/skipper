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
