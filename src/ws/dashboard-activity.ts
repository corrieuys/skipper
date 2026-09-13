import type { Database } from "bun:sqlite";
import { fetchRecentActivity } from "../data/queries";
import { summarizeTerminalLine } from "../html/terminalJsonSummary";

/** One parsed line of live agent output for the TUI output feed. */
export interface ActivityJson {
  agent_id: string;
  agent_name: string;
  kind: "message" | "tool" | "event" | "note";
  text: string;
  stream: string;
  created_at: string | null;
}

/**
 * Recent agent output across active work, parsed the same way the web
 * dashboard's Recent Activity feed parses it (classify → one-line summary),
 * but shaped for JSON so the terminal dashboard can render + colour it without
 * re-implementing every provider's stdout shape. Empty summaries are dropped
 * (an unhandled provider frame summarises to ""). Agent notes (create_note) are
 * merged in as `kind:"note"` — the rare, deliberate signal — interleaved with
 * the streaming output by time, so the feed carries both.
 */
export function buildDashboardActivity(db: Database, limit: number): ActivityJson[] {
  const merged = [...buildOutput(db, limit), ...buildNotes(db, limit)];
  // Newest first (sqlite datetime strings sort lexically); cap to the budget.
  merged.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return merged.slice(0, limit);
}

function buildNotes(db: Database, limit: number): ActivityJson[] {
  const rows = db.prepare(
    `SELECT n.agent_id, COALESCE(a.name, n.agent_id) AS agent_name, n.content, n.created_at
     FROM task_notes n
     LEFT JOIN agents a ON a.id = n.agent_id
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT ?`,
  ).all(limit) as { agent_id: string; agent_name: string; content: string; created_at: string | null }[];
  return rows.map((n) => ({
    agent_id: n.agent_id,
    agent_name: n.agent_name,
    kind: "note" as const,
    text: n.content.replace(/\s+/g, " ").trim(),
    stream: "note",
    created_at: n.created_at ?? null,
  })).filter((r) => r.text.length > 0);
}

function buildOutput(db: Database, limit: number): ActivityJson[] {
  const rows = fetchRecentActivity(db, limit);
  const out: ActivityJson[] = [];
  for (const entry of rows) {
    // The classify + summarize pipeline is shared with the terminal dashboard's
    // per-task output tail (summarizeTerminalLine), so both feeds agree.
    const summarized = summarizeTerminalLine(entry.stream, entry.data);
    if (!summarized) continue;
    out.push({
      agent_id: entry.agent_id,
      agent_name: entry.agent_name,
      kind: summarized.kind,
      text: summarized.text,
      stream: entry.stream,
      created_at: entry.created_at ?? null,
    });
  }
  return out;
}
