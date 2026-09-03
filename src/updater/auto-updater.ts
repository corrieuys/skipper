import type { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { logError } from "../logging";
import { isCompiledBinary } from "../assets";
import { APP_VERSION, compareSemver, classifyBump } from "../version";
import { getStringSetting, setStringSetting } from "../config/app-settings";
import { isExperimental } from "../config/feature-flags";
import {
  isAutoUpdateEnabled,
  SETTING_UPDATE_AVAILABLE_VERSION,
  SETTING_UPDATE_DOWNLOADED_VERSION,
} from "../config/auto-update-settings";
import { fetchLatestStableTag } from "./github-release";

export interface UpdaterDeps {
  /** Running version to compare against (default APP_VERSION). */
  currentVersion: string;
  /** Whether we're a packaged binary that can self-update (default isCompiledBinary()). */
  isCompiled: boolean;
  /** Resolve the latest stable release tag, or null (default: GitHub /releases/latest). */
  fetchLatest: () => Promise<string | null>;
  /** True when nothing is actively running, so a restart is safe. */
  isSystemIdle: () => boolean;
  /** Run `skipper update`; resolve true on success (default: spawn the CLI). */
  runUpdate: () => Promise<boolean>;
  /** Run `skipper restart --no-open` detached (default: spawn the CLI). */
  runRestart: () => void;
}

/** How to re-invoke ourselves as a CLI subcommand (binary vs `bun run`). */
function cliInvocation(sub: string[]): { cmd: string; args: string[] } {
  const cmd = process.execPath;
  return isCompiledBinary() ? { cmd, args: sub } : { cmd, args: [Bun.main, ...sub] };
}

function defaultRunUpdate(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const { cmd, args } = cliInvocation(["update"]);
      const child = spawn(cmd, args, { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

function defaultRunRestart(): void {
  try {
    // Detached + unref: `skipper restart` SIGTERMs THIS daemon (its own pid), so
    // the child must outlive us to run start() afterwards. --no-open: the tab
    // hard-refreshes itself on WS reconnect instead of a new one opening.
    // Forward --experimental when this server is running it, so the restarted
    // daemon keeps experimental features on (serveInvocation reads it from argv).
    const restartArgs = ["restart", "--no-open"];
    if (isExperimental()) restartArgs.push("--experimental");
    const { cmd, args } = cliInvocation(restartArgs);
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best-effort */
  }
}

function defaultDeps(db: Database): UpdaterDeps {
  return {
    currentVersion: APP_VERSION,
    isCompiled: isCompiledBinary(),
    fetchLatest: fetchLatestStableTag,
    // DB-only idle check by default; the tick loop + event subscriber pass a
    // fuller check that also accounts for live agent processes.
    isSystemIdle: () => noActiveOrQueuedTasks(db),
    runUpdate: defaultRunUpdate,
    runRestart: defaultRunRestart,
  };
}

/**
 * True when no task has work in flight or queued: no live agent instances, no
 * paused task, no pending wake, no active task awaiting its first start. Idle
 * active tasks (resting between inputs) do NOT block an auto-restart — sessions
 * survive a bounce and new input wakes them afterwards.
 */
function noActiveOrQueuedTasks(db: Database): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM tasks t
       WHERE t.status = 'active'
         AND (t.paused = 1
           OR t.wake_requested_at IS NOT NULL
           OR t.started_at IS NULL
           OR EXISTS (
             SELECT 1 FROM agent_instances ai
             WHERE ai.task_id = t.id AND ai.status IN ('running', 'waiting_delegation', 'pending')
           ))`,
    )
    .get() as { c: number };
  return (row?.c ?? 0) === 0;
}

/** Structural view of AgentManager — just the running-process count we need. */
interface RunningAgentsSource {
  getRunningAgents(): { size: number };
}

/**
 * The full idle gate used by the hourly timer and the completion-event subscriber:
 * no live agent processes AND no active/queued tasks.
 */
export function isSystemFullyIdle(db: Database, agentManager: RunningAgentsSource): boolean {
  if (agentManager.getRunningAgents().size > 0) return false;
  return noActiveOrQueuedTasks(db);
}

// Restart at most once per process: the hourly checker and the task-completion
// subscriber can both reach the restart step, and `skipper restart` SIGTERMs this
// very process, so a second spawn would race the shutdown.
let restartInitiated = false;

/** Test-only: reset the once-per-process restart guard between cases. */
export function __resetRestartGuardForTests(): void {
  restartInitiated = false;
}

/**
 * Restart the daemon to apply an already-downloaded patch, but only when it's safe:
 * a download is pending, auto-update is on, we're a real binary, and the system is
 * fully idle. Returns true if a restart was initiated. Safe to call repeatedly (from
 * the hourly tick and on every task-completion event) — it self-guards.
 */
export function restartIfUpdatePending(db: Database, overrides: Partial<UpdaterDeps> = {}): boolean {
  const deps = { ...defaultDeps(db), ...overrides };
  if (restartInitiated) return false;
  if (!getStringSetting(db, SETTING_UPDATE_DOWNLOADED_VERSION, "")) return false;
  if (!isAutoUpdateEnabled(db) || !deps.isCompiled) return false;
  if (!deps.isSystemIdle()) return false;
  restartInitiated = true;
  deps.runRestart();
  return true;
}

/**
 * Hourly auto-update check. Records the newest available release for the toast,
 * and — only when the user opted in — auto-applies a PATCH release, restarting
 * when the system is idle. Never throws (errors are logged). No-op in dev.
 */
export async function checkForUpdates(db: Database, overrides: Partial<UpdaterDeps> = {}): Promise<void> {
  const deps = { ...defaultDeps(db), ...overrides };
  try {
    if (deps.currentVersion === "dev") return;

    const latest = await deps.fetchLatest();
    if (!latest) return;

    if (compareSemver(latest, deps.currentVersion) <= 0) {
      // Nothing newer — clear any stale "available" marker.
      if (getStringSetting(db, SETTING_UPDATE_AVAILABLE_VERSION, "")) {
        setStringSetting(db, SETTING_UPDATE_AVAILABLE_VERSION, "");
      }
      return;
    }

    // A newer release exists — record it so the toast fragment surfaces it.
    setStringSetting(db, SETTING_UPDATE_AVAILABLE_VERSION, latest);

    // Auto-apply patch releases only, and only in a self-updatable binary.
    const bump = classifyBump(deps.currentVersion, latest);
    if (!isAutoUpdateEnabled(db) || !deps.isCompiled || bump !== "patch") return;

    // Download once; a later tick (or a task-completion event) retries the restart
    // when the system is idle.
    if (getStringSetting(db, SETTING_UPDATE_DOWNLOADED_VERSION, "") !== latest) {
      const ok = await deps.runUpdate();
      if (!ok) return;
      setStringSetting(db, SETTING_UPDATE_DOWNLOADED_VERSION, latest);
    }

    // Restart now if fully idle; otherwise it stays downloaded and the restart
    // fires from the task-completion subscriber (or a later tick) once idle.
    restartIfUpdatePending(db, deps);
  } catch (err) {
    logError(db, "auto_update_check", {}, err);
  }
}
