// Presentation helpers for the unified task model. Stored status is only
// draft | active | settled; chips/dots render the derived display status
// (queued/working/idle/paused/review/blocked/completed/failed) via
// src/tasks/status.ts. "Archive" never surfaces as a word: a settled task is
// just Completed or Failed, and typing input revives it.
import { displayStatusLabel, resultHasError, type TaskDisplayStatus } from "../../tasks/status";

/** True when a task result JSON (string or parsed) carries an .error. */
export const taskResultHasError = resultHasError;

/** Coerce a row's display status, falling back to the stored status. */
export function displayStatusOf(row: { status: string; display_status?: string | null; result?: unknown }): TaskDisplayStatus {
  const d = row.display_status ?? row.status;
  switch (d) {
    case "draft":
    case "queued":
    case "working":
    case "idle":
    case "paused":
    case "review":
    case "blocked":
    case "completed":
    case "failed":
      return d;
    // Stored statuses without a precomputed display.
    case "settled":
      return resultHasError(row.result) ? "failed" : "completed";
    case "active":
      return "idle";
    default:
      return "draft";
  }
}

/** sk-badge modifier for a display status. */
export function displayBadgeClass(display: TaskDisplayStatus, hasError = false): string {
  switch (display) {
    case "draft": return "sk-badge--draft";
    case "queued": return "sk-badge--approved";
    case "working": return "sk-badge--running";
    case "idle": return "sk-badge--completed";
    case "paused": return "sk-badge--waiting";
    case "review": return "sk-badge--waiting";
    case "blocked": return "sk-badge--danger";
    case "completed": return hasError ? "sk-badge--failed" : "sk-badge--completed";
    case "failed": return "sk-badge--failed";
  }
}

/** Status chip for a display status. */
export function statusChip(display: TaskDisplayStatus, hasError = false): string {
  const effective: TaskDisplayStatus = display === "completed" && hasError ? "failed" : display;
  return `<span class="sk-badge ${displayBadgeClass(effective)}">${displayStatusLabel(effective)}</span>`;
}

/** Sidebar dot modifier (mc-sidebar__item-dot--*) for a display status. */
export function displayDotClass(display: TaskDisplayStatus, hasError = false): string {
  switch (display) {
    case "draft": return "draft";
    case "queued": return "approved";
    case "working": return "running";
    case "idle": return "active";
    case "paused": return "paused";
    case "review": return "failed";
    case "blocked": return "failed";
    case "completed": return hasError ? "failed" : "settled";
    case "failed": return "failed";
  }
}

/** Task-header indicator modifier (mc-node__indicator--*) for a display status. */
export function displayIndicatorClass(display: TaskDisplayStatus, hasError = false): string {
  switch (display) {
    case "draft": return "pending";
    case "queued": return "pending";
    case "working": return "running";
    case "idle": return "completed";
    case "paused": return "paused";
    case "review": return "waiting";
    case "blocked": return "waiting";
    case "completed": return hasError ? "failed" : "completed";
    case "failed": return "failed";
  }
}

/** Run-strip square modifier (tc-runsq--*) for a display status. */
export function displayRunSquareClass(display: TaskDisplayStatus, hasError = false): string {
  switch (display) {
    case "working": return "running";
    case "queued": return "approved";
    case "paused": return "paused";
    case "completed": return hasError ? "failed" : "completed";
    case "failed": return "failed";
    case "idle": return "completed";
    default: return "approved";
  }
}

/** Small mode marker; a snail marks tasks with autopilot OFF (operator-driven). */
export function modeChip(mode: string | undefined | null, opts: { compact?: boolean } = {}): string {
  if (mode !== "conversational") return "";
  const style = opts.compact ? ` style="font-size:10px;line-height:1;"` : ` style="font-size:12px;line-height:1;"`;
  return `<span${style} title="Autopilot off: this task waits for your input" aria-label="Autopilot off">&#x1F40C;</span>`;
}
