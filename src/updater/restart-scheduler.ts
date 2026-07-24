import type { Database } from "bun:sqlite";
import { eventBus } from "../events/bus";
import { restartIfUpdatePending, isSystemFullyIdle } from "./auto-updater";

interface RunningAgentsSource {
  getRunningAgents(): { size: number };
}

/**
 * Event-driven auto-restart: when a task's state changes (e.g. it finishes), if a
 * patch update was already downloaded and the system is now fully idle — all tasks
 * completed, nothing running or queued — restart the daemon to apply it. This turns
 * the "wait until idle" from an up-to-1-hour poll into a prompt, on-completion action.
 * `restartIfUpdatePending` self-guards, so an early transition (e.g. a task starting)
 * is a cheap no-op. Returns a stop() to unsubscribe on shutdown.
 */
export function initUpdateRestartOnIdle(db: Database, agentManager: RunningAgentsSource): () => void {
  const onState = () => {
    restartIfUpdatePending(db, { isSystemIdle: () => isSystemFullyIdle(db, agentManager) });
  };
  eventBus.on("task:state_changed", onState);
  return () => eventBus.off("task:state_changed", onState);
}
