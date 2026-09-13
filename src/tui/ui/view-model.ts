import type { Store } from "../model/store";
import type { TaskItem, RecurringSeries, ActivityRow } from "../model/types";
import type { UIState, Filter } from "./state";
import { STATUS_ORDER } from "../render/theme";
import { toPlainText } from "./plain-text";

/** Pure selectors from store + ui state → what the views draw. No I/O. */

export type RailRow = { kind: "task"; task: TaskItem } | { kind: "series"; series: RecurringSeries };

export function applyFilter(tasks: TaskItem[], filter: Filter): TaskItem[] {
  switch (filter) {
    case "active":
      return tasks.filter((t) => t.status === "active" && !t.source_scheduled_task_id).concat(
        // recurring runs that are live still belong on the active board
        tasks.filter((t) => t.status === "active" && !!t.source_scheduled_task_id && t.display_status !== "idle"),
      );
    case "drafts":
      return tasks.filter((t) => t.status === "draft");
    case "starred":
      return tasks.filter((t) => t.starred);
    case "done":
      return tasks.filter((t) => t.status === "settled");
    case "all":
      return tasks;
    case "recurring":
      return [];
  }
}

const rank = new Map(STATUS_ORDER.map((s, i) => [s, i]));

export function sortTasks(tasks: TaskItem[]): TaskItem[] {
  return [...tasks].sort((a, b) => {
    const ra = rank.get(a.display_status as never) ?? 99;
    const rb = rank.get(b.display_status as never) ?? 99;
    if (ra !== rb) return ra - rb;
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    const ta = a.updated_at ?? a.created_at;
    const tb = b.updated_at ?? b.created_at;
    return tb.localeCompare(ta);
  });
}

export function matchesSearch(t: TaskItem, q: string): boolean {
  if (!q) return true;
  const hay = `${t.title} ${t.team_name ?? ""} ${t.display_status} ${t.id}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

export function railRows(store: Store, ui: UIState): RailRow[] {
  if (ui.filter === "recurring") {
    const q = ui.search.value.trim().toLowerCase();
    return ui.recurring
      .filter((s) => !q || `${s.title} ${s.teamName ?? ""} ${s.status}`.toLowerCase().includes(q))
      .map((series) => ({ kind: "series" as const, series }));
  }
  const q = ui.search.value.trim();
  // Dedupe (the active filter concatenates two slices).
  const seen = new Set<string>();
  const list = applyFilter(store.allTasks(), ui.filter).filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return matchesSearch(t, q);
  });
  return sortTasks(list).map((task) => ({ kind: "task" as const, task }));
}

export function selectedIndex(rows: RailRow[], ui: UIState): number {
  if (ui.filter === "recurring") return rows.findIndex((r) => r.kind === "series" && r.series.id === ui.selectedSeriesId);
  return rows.findIndex((r) => r.kind === "task" && r.task.id === ui.selectedTaskId);
}

// ── conversation merge ────────────────────────────────────────────────────

export interface ConvoItem {
  ts: string | null;
  who: string;
  side: "you" | "agent" | "note" | "escalation" | "system" | "output";
  text: string;
  tag?: string;
}

export function conversation(store: Store, taskId: string): ConvoItem[] {
  const b = store.peekBundle(taskId);
  const items: ConvoItem[] = [];
  if (!b) return items;
  for (const e of b.timeline) {
    if (e.entryType === "image" || e.entryType === "file") {
      items.push({ ts: e.createdAt, who: "you", side: "you", text: e.content || e.artifactName || "(file)", tag: e.entryType === "image" ? "image" : "file" });
    } else if (e.entryType === "error") {
      items.push({ ts: e.createdAt, who: "pipeline", side: "system", text: e.content, tag: "error" });
    } else if (e.entryType === "summary" || e.entryType === "transcript") {
      items.push({ ts: e.createdAt, who: "you", side: "you", text: e.content, tag: e.entryType === "summary" ? "audio" : "transcript" });
    } else {
      items.push({ ts: e.createdAt, who: "you", side: "you", text: e.content, tag: e.fedToSkipper ? undefined : "queued" });
    }
  }
  for (const m of b.messages) items.push({ ts: m.createdAt, who: m.agentName ?? "agent", side: "agent", text: toPlainText(m.content, m.format) });
  for (const n of b.notes) {
    if (n.deletedAt) continue;
    items.push({ ts: n.createdAt, who: n.agentName ?? (n.source === "user" ? "you" : "agent"), side: "note", text: toPlainText(n.content) });
  }
  for (const e of store.escalationsFor(taskId)) {
    items.push({ ts: e.createdAt, who: e.agentName ?? "agent", side: "escalation", text: toPlainText(e.question), tag: e.type });
  }
  // escalations/list ships raw rows (no agent name join); resolve the name from the task's roster.
  const nameOf = (agentId: string) => b.detail?.agent_tiles.find((t) => t.template_agent_id === agentId)?.agent_name ?? store.task(taskId)?.team_name ?? "agent";
  for (const e of b.resolvedEscalations) {
    items.push({ ts: e.createdAt, who: e.agentName ?? nameOf(e.agentId), side: "escalation", text: toPlainText(e.question), tag: `${e.type} · answered` });
    if (e.response) items.push({ ts: e.createdAt, who: "you", side: "you", text: e.response, tag: "answer" });
  }
  items.sort((a, b2) => sortKey(a.ts).localeCompare(sortKey(b2.ts)));
  return items;
}

function sortKey(ts: string | null): string {
  const d = parseTime(ts);
  return d ? d.toISOString() : "";
}

// ── time helpers ──────────────────────────────────────────────────────────

/** sqlite "YYYY-MM-DD HH:MM:SS[.fff]" (UTC) or ISO → Date. */
export function parseTime(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const s = iso.includes("T") ? iso : iso.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? "" : "Z");
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function hhmm(iso: string | null | undefined): string {
  const d = parseTime(iso);
  if (!d) return "--:--";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function clock(now: Date): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

/** Compact age: 12s, 4m, 3h, 2d. Empty for unknown. */
export function ago(iso: string | null | undefined, nowMs = Date.now()): string {
  const d = parseTime(iso);
  if (!d) return "";
  const s = Math.max(Math.floor((nowMs - d.getTime()) / 1000), 0);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Elapsed hh:mm:ss from an instant (running timers). */
export function elapsed(iso: string | null | undefined, nowMs = Date.now()): string {
  const d = parseTime(iso);
  if (!d) return "";
  const s = Math.max(Math.floor((nowMs - d.getTime()) / 1000), 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Activity volume per minute over the last `buckets` minutes, oldest first. */
export function activitySparkline(activity: ActivityRow[], nowMs = Date.now(), buckets = 12): number[] {
  const out = new Array<number>(buckets).fill(0);
  for (const a of activity) {
    const d = parseTime(a.created_at);
    if (!d) continue;
    const ageMin = Math.floor((nowMs - d.getTime()) / 60_000);
    if (ageMin < 0 || ageMin >= buckets) continue;
    out[buckets - 1 - ageMin]! += 1;
  }
  return out;
}

export function scheduleLabel(s: RecurringSeries): string {
  if (s.scheduleUnit && s.scheduleAmount) return `every ${s.scheduleAmount} ${s.scheduleUnit}`;
  return "manual";
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
