import type { Database } from "bun:sqlite";
import { fetchRecentActivity } from "../data/queries";
import { parseJsonLine } from "../html/components";
import { terminalJsonSummary, stripThinking, classifyPlainTerminalLine } from "../html/terminalJsonSummary";

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
    const data = entry.data.trim();
    const parsed = parseJsonLine(data);
    let text: string;

    if (parsed) {
      if (isNoiseEvent(parsed)) continue;
      // A JSON frame with no prose summary (unknown shape, plumbing event) is
      // dropped — never fall back to dumping the raw JSON into the feed.
      const summary = terminalJsonSummary(parsed);
      if (!summary) continue;
      text = summary;
    } else {
      // Plain (non-JSON) stdout line — show the text itself.
      text = data.length > 200 ? data.slice(0, 200) + "…" : data;
    }

    const kind = classifyKind(entry.stream, data, parsed);
    if (kind === "message") text = stripThinking(text);
    text = text.replace(/\s+/g, " ").trim();
    if (!text) continue;

    out.push({
      agent_id: entry.agent_id,
      agent_name: entry.agent_name,
      kind,
      text,
      stream: entry.stream,
      created_at: entry.created_at ?? null,
    });
  }
  return out;
}

/** Pure plumbing frames that carry no user-facing signal — dropped from the feed. */
function isNoiseEvent(parsed: Record<string, unknown>): boolean {
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type === "rate_limit_event") return true;
  if (type === "system") {
    // Keep task notifications; drop hook/init/session lifecycle chatter.
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
    return subtype !== "task_notification";
  }
  return false;
}

function classifyKind(
  stream: string,
  data: string,
  parsed: Record<string, unknown> | null,
): "message" | "tool" | "event" {
  if (!parsed) {
    return classifyPlainTerminalLine(stream, data);
  }
  const type = typeof parsed.type === "string" ? parsed.type : "";
  const item = parsed.item && typeof parsed.item === "object" ? (parsed.item as Record<string, unknown>) : null;
  const itemType = item && typeof item.type === "string" ? item.type : "";
  const message = parsed.message && typeof parsed.message === "object" ? (parsed.message as Record<string, unknown>) : null;
  const content = message?.content;

  if (itemType === "command_execution" || itemType === "tool_call" || itemType === "tool_result" || itemType === "tool_use" || type.includes("tool")) {
    return "tool";
  }
  if (Array.isArray(content)) {
    const hasTool = content.some((b) => {
      if (!b || typeof b !== "object") return false;
      const bt = (b as Record<string, unknown>).type;
      return bt === "tool_use" || bt === "tool_result";
    });
    if (hasTool) return "tool";
  }
  if (
    type === "assistant" || type === "user" || type === "message" ||
    itemType === "agent_message" || itemType === "text" ||
    typeof parsed.result === "string" ||
    ((type === "text" || type === "thought") && typeof parsed.data === "string") ||
    (type === "text" && !!(parsed.part as Record<string, unknown> | undefined)?.text) ||
    (item && typeof item.text === "string" && itemType !== "command_execution")
  ) {
    return "message";
  }
  return "event";
}
