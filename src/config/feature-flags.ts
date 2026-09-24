export function isExperimental(): boolean {
  return process.argv.includes("--experimental");
}

/**
 * Decide whether a launch (`start`, `restart`, `serve`) runs experimental.
 * Explicit flags win; without one, the recorded state of the last daemon boot
 * is honoured, so a restart (manual, or the auto-updater's) never silently
 * drops the mode the operator was running in.
 *
 *   --experimental      on
 *   --no-experimental   off
 *   neither             whatever the last `serve` recorded (false when nothing is recorded)
 */
export function resolveExperimentalLaunch(argv: readonly string[], recorded: boolean | undefined): boolean {
  if (argv.includes("--no-experimental")) return false;
  if (argv.includes("--experimental")) return true;
  return recorded === true;
}
