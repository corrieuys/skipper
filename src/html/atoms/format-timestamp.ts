import { escapeHtml } from "./escape-html";

/** Parse ISO timestamp; force UTC interpretation for SQLite timestamps that
 *  lack a timezone suffix. The previous `new Date(isoString)`-first approach
 *  silently parsed SQLite's "YYYY-MM-DD HH:MM:SS" as LOCAL time, producing a
 *  valid Date that was off by the local UTC offset (e.g. "2h ago" for a
 *  brand-new note when the user is in SAST). */
function parseTimestamp(isoString: string): Date {
  // SQLite datetime('now'): "2026-05-17 14:30:00"
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(isoString)) {
    return new Date(isoString.replace(" ", "T") + "Z");
  }
  // ISO without timezone: "2026-05-17T14:30:00"
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(isoString)) {
    return new Date(isoString + "Z");
  }
  return new Date(isoString);
}

/** Format a timestamp as a relative time string with a tooltip showing the full date. */
export function formatTimestamp(isoString: string): string {
  const date = parseTimestamp(isoString);
  if (isNaN(date.getTime())) return escapeHtml(isoString);

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const absDiffMs = Math.abs(diffMs);
  const diffSec = Math.floor(diffMs / 1000);
  const absDiffSec = Math.floor(absDiffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const absDiffMin = Math.floor(absDiffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const absDiffHr = Math.floor(absDiffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  const absDiffDay = Math.floor(absDiffHr / 24);

  let relative: string;
  if (Math.abs(diffSec) < 60) {
    relative = "just now";
  } else if (diffMs >= 0) {
    if (diffMin < 60) relative = `${diffMin}m ago`;
    else if (diffHr < 10) relative = `${diffHr}h ${diffMin % 60}m ago`;
    else if (diffHr < 24) relative = `${diffHr}h ago`;
    else if (diffDay < 30) relative = `${diffDay}d ago`;
    else relative = date.toLocaleDateString();
  } else {
    if (absDiffMin < 60) relative = `in ${absDiffMin}m`;
    else if (absDiffHr < 10) relative = `in ${absDiffHr}h ${absDiffMin % 60}m`;
    else if (absDiffHr < 24) relative = `in ${absDiffHr}h`;
    else if (absDiffDay < 30) relative = `in ${absDiffDay}d`;
    else relative = date.toLocaleDateString();
  }

  return `<span title="${escapeHtml(date.toLocaleString())}" data-ts="${date.getTime()}">${relative}</span>`;
}
