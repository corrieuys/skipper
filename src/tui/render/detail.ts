import { Screen, type Style, wrap, clip, textWidth, padEnd } from "./screen";
import type { Rect } from "./layout";
import type { Store } from "../model/store";
import type { ActivityRow, Artifact, TaskDetail, TaskItem } from "../model/types";
import { DETAIL_TABS, type UIState } from "../ui/state";
import { conversation, ago, elapsed, hhmm, shortId, type ConvoItem } from "../ui/view-model";
import { toOneLine, toPlainText } from "../ui/plain-text";
import { C, S, agentColor, statusColor, statusLabel, statusGlyph } from "./theme";
import { panel, phaseStrip, statusPill, orb, lr, scrollbar, breathingCursor } from "./widgets";

export interface DetailDrawResult {
  cursor: { x: number; y: number } | null;
  /** Rows available for scrolling in the active tab body (for page-size keys). */
  bodyRows: number;
}

/**
 * The main pane: one task end-to-end. Header strip (title, status, meta),
 * phase progress, agent orbs, alert banners, then a tabbed body (conversation,
 * live output, notes, artifacts, info) and the input composer.
 */
export function drawDetail(s: Screen, r: Rect, store: Store, ui: UIState, focused: boolean): DetailDrawResult {
  const id = ui.selectedTaskId;
  const task = id ? store.task(id) : undefined;
  const body = panel(s, r, task ? "TASK" : "TASK", { focused, right: task ? shortId(task.id) : undefined });
  if (!task) {
    drawEmpty(s, body, store, ui);
    return { cursor: null, bodyRows: 0 };
  }
  const bundle = store.peekBundle(task.id);
  const detail = bundle?.detail ?? null;
  let y = body.y;
  const x = body.x;
  const w = body.w;
  const bottom = body.y + body.h; // exclusive
  const now = Date.now();

  // ── title + status ──
  const pillW = textWidth(statusLabel(task.display_status)) + 4;
  const titleW = Math.max(w - pillW - 1, 4);
  const star = task.starred ? "★ " : "";
  s.text(x, y, clip(`${star}${task.title || "(untitled)"}`, titleW), { fg: C.textBright, bold: true }, titleW);
  statusPill(s, x + w - pillW, y, task.display_status, ui.frame);
  y++;

  // ── meta line ──
  if (y < bottom) {
    const auto = task.mode === "workflow" ? { t: "⚡ autopilot", st: S.warn } : { t: "☾ manual", st: S.info };
    const parts: Array<[string, Style]> = [];
    if (task.team_name) parts.push([task.team_name, S.accent]);
    parts.push([auto.t, auto.st]);
    if (task.memory_enabled) parts.push([`◈ memory${task.memory_mode !== "run" && task.memory_mode !== "off" ? `:${task.memory_mode}` : ""}`, S.violet]);
    if (task.paused) parts.push(["▮▮ paused", S.orange]);
    if (task.source_scheduled_task_id) parts.push(["↻ recurring run", S.muted]);
    if (task.display_status === "working" && task.started_at) parts.push([`⏱ ${elapsed(task.started_at, now)}`, S.ok]);
    else parts.push([`created ${ago(task.created_at, now)} ago`, S.muted]);
    let cx = x;
    for (let i = 0; i < parts.length; i++) {
      const [t, st] = parts[i]!;
      if (cx - x + textWidth(t) > w) break;
      cx += s.text(cx, y, t, st, w - (cx - x));
      if (i < parts.length - 1) cx += s.text(cx, y, " · ", S.dim, Math.max(w - (cx - x), 0));
    }
    y++;
  }

  // ── phase strip + names ──
  const total = task.phase_count ?? detail?.phases?.length ?? 0;
  if (total > 0 && y < bottom) {
    const used = phaseStrip(s, x, y, task.current_phase, total, ui.frame, Math.min(w, 40));
    const names = detail?.phases?.map((p) => p.name) ?? [];
    if (names.length) {
      let cx = x + used + 2;
      for (let i = 0; i < names.length; i++) {
        const n = names[i]!;
        const st: Style = i < task.current_phase ? S.dim : i === task.current_phase ? S.accentBold : S.muted;
        const label = i === task.current_phase && detail?.phases?.[i]?.review ? `${n}✎` : n;
        if (cx - x + textWidth(label) + 2 > w) break;
        cx += s.text(cx, y, label, st);
        if (i < names.length - 1) cx += s.text(cx, y, " › ", S.dim);
      }
    }
    y++;
  }

  // ── agents ──
  if (y < bottom) {
    const live = store.agentsFor(task.id);
    const tiles = detail?.agent_tiles ?? [];
    let cx = x;
    cx += s.text(cx, y, "agents ", S.dim);
    if (tiles.length === 0 && live.length === 0) {
      s.text(cx, y, task.team_id ? "none live" : "solo", S.dim);
    } else {
      const seen = new Set<string>();
      const entries: Array<{ name: string; active: boolean; count: number }> = tiles.map((t) => ({ name: t.agent_name, active: t.is_active, count: t.instance_count }));
      for (const t of entries) seen.add(t.name);
      for (const a of live) if (!seen.has(a.template_agent_name)) entries.push({ name: a.template_agent_name, active: true, count: 1 });
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        const glyph = orb(e.active, ui.frame, i);
        const label = `${glyph} ${e.name}${e.count > 1 ? `×${e.count}` : ""}`;
        if (cx - x + textWidth(label) + 2 > w) break;
        cx += s.text(cx, y, label, e.active ? { fg: agentColor(e.name), bold: true } : S.dim);
        cx += 2;
      }
    }
    y++;
  }

  // ── alert banners ──
  const escs = store.escalationsFor(task.id);
  if (escs.length && y < bottom) {
    const e = escs[0]!;
    const blink = Math.floor(ui.frame / 3) % 2 === 0;
    const head = `${blink ? "▲" : "△"} ESCALATION ${e.agentName ? `from ${e.agentName} ` : ""}`;
    s.fill(x, y, w, 1, " ", { bg: 52 });
    let cx = x + s.text(x, y, head, { fg: C.danger, bg: 52, bold: true }, w);
    cx += s.text(cx, y, clip(toOneLine(e.question), Math.max(w - (cx - x) - 14, 0)), { fg: C.textBright, bg: 52 });
    s.text(x + w - 12, y, " E respond ", { fg: C.textBright, bg: C.danger, bold: true });
    y++;
  }
  if (task.needs_review && y < bottom) {
    s.fill(x, y, w, 1, " ", { bg: 54 });
    let cx = x + s.text(x, y, "◆ REVIEW GATE ", { fg: C.violet, bg: 54, bold: true });
    cx += s.text(cx, y, `phase ${Math.min(task.current_phase + 1, total || task.current_phase + 1)} awaits your verdict`, { fg: C.textBright, bg: 54 });
    const act = " y approve  N reject ";
    s.text(x + w - textWidth(act), y, act, { fg: C.onAccent, bg: C.violet, bold: true });
    y++;
  }
  if (detail?.result && task.status === "settled" && y < bottom) {
    const err = (detail.result as { error?: unknown } | null)?.error;
    const txt = err ? `✗ ${String(err)}` : "✓ completed";
    s.text(x, y, clip(txt.replace(/\s+/g, " "), w), err ? S.danger : S.info, w);
    y++;
  }

  // ── tabs ──
  if (y < bottom) {
    let cx = x;
    for (const t of DETAIL_TABS) {
      const active = t.id === ui.detailTab;
      const count = tabCount(store, task.id, t.id);
      const label = count !== null && count > 0 ? `${t.label} ${count}` : t.label;
      const st: Style = active ? { fg: C.textBright, bold: true, bg: C.bgSelected } : S.muted;
      if (cx - x + textWidth(label) + 4 > w) break;
      cx += s.text(cx, y, ` ${label} `, st);
      cx += 1;
    }
    if (bundle?.loading) s.text(x + w - 8, y, "loading…", S.dim);
    y++;
    s.hline(x, y, w, "─", S.border);
    y++;
  }

  // ── composer (reserve rows at the bottom) ──
  const composerRows = ui.composerActive ? Math.min(Math.max(2, ui.composer.lines().length + 1), 6) : 1;
  const composerY = bottom - composerRows;
  const bodyRect: Rect = { x, y, w, h: Math.max(composerY - y - 1, 0) };
  const cursor = drawComposer(s, { x, y: composerY, w, h: composerRows }, ui, task);

  // ── body ──
  if (bodyRect.h > 0) {
    switch (ui.detailTab) {
      case "conversation":
        drawConversation(s, bodyRect, store, task, ui);
        break;
      case "output":
        drawOutput(s, bodyRect, bundle?.output ?? [], ui, store.connStatus() === "connected");
        break;
      case "notes":
        drawNotes(s, bodyRect, store, task, ui);
        break;
      case "artifacts":
        drawArtifacts(s, bodyRect, store, task, ui);
        break;
      case "info":
        drawInfo(s, bodyRect, task, detail, ui);
        break;
    }
  }
  // separator above composer
  if (composerY - 1 >= y) s.hline(x, composerY - 1, w, "╌", S.border);
  return { cursor, bodyRows: bodyRect.h };
}

function tabCount(store: Store, taskId: string, tab: string): number | null {
  const b = store.peekBundle(taskId);
  if (!b) return null;
  switch (tab) {
    case "notes":
      return b.notes.filter((n) => !n.deletedAt).length;
    case "artifacts":
      return b.artifacts.length;
    case "output":
      return b.output.length;
    default:
      return null;
  }
}

function drawEmpty(s: Screen, r: Rect, store: Store, ui: UIState): void {
  const lines = [
    "",
    "   ╭─────────────────────────────╮",
    "   │  no task selected           │",
    "   ╰─────────────────────────────╯",
    "",
    "   ↑↓  pick a task in the rail",
    "   n   create a new task",
    "   I   import a team from JSON",
    "   :   command palette",
    "   ?   every key",
  ];
  if (!store.isHydrated) lines.splice(2, 1, `   │  ${padEnd(`connecting ${breathingCursor(ui.frame)}`, 27)}│`);
  for (let i = 0; i < lines.length && i < r.h; i++) s.text(r.x, r.y + i, lines[i]!, i === 2 ? S.bright : S.muted, r.w);
}

// ── composer ──────────────────────────────────────────────────────────────

function drawComposer(s: Screen, r: Rect, ui: UIState, task: TaskItem): { x: number; y: number } | null {
  if (r.h <= 0) return null;
  const prompt = "▶ ";
  const pw = textWidth(prompt);
  if (!ui.composerActive) {
    const hint =
      task.status === "draft"
        ? "i  append to the draft description"
        : task.needs_review
          ? "i  type your review response"
          : task.status === "settled"
            ? "i  send input to revive this task"
            : "i  message the task";
    s.text(r.x, r.y, prompt, S.dim);
    s.text(r.x + pw, r.y, hint, S.dim, r.w - pw);
    return null;
  }
  s.text(r.x, r.y, prompt, S.accentBold);
  const view = ui.composer.view(r.w - pw, r.h, 0);
  for (let i = 0; i < r.h; i++) {
    const row = view.rows[view.top + i] ?? "";
    s.text(r.x + pw, r.y + i, padEnd(row, r.w - pw), S.bright, r.w - pw);
  }
  if (ui.composer.length === 0) s.text(r.x + pw, r.y, "type, enter to send · ctrl+j newline · esc cancel", S.dim, r.w - pw);
  const cy = r.y + (view.caret.row - view.top);
  return { x: r.x + pw + view.caret.col, y: Math.min(Math.max(cy, r.y), r.y + r.h - 1) };
}

// ── bodies ────────────────────────────────────────────────────────────────

interface StyledLine {
  text: string;
  st: Style;
  /** Optional prefix drawn in its own style (timestamp / speaker). */
  prefix?: { text: string; st: Style };
}

/** Draw bottom-anchored lines with scrollback `scroll` rows from the newest. */
function drawAnchored(s: Screen, r: Rect, lines: StyledLine[], scroll: number, emptyText: string, live: boolean, frame: number): void {
  if (lines.length === 0) {
    s.text(r.x, r.y, emptyText, S.dim, r.w);
    return;
  }
  const maxScroll = Math.max(lines.length - r.h, 0);
  const sc = Math.min(Math.max(scroll, 0), maxScroll);
  const start = Math.max(lines.length - r.h - sc, 0);
  const usable = lines.length > r.h ? r.w - 1 : r.w;
  // Pin to the bottom: when fewer lines than rows, start drawing lower.
  const offset = Math.max(r.h - lines.length, 0);
  for (let i = 0; i < r.h - offset; i++) {
    const ln = lines[start + i];
    if (!ln) break;
    const y = r.y + offset + i;
    let cx = r.x;
    if (ln.prefix) cx += s.text(cx, y, ln.prefix.text, ln.prefix.st, usable);
    s.text(cx, y, ln.text, ln.st, Math.max(usable - (cx - r.x), 0));
  }
  if (lines.length > r.h) scrollbar(s, r, lines.length, start, r.h);
  if (sc > 0) {
    const tag = ` ↓ ${sc} newer `;
    s.text(r.x + usable - textWidth(tag), r.y + r.h - 1, tag, { fg: C.onAccent, bg: C.warn, bold: true });
  } else if (live) {
    s.put(r.x + usable - 1, r.y + r.h - 1, breathingCursor(frame), S.accent);
  }
}

function drawConversation(s: Screen, r: Rect, store: Store, task: TaskItem, ui: UIState): void {
  const items = conversation(store, task.id);
  const lines: StyledLine[] = [];
  const prefixW = 7; // "HH:MM "
  const textW = Math.max(r.w - 1 - prefixW - 2, 8);
  for (const it of items) lines.push(...convoLines(it, textW, prefixW));
  const b = store.peekBundle(task.id);
  const empty = b?.loading ? "loading timeline…" : b?.error ? `✗ ${b.error}` : "nothing on the timeline yet. press i to send the first message.";
  drawAnchored(s, r, lines, ui.detailScroll, empty, store.connStatus() === "connected", ui.frame);
}

function convoLines(it: ConvoItem, textW: number, prefixW: number): StyledLine[] {
  const out: StyledLine[] = [];
  const time = hhmm(it.ts);
  let who: string;
  let whoSt: Style;
  let bodySt: Style;
  switch (it.side) {
    case "you":
      who = `you${it.tag ? ` ⟨${it.tag}⟩` : ""}`;
      whoSt = { fg: C.accent, bold: true };
      bodySt = S.bright;
      break;
    case "agent":
      who = it.who;
      whoSt = { fg: agentColor(it.who), bold: true };
      bodySt = S.text;
      break;
    case "note":
      who = `★ ${it.who}`;
      whoSt = { fg: C.orange, bold: true };
      bodySt = S.orange;
      break;
    case "escalation":
      who = `▲ ${it.who} escalates${it.tag ? ` (${it.tag})` : ""}`;
      whoSt = { fg: C.danger, bold: true };
      bodySt = S.danger;
      break;
    case "system":
      who = it.who;
      whoSt = S.muted;
      bodySt = S.muted;
      break;
    default:
      who = it.who;
      whoSt = S.muted;
      bodySt = S.muted;
  }
  out.push({ prefix: { text: padEnd(time, prefixW), st: S.dim }, text: who, st: whoSt });
  const wrapped = wrap(it.text.trim(), textW);
  const MAX = 30;
  const shown = wrapped.length > MAX ? wrapped.slice(0, MAX - 1) : wrapped;
  for (const l of shown) out.push({ prefix: { text: " ".repeat(prefixW), st: S.dim }, text: l, st: bodySt });
  if (wrapped.length > MAX) out.push({ prefix: { text: " ".repeat(prefixW), st: S.dim }, text: `… ${wrapped.length - shown.length} more lines`, st: S.dim });
  return out;
}

export function activityLine(a: ActivityRow, w: number, showAgent = true): StyledLine {
  const t = hhmm(a.created_at);
  let tag: string;
  let tagSt: Style;
  let bodySt: Style;
  switch (a.kind) {
    case "note":
      tag = "★";
      tagSt = S.orange;
      bodySt = S.orange;
      break;
    case "tool":
      tag = "⚙";
      tagSt = S.warn;
      bodySt = S.muted;
      break;
    case "message":
      tag = "▓";
      tagSt = S.accent;
      bodySt = S.text;
      break;
    default:
      tag = "·";
      tagSt = S.dim;
      bodySt = S.dim;
  }
  const who = showAgent ? clip(a.agent_name, 10) : "";
  const prefix = `${t} ${tag} `;
  void tagSt;
  void w;
  return {
    prefix: { text: prefix, st: a.kind === "note" ? S.orange : a.kind === "tool" ? S.warn : a.kind === "message" ? S.accent : S.dim },
    text: (who ? `${who} ` : "") + a.text,
    st: bodySt,
  };
}

function drawOutput(s: Screen, r: Rect, rows: ActivityRow[], ui: UIState, live: boolean): void {
  const lines = rows.map((a) => activityLine(a, r.w));
  drawAnchored(s, r, lines, ui.detailScroll, "no activity yet. the live agent output tail appears here while agents work.", live, ui.frame);
}

function drawNotes(s: Screen, r: Rect, store: Store, task: TaskItem, ui: UIState): void {
  const b = store.peekBundle(task.id);
  // Newest first, like the Artifacts tab.
  const notes = [...(b?.notes ?? [])].sort((a, c) => (c.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const lines: StyledLine[] = [];
  const textW = Math.max(r.w - 3, 8);
  for (const n of notes) {
    const head = `★ ${n.agentName ?? (n.source === "user" ? "you" : "agent")}  ${hhmm(n.createdAt)}${n.deletedAt ? "  (deleted)" : ""}`;
    lines.push({ text: head, st: n.deletedAt ? S.dim : { fg: C.orange, bold: true } });
    for (const l of wrap(toPlainText(n.content).trim(), textW)) lines.push({ text: "  " + l, st: n.deletedAt ? S.dim : S.text });
    lines.push({ text: "", st: S.text });
  }
  if (lines.length === 0) {
    s.text(r.x, r.y, b?.loading ? "loading…" : "no notes. agents post notes with create_note; + adds your own.", S.dim, r.w);
    return;
  }
  drawTopAnchored(s, r, lines, ui.detailScroll);
}

/** Draw top-anchored lines with `scroll` rows hidden above (info, notes). */
function drawTopAnchored(s: Screen, r: Rect, lines: StyledLine[], scroll: number): void {
  const top = Math.min(Math.max(scroll, 0), Math.max(lines.length - r.h, 0));
  for (let i = 0; i < r.h; i++) {
    const ln = lines[top + i];
    if (!ln) break;
    let cx = r.x;
    if (ln.prefix) cx += s.text(cx, r.y + i, ln.prefix.text, ln.prefix.st, r.w - 1);
    s.text(cx, r.y + i, ln.text, ln.st, Math.max(r.w - 1 - (cx - r.x), 0));
  }
  scrollbar(s, r, lines.length, top, r.h);
}

/** Artifacts newest first; the sort every view of this list shares. */
export function sortedArtifacts(store: Store, taskId: string): Artifact[] {
  return [...(store.peekBundle(taskId)?.artifacts ?? [])].sort((a, c) => c.createdAt.localeCompare(a.createdAt));
}

function drawArtifacts(s: Screen, r: Rect, store: Store, task: TaskItem, ui: UIState): void {
  const b = store.peekBundle(task.id);
  const arts = sortedArtifacts(store, task.id);
  if (arts.length === 0) {
    s.text(r.x, r.y, b?.loading ? "loading…" : "no artifacts yet.", S.dim, r.w);
    return;
  }
  const sel = Math.min(Math.max(ui.artifactIndex, 0), arts.length - 1);
  // Keep the selected row visible.
  let top = Math.min(Math.max(ui.detailScroll, 0), Math.max(arts.length - r.h, 0));
  if (sel < top) top = sel;
  if (sel >= top + r.h) top = sel - r.h + 1;
  ui.detailScroll = top;
  for (let i = 0; i < r.h; i++) {
    const a = arts[top + i];
    if (!a) break;
    const y = r.y + i;
    const selected = top + i === sel;
    const bg = selected ? C.bgSelected : undefined;
    if (selected) s.fill(r.x, y, r.w - 1, 1, " ", { bg });
    const size = a.bytes != null ? humanBytes(a.bytes) : a.storage;
    const pub = a.publishedAt ? " ⇡ public" : "";
    const fmt = a.format ? `  ${a.format}` : "";
    lr(
      s,
      r.x,
      y,
      r.w - 1,
      `${selected ? "▸" : " "} ${a.storage === "file" ? "▣" : "▤"} ${a.name}  v${a.version}  ${a.kind}${fmt}${pub}`,
      { fg: a.publishedAt ? C.ok : selected ? C.textBright : C.text, bg, bold: selected },
      `${size}  ${hhmm(a.createdAt)}`,
      { fg: C.textMuted, bg },
    );
  }
  scrollbar(s, r, arts.length, top, r.h);
}

function drawInfo(s: Screen, r: Rect, task: TaskItem, detail: TaskDetail | null, ui: UIState): void {
  const lines: StyledLine[] = [];
  const kv = (k: string, v: string | null | undefined, st: Style = S.text) => {
    if (v == null || v === "") return;
    lines.push({ prefix: { text: padEnd(k, 12), st: S.dim }, text: v, st });
  };
  kv("id", task.id, S.muted);
  kv("status", `${task.status} → ${task.display_status}`, { fg: statusColor(task.display_status) });
  kv("mode", task.mode === "workflow" ? "workflow (autopilot on)" : "conversational (operator-driven)");
  kv("team", task.team_name ? `${task.team_name}  ${task.team_id ?? ""}` : "none (solo)");
  kv("memory", task.memory_enabled ? `on (${task.memory_mode})` : "off");
  kv("starred", task.starred ? "yes" : "no");
  if (task.icon) kv("icon", `${task.icon}${task.icon_color ? ` ${task.icon_color}` : ""}`);
  kv("created", task.created_at);
  kv("started", task.started_at);
  kv("updated", task.updated_at);
  if (detail) {
    kv("completed", detail.completed_at);
    kv("settled", detail.settled_at);
    kv("cwd", detail.working_directory, S.muted);
    if (detail.regression_count) kv("regressions", String(detail.regression_count), S.warn);
    if (detail.run_input) kv("run input", detail.run_input.replace(/\s+/g, " "));
    lines.push({ text: "", st: S.text });
    lines.push({ text: "DESCRIPTION", st: S.accentBold });
    const desc = detail.description?.trim() || "(none)";
    for (const l of wrap(desc, Math.max(r.w - 2, 8))) lines.push({ text: l, st: detail.description ? S.text : S.dim });
    if (detail.phases?.length) {
      lines.push({ text: "", st: S.text });
      lines.push({ text: "PHASES", st: S.accentBold });
      detail.phases.forEach((p, i) => {
        const mark = i < task.current_phase ? "✓" : i === task.current_phase ? statusGlyph("working", ui.frame) : "○";
        lines.push({ text: `${mark} ${i + 1}. ${p.name}${p.review ? "  ✎ review" : ""}`, st: i === task.current_phase ? S.accentBold : i < task.current_phase ? S.dim : S.text });
        const prompt = p.prompt?.trim();
        if (prompt) for (const l of wrap(prompt, Math.max(r.w - 6, 8)).slice(0, 3)) lines.push({ text: "     " + l, st: S.muted });
      });
    }
    if (detail.result != null) {
      lines.push({ text: "", st: S.text });
      lines.push({ text: "RESULT", st: S.accentBold });
      const txt = typeof detail.result === "string" ? detail.result : JSON.stringify(detail.result, null, 2);
      for (const l of wrap(txt, Math.max(r.w - 2, 8)).slice(0, 40)) lines.push({ text: l, st: S.muted });
    }
  } else {
    lines.push({ text: "", st: S.text });
    lines.push({ text: "loading detail…", st: S.dim });
  }
  drawTopAnchored(s, r, lines, ui.detailScroll);
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
