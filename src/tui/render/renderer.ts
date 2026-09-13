import { Screen, type Style, clip, textWidth, padEnd, wrap } from "./screen";
import { computeLayout, centered, type Rect, type Layout } from "./layout";
import { TerminalDriver } from "./terminal";
import type { Store } from "../model/store";
import type { TaskItem, RecurringSeries } from "../model/types";
import { FILTERS, type UIState, type Modal, type FormModal, type ListModal, type TextModal, type ConfirmModal, topModal, visibleListItems } from "../ui/state";
import { railRows, selectedIndex, ago, clock, activitySparkline, scheduleLabel, hhmm, type RailRow } from "../ui/view-model";
import { C, S, BRAND_RAMP, PULSE, statusColor, statusGlyph, agentColor } from "./theme";
import { panel, phaseStrip, sparkline, lr, keyHints, scrollbar, dimAll, shadow, breathingCursor } from "./widgets";
import { drawDetail, activityLine } from "./detail";
import { footerHints } from "../ui/hints";

export interface RenderModel {
  store: Store;
  ui: UIState;
}

export interface FrameResult {
  cursor: { x: number; y: number } | null;
  layout: Layout;
  /** Visible row capacity of the rail and the detail body (for paging keys). */
  railRows: number;
  detailBodyRows: number;
  feedRows: number;
}

/**
 * The drawing backend: composes one Screen per frame from the store + ui
 * state and paints only the cells that changed since the last frame.
 */
export class Renderer {
  private prev: Screen | null = null;
  lastFrame: FrameResult | null = null;

  constructor(private readonly driver: TerminalDriver = new TerminalDriver()) {}

  mount(): void {
    this.driver.mount();
    this.prev = null;
  }

  unmount(): void {
    this.driver.unmount();
  }

  size(): { cols: number; rows: number } {
    return this.driver.size();
  }

  onResize(cb: () => void): void {
    this.driver.onResize(() => {
      this.prev = null;
      cb();
    });
  }

  render(model: RenderModel): FrameResult {
    const { cols, rows } = this.driver.size();
    const screen = new Screen(cols, rows, { fg: C.text });
    const result = drawFrame(screen, model);
    const out = screen.diff(this.prev);
    this.prev = screen;
    this.driver.paint(out, result.cursor);
    this.lastFrame = result;
    return result;
  }
}

/** Pure: draw a whole frame onto `s`. Exported for tests. */
export function drawFrame(s: Screen, model: RenderModel): FrameResult {
  const { store, ui } = model;
  const layout = computeLayout(s.cols, s.rows);
  const effective = effectiveLayout(layout, ui);
  drawHeader(s, effective.header, model);
  const rows = railRows(store, ui);
  let railCapacity = 0;
  let detailBodyRows = 0;
  let feedRows = 0;
  let cursor: { x: number; y: number } | null = null;

  const focusOf = (pane: "rail" | "main" | "feed") => ui.focus === pane && ui.modals.length === 0;

  if (effective.rail) railCapacity = drawRail(s, effective.rail, rows, model, focusOf("rail"));
  if (effective.feed) feedRows = drawFeed(s, effective.feed, model, focusOf("feed"));
  if (effective.main) {
    if (effective.mode === "single" && ui.singleView === "rail") railCapacity = drawRail(s, effective.main, rows, model, true);
    else if (effective.mode === "single" && ui.singleView === "feed") feedRows = drawFeed(s, effective.main, model, true);
    else {
      const d = drawDetail(s, effective.main, store, ui, focusOf("main"));
      detailBodyRows = d.bodyRows;
      if (ui.modals.length === 0) cursor = d.cursor;
    }
  }
  drawFooter(s, effective.footer, model);

  const modal = topModal(ui);
  if (modal) {
    dimAll(s);
    cursor = drawModal(s, modal, ui);
  }
  drawToasts(s, ui, effective.footer);
  return { cursor, layout: effective, railRows: railCapacity, detailBodyRows, feedRows };
}

/** Apply the operator's "hide feed" preference to the pure layout. */
function effectiveLayout(l: Layout, ui: UIState): Layout {
  if (l.mode === "triple" && ui.feedHidden && l.feed && l.main) {
    return { ...l, mode: "double", feed: null, main: { ...l.main, w: l.main.w + l.feed.w } };
  }
  return l;
}

// ── header ────────────────────────────────────────────────────────────────

function drawHeader(s: Screen, r: Rect, model: RenderModel): void {
  const { store, ui } = model;
  const f = ui.frame;
  s.fill(r.x, r.y, r.w, 1, " ", { bg: C.bgRaised });
  // Brand mark with a colour sweep.
  const brand = "SKIPPER";
  let cx = r.x + 1;
  cx += s.text(cx, r.y, "◆ ", { fg: BRAND_RAMP[f % BRAND_RAMP.length], bg: C.bgRaised, bold: true });
  for (let i = 0; i < brand.length; i++) {
    s.put(cx++, r.y, brand[i]!, { fg: BRAND_RAMP[(f + i * 2) % BRAND_RAMP.length]!, bg: C.bgRaised, bold: true });
  }
  cx += s.text(cx, r.y, " bridge", { fg: C.textMuted, bg: C.bgRaised });
  cx += 2;
  // Connection pulse + transport.
  const conn = store.connStatus();
  const dot =
    conn === "connected"
      ? { ch: PULSE[f % PULSE.length]!, st: { fg: C.ok, bg: C.bgRaised } }
      : conn === "closed"
        ? { ch: "●", st: { fg: C.danger, bg: C.bgRaised } }
        : { ch: f % 2 ? "●" : "○", st: { fg: C.warn, bg: C.bgRaised } };
  s.put(cx++, r.y, dot.ch, dot.st);
  cx += s.text(cx, r.y, ` ${ui.transportLabel}${conn === "connected" ? "" : ` ${conn}`}`, { fg: C.textMuted, bg: C.bgRaised });
  if (store.authError) cx += s.text(cx, r.y, `  ✗ ${store.authError}`, { fg: C.danger, bg: C.bgRaised, bold: true }, Math.max(r.w - 70 - (cx - r.x), 0));
  cx += 2;
  // Activity sparkline (last 12 minutes).
  const spark = activitySparkline(store.recentActivity(), Date.now(), 12);
  if (cx + 14 < r.x + r.w - 60) {
    cx += sparkline(s, cx, r.y, spark, { fg: C.accent, bg: C.bgRaised });
    cx += 2;
  }

  // Right side: metric chips + clock.
  const c = store.counts();
  const m = store.metricsNow();
  const chips: Array<[string, number, number]> = [
    [(c.working ?? 0) > 0 ? statusGlyph("working", f) : "⠿", c.working ?? 0, C.ok],
    ["◉", c.queued ?? 0, C.warn],
    ["◆", c.review ?? 0, C.violet],
    ["▲", Math.max(c.blocked ?? 0, c.escalations ?? 0), C.danger],
    ["▮▮", c.paused ?? 0, C.orange],
    ["⬢", m.activeAgentCount || c.agents || 0, C.accent],
  ];
  const labels = ["working", "queued", "review", "blocked", "paused", "agents"];
  const time = clock(new Date());
  let right = "";
  const parts: Array<{ text: string; st: Style }> = [];
  chips.forEach(([g, n, color], i) => {
    if (n === 0 && i !== 0 && i !== 5) return;
    parts.push({ text: `${g} ${n}`, st: { fg: n > 0 ? color : C.textDim, bg: C.bgRaised, bold: n > 0 } });
    parts.push({ text: ` ${labels[i]}  `, st: { fg: C.textDim, bg: C.bgRaised } });
  });
  parts.push({ text: time, st: { fg: C.textBright, bg: C.bgRaised, bold: true } });
  right = parts.map((p) => p.text).join("");
  let rx = r.x + r.w - 1 - textWidth(right);
  if (rx > cx) {
    for (const p of parts) rx += s.text(rx, r.y, p.text, p.st);
  } else {
    s.text(r.x + r.w - 1 - textWidth(time), r.y, time, { fg: C.textBright, bg: C.bgRaised, bold: true });
  }

  // Row 2: filter tabs + search.
  if (r.h < 2) return;
  const y = r.y + 1;
  s.fill(r.x, y, r.w, 1, " ", { bg: C.bgPanel });
  cx = r.x + 1;
  const all = store.allTasks();
  for (const flt of FILTERS) {
    const active = ui.filter === flt.id;
    const count = flt.id === "recurring" ? ui.recurring.length : countFor(all, flt.id);
    const label = `${flt.key} ${flt.label}${count > 0 ? ` ${count}` : ""}`;
    const st: Style = active ? { fg: C.textBright, bg: C.bgSelected, bold: true } : { fg: C.textMuted, bg: C.bgPanel };
    if (cx - r.x + textWidth(label) + 3 > r.w - 24) break;
    cx += s.text(cx, y, ` ${label} `, st);
    cx += 1;
  }
  // Search box.
  const q = ui.search.value;
  const box = ui.searchActive ? `/ ${q}` : q ? `/ ${q}` : "/ filter";
  const bw = Math.min(Math.max(textWidth(box) + 2, 12), 30);
  const bx = r.x + r.w - 1 - bw;
  s.text(bx, y, padEnd(` ${box}`, bw), ui.searchActive ? { fg: C.textBright, bg: C.bgSelected } : { fg: q ? C.accent : C.textDim, bg: C.bgPanel }, bw);
  if (ui.searchActive) s.put(bx + 1 + textWidth(box) + 0, y, breathingCursor(f), { fg: C.accent, bg: C.bgSelected });
}

function countFor(all: TaskItem[], filter: string): number {
  switch (filter) {
    case "active":
      return all.filter((t) => t.status === "active").length;
    case "drafts":
      return all.filter((t) => t.status === "draft").length;
    case "starred":
      return all.filter((t) => t.starred).length;
    case "done":
      return all.filter((t) => t.status === "settled").length;
    case "all":
      return all.length;
    default:
      return 0;
  }
}

// ── rail ──────────────────────────────────────────────────────────────────

function drawRail(s: Screen, r: Rect, rows: RailRow[], model: RenderModel, focused: boolean): number {
  const { ui, store } = model;
  const title = ui.filter === "recurring" ? "RECURRING" : FILTERS.find((f) => f.id === ui.filter)!.label.toUpperCase();
  const body = panel(s, r, title, { focused, right: rows.length ? String(rows.length) : undefined });
  if (body.h <= 0) return 0;
  if (rows.length === 0) {
    const msg = !store.isHydrated
      ? `connecting ${breathingCursor(ui.frame)}`
      : ui.filter === "recurring"
        ? "no recurring tasks"
        : ui.search.value
          ? "nothing matches"
          : ui.filter === "drafts"
            ? "no drafts — n creates one"
            : "nothing here";
    s.text(body.x + 1, body.y, msg, S.dim, body.w - 1);
    return body.h;
  }
  const sel = selectedIndex(rows, ui);
  // Rows take 1 line; the selected row takes 2 (phase strip / schedule).
  const rowH = (i: number) => (i === sel ? 2 : 1);
  const capacity = body.h;
  // Compute the top so the selection stays visible.
  let top = Math.min(ui.railScroll, Math.max(rows.length - 1, 0));
  if (sel >= 0) {
    if (sel < top) top = sel;
    let used = 0;
    let fits = false;
    while (!fits) {
      used = 0;
      for (let i = top; i <= sel; i++) used += rowH(i);
      if (used <= capacity || top >= sel) fits = true;
      else top++;
    }
  }
  ui.railScroll = top;
  let y = body.y;
  const now = Date.now();
  for (let i = top; i < rows.length && y < body.y + body.h; i++) {
    const row = rows[i]!;
    const selected = i === sel;
    const bg = selected ? C.bgSelected : undefined;
    if (selected) s.fill(body.x, y, body.w - 1, Math.min(2, body.y + body.h - y), " ", { bg });
    if (row.kind === "task") drawTaskRow(s, body, y, row.task, selected, ui.frame, now, i, bg, store);
    else drawSeriesRow(s, body, y, row.series, selected, ui.frame, now, bg);
    y += selected ? 2 : 1;
  }
  scrollbar(s, body, rows.length, top, Math.max(capacity - 1, 1));
  return capacity;
}

function drawTaskRow(s: Screen, body: Rect, y: number, t: TaskItem, selected: boolean, frame: number, now: number, seed: number, bg: number | undefined, store: Store): void {
  const w = body.w - 1;
  const color = statusColor(t.display_status);
  const glyph = statusGlyph(t.display_status, frame, seed);
  let cx = body.x;
  cx += s.text(cx, y, padEnd(glyph, 2), { fg: color, bg, bold: true });
  if (t.starred) cx += s.text(cx, y, "★", { fg: C.gold, bg });
  else cx += s.text(cx, y, " ", { bg });
  // Right cluster: autopilot glyph, memory, age.
  const flags = `${t.mode === "workflow" ? "⚡" : "☾"}${t.memory_enabled ? "◈" : " "}${t.needs_review ? "✎" : " "}`;
  const age = ago(t.display_status === "working" && t.started_at ? t.started_at : t.updated_at ?? t.created_at, now);
  const rightTxt = `${flags} ${padEnd(age, 4)}`;
  const rightW = textWidth(rightTxt);
  const titleW = Math.max(w - (cx - body.x) - rightW - 1, 4);
  const title = t.title?.trim() || "(untitled)";
  s.text(cx, y, clip(title, titleW), { fg: selected ? C.textBright : t.status === "settled" ? C.textMuted : C.text, bg, bold: selected }, titleW);
  const rx = body.x + w - rightW;
  let fx = rx;
  fx += s.text(fx, y, t.mode === "workflow" ? "⚡" : "☾", { fg: t.mode === "workflow" ? C.warn : C.info, bg });
  fx += s.text(fx, y, t.memory_enabled ? "◈" : " ", { fg: C.violet, bg });
  fx += s.text(fx, y, t.needs_review ? "✎" : " ", { fg: C.violet, bg });
  s.text(fx, y, ` ${padEnd(age, 4)}`, { fg: C.textDim, bg });
  if (!selected || y + 1 >= body.y + body.h) return;
  // Second line: team · phase strip · live agents
  let sx = body.x + 2;
  const team = t.team_name ?? (t.team_id ? t.team_id : "solo");
  sx += s.text(sx, y + 1, clip(team, Math.min(18, w - 4)), { fg: C.accent, bg });
  sx += 1;
  const total = t.phase_count ?? 0;
  if (total > 0 && sx - body.x + 8 < w) {
    const used = phaseStripBg(s, sx, y + 1, t.current_phase, total, frame, Math.min(w - (sx - body.x) - 6, 22), bg);
    sx += used + 1;
  }
  const live = store.agentsFor(t.id).length;
  if (live > 0 && sx - body.x + 6 < w) s.text(sx, y + 1, `⬢ ${live}`, { fg: C.accent, bg });
  const label = statusLabelShort(t.display_status);
  s.text(body.x + w - textWidth(label), y + 1, label, { fg: color, bg, bold: true });
}

function phaseStripBg(s: Screen, x: number, y: number, current: number, total: number, frame: number, maxW: number, bg: number | undefined): number {
  const used = phaseStrip(s, x, y, current, total, frame, maxW);
  if (bg !== undefined) s.restyle(x, y, used, 1, (st) => ({ ...st, bg }));
  return used;
}

function statusLabelShort(st: string): string {
  switch (st) {
    case "working":
      return "working";
    case "queued":
      return "queued";
    case "idle":
      return "idle";
    case "paused":
      return "paused";
    case "review":
      return "review";
    case "blocked":
      return "blocked";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "draft":
      return "draft";
    default:
      return st;
  }
}

function drawSeriesRow(s: Screen, body: Rect, y: number, sr: RecurringSeries, selected: boolean, frame: number, now: number, bg: number | undefined): void {
  const w = body.w - 1;
  const approved = sr.status === "approved";
  let cx = body.x;
  cx += s.text(cx, y, approved ? `${["↻", "↺"][Math.floor(frame / 6) % 2]} ` : "◌ ", { fg: approved ? C.accent : C.textDim, bg, bold: true });
  if (sr.starred) cx += s.text(cx, y, "★", { fg: C.gold, bg });
  else cx += s.text(cx, y, " ", { bg });
  const right = sr.nextRunAt ? `next ${hhmm(sr.nextRunAt)}` : sr.status;
  const rw = textWidth(right);
  const titleW = Math.max(w - (cx - body.x) - rw - 1, 4);
  s.text(cx, y, clip(sr.title, titleW), { fg: selected ? C.textBright : C.text, bg, bold: selected }, titleW);
  s.text(body.x + w - rw, y, right, { fg: C.textMuted, bg });
  if (!selected || y + 1 >= body.y + body.h) return;
  let sx = body.x + 2;
  sx += s.text(sx, y + 1, clip(sr.teamName ?? "no team", 16), { fg: C.accent, bg });
  sx += s.text(sx, y + 1, ` · ${scheduleLabel(sr)}`, { fg: C.textMuted, bg });
  // Run history glyphs, newest last.
  const runs = [...sr.runs].reverse().slice(-8);
  const glyphs = runs.map((r) => (r.status === "settled" ? (r.completedAt ? "✓" : "✗") : r.status === "active" ? statusGlyph("working", frame) : "·"));
  const gx = body.x + w - glyphs.length - 1;
  if (gx > sx) glyphs.forEach((g, i) => s.put(gx + i, y + 1, g, { fg: g === "✓" ? C.ok : g === "✗" ? C.danger : C.accent, bg }));
  void now;
}

// ── feed ──────────────────────────────────────────────────────────────────

function drawFeed(s: Screen, r: Rect, model: RenderModel, focused: boolean): number {
  const { store, ui } = model;
  const rows = store.recentActivity();
  const body = panel(s, r, "LIVE FEED", { focused, right: rows.length ? `${rows.length}` : undefined });
  if (body.h <= 0) return 0;
  const agents = store.agentInstances();
  // Agent roster strip at the top of the feed.
  let y = body.y;
  if (agents.length > 0 && body.h > 4) {
    let cx = body.x;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]!;
      const running = a.status === "running";
      const glyph = running ? ["◰", "◳", "◲", "◱"][(ui.frame + i) % 4]! : "◴";
      const label = `${glyph} ${a.template_agent_name}`;
      if (cx - body.x + textWidth(label) + 2 > body.w - 1) {
        s.text(cx, y, "…", S.dim);
        break;
      }
      cx += s.text(cx, y, label, { fg: running ? agentColor(a.template_agent_name) : C.warn, bold: running });
      cx += 2;
    }
    y++;
    s.hline(body.x, y, body.w - 1, "╌", S.border);
    y++;
  }
  const feedRect: Rect = { x: body.x, y, w: body.w, h: body.y + body.h - y };
  // Newest first from the server → draw oldest at top, newest at bottom.
  const lines = [...rows].reverse().map((a) => activityLine(a, feedRect.w));
  if (lines.length === 0) {
    s.text(feedRect.x, feedRect.y, store.isHydrated ? "waiting for agent output…" : `connecting ${breathingCursor(ui.frame)}`, S.dim, feedRect.w);
    return feedRect.h;
  }
  const maxScroll = Math.max(lines.length - feedRect.h, 0);
  const sc = Math.min(Math.max(ui.feedScroll, 0), maxScroll);
  const start = Math.max(lines.length - feedRect.h - sc, 0);
  const usable = feedRect.w - 1;
  const offset = Math.max(feedRect.h - lines.length, 0);
  for (let i = 0; i < feedRect.h - offset; i++) {
    const ln = lines[start + i];
    if (!ln) break;
    const yy = feedRect.y + offset + i;
    let cx = feedRect.x;
    if (ln.prefix) cx += s.text(cx, yy, ln.prefix.text, ln.prefix.st, usable);
    s.text(cx, yy, ln.text, ln.st, Math.max(usable - (cx - feedRect.x), 0));
  }
  scrollbar(s, feedRect, lines.length, start, feedRect.h);
  if (sc > 0) {
    const tag = ` ↓ ${sc} `;
    s.text(feedRect.x + usable - textWidth(tag), feedRect.y + feedRect.h - 1, tag, { fg: C.bg, bg: C.warn, bold: true });
  } else if (store.connStatus() === "connected") {
    s.put(feedRect.x + usable - 1, feedRect.y + feedRect.h - 1, breathingCursor(ui.frame), S.accent);
  }
  return feedRect.h;
}

// ── footer ────────────────────────────────────────────────────────────────

function drawFooter(s: Screen, r: Rect, model: RenderModel): void {
  const { ui } = model;
  s.fill(r.x, r.y, r.w, 1, " ", { bg: C.bgRaised });
  const hints = footerHints(model.store, ui);
  keyHints(s, r.x + 1, r.y, r.w - 2, hints, { fg: C.textBright, bg: C.bgSelected, bold: true }, { fg: C.textMuted, bg: C.bgRaised });
}

function drawToasts(s: Screen, ui: UIState, footer: Rect): void {
  const now = Date.now();
  const live = ui.toasts.filter((t) => t.until > now);
  if (live.length === 0) return;
  // Newest toast sits in the footer's right half; older ones stack above.
  const maxW = Math.min(Math.floor(footer.w * 0.6), 90);
  live.slice(-3).reverse().forEach((t, i) => {
    const color = t.level === "ok" ? C.ok : t.level === "error" ? C.danger : t.level === "warn" ? C.warn : C.info;
    const glyph = t.level === "ok" ? "✓" : t.level === "error" ? "✗" : t.level === "warn" ? "!" : "·";
    const txt = ` ${glyph} ${t.text.replace(/\s+/g, " ")} `;
    const w = Math.min(textWidth(txt), maxW);
    const x = footer.x + footer.w - 1 - w;
    const y = footer.y - i;
    if (y < 0) return;
    s.text(x, y, clip(txt, w), { fg: i === 0 ? C.bg : color, bg: i === 0 ? color : C.bgPanel, bold: i === 0 }, w);
  });
}

// ── modals ────────────────────────────────────────────────────────────────

function drawModal(s: Screen, m: Modal, ui: UIState): { x: number; y: number } | null {
  switch (m.kind) {
    case "form":
      return drawForm(s, m, ui);
    case "confirm":
      return drawConfirm(s, m);
    case "list":
      return drawList(s, m, ui);
    case "text":
      return drawText(s, m);
  }
}

function modalFrame(s: Screen, r: Rect, title: string, hint?: string): Rect {
  s.fill(r.x, r.y, r.w, r.h, " ", { bg: C.bgModal, fg: C.text });
  shadow(s, r);
  s.box(r.x, r.y, r.w, r.h, { fg: C.accent, bg: C.bgModal });
  const t = ` ${title} `;
  s.text(r.x + 2, r.y, clip(t, r.w - 4), { fg: C.textBright, bg: C.bgModal, bold: true });
  if (hint) {
    const h = ` ${hint} `;
    const hw = Math.min(textWidth(h), r.w - 4);
    s.text(r.x + r.w - 2 - hw, r.y + r.h - 1, clip(h, hw), { fg: C.textMuted, bg: C.bgModal }, hw);
  }
  return { x: r.x + 2, y: r.y + 1, w: r.w - 4, h: r.h - 2 };
}

function drawForm(s: Screen, m: FormModal, ui: UIState): { x: number; y: number } | null {
  // Height: subtitle + each field (label + input rows) + error + submit.
  let need = 2;
  if (m.subtitle) need += wrap(m.subtitle, m.width - 4).length + 1;
  for (const f of m.fields) need += f.kind === "textarea" ? f.rows + 1 : f.kind === "static" ? 1 : 2;
  need += 3; // error + submit row
  const r = centered(s.cols, s.rows, m.width, need);
  const inner = modalFrame(s, r, m.title, m.footerHint ?? "tab next · shift+tab prev · ctrl+s submit · esc cancel");
  let y = inner.y;
  const bg = C.bgModal;
  let cursor: { x: number; y: number } | null = null;
  if (m.subtitle) {
    for (const l of wrap(m.subtitle, inner.w)) {
      if (y >= inner.y + inner.h - 2) break;
      s.text(inner.x, y++, l, { fg: C.textMuted, bg }, inner.w);
    }
    y++;
  }
  const bottomLimit = inner.y + inner.h - 2;
  m.fields.forEach((f, i) => {
    if (y >= bottomLimit) return;
    const active = i === m.active;
    const labelSt: Style = active ? { fg: C.accent, bg, bold: true } : { fg: C.textMuted, bg };
    const marker = active ? "▸ " : "  ";
    switch (f.kind) {
      case "static": {
        lr(s, inner.x, y, inner.w, `${marker}${f.label}`, labelSt, f.text, { fg: C.text, bg });
        y += 1;
        return;
      }
      case "text": {
        lr(s, inner.x, y, inner.w, `${marker}${f.label}${f.required ? " *" : ""}`, labelSt, f.hint ?? "", { fg: C.textDim, bg });
        y++;
        const fieldBg = active ? C.bgSelected : C.bgPanel;
        const fx = inner.x + 2;
        const fw = inner.w - 2;
        const view = f.buf.view(fw - 1, 1, 0);
        const text = view.rows[view.top] ?? "";
        s.text(fx, y, padEnd(text, fw), { fg: C.textBright, bg: fieldBg }, fw);
        if (!text && f.placeholder) s.text(fx, y, clip(f.placeholder, fw), { fg: C.textDim, bg: fieldBg }, fw);
        if (active) cursor = { x: fx + view.caret.col, y };
        y++;
        return;
      }
      case "textarea": {
        lr(s, inner.x, y, inner.w, `${marker}${f.label}${f.required ? " *" : ""}`, labelSt, f.hint ?? "ctrl+j newline · ctrl+o paste file", { fg: C.textDim, bg });
        y++;
        const fieldBg = active ? C.bgSelected : C.bgPanel;
        const fx = inner.x + 2;
        const fw = inner.w - 2;
        const rows = Math.min(f.rows, bottomLimit - y);
        const view = f.buf.view(fw - 1, rows, 0);
        for (let k = 0; k < rows; k++) {
          const text = view.rows[view.top + k] ?? "";
          s.text(fx, y + k, padEnd(text, fw), { fg: C.textBright, bg: fieldBg }, fw);
        }
        if (f.buf.length === 0 && f.placeholder) s.text(fx, y, clip(f.placeholder, fw), { fg: C.textDim, bg: fieldBg }, fw);
        if (view.rows.length > rows) s.text(fx + fw - 6, y + rows - 1, `+${view.rows.length - rows}`, { fg: C.textMuted, bg: fieldBg });
        if (active) cursor = { x: fx + view.caret.col, y: y + (view.caret.row - view.top) };
        y += rows;
        return;
      }
      case "select": {
        lr(s, inner.x, y, inner.w, `${marker}${f.label}`, labelSt, f.hint ?? "←/→ or space cycles", { fg: C.textDim, bg });
        y++;
        const opt = f.options[f.index];
        const fieldBg = active ? C.bgSelected : C.bgPanel;
        const fx = inner.x + 2;
        const fw = inner.w - 2;
        const label = opt ? `◂ ${opt.label} ▸${opt.hint ? `   ${opt.hint}` : ""}` : "(no options)";
        s.text(fx, y, padEnd(label, fw), { fg: C.textBright, bg: fieldBg }, fw);
        y++;
        return;
      }
      case "toggle": {
        const sw = f.value ? "◉ on " : "○ off";
        lr(s, inner.x, y, inner.w, `${marker}${f.label}`, labelSt, `${sw}${f.hint ? `  ${f.hint}` : ""}`, { fg: f.value ? C.ok : C.textMuted, bg, bold: active });
        y += 2;
        return;
      }
    }
  });
  // Error + submit.
  const ey = inner.y + inner.h - 2;
  if (m.error) s.text(inner.x, ey, clip(`✗ ${m.error}`, inner.w), { fg: C.danger, bg }, inner.w);
  const submit = m.busy ? ` ${breathingCursor(ui.frame)} working… ` : ` ${m.submitLabel} `;
  const sx = inner.x + inner.w - textWidth(submit);
  s.text(sx, ey, submit, { fg: C.bg, bg: m.busy ? C.textMuted : C.accent, bold: true });
  return cursor;
}

function drawConfirm(s: Screen, m: ConfirmModal): null {
  const w = Math.min(Math.max(textWidth(m.title) + 8, 56), s.cols - 4);
  const bodyLines = wrap(m.body, w - 4);
  const r = centered(s.cols, s.rows, w, bodyLines.length + 6);
  const inner = modalFrame(s, r, m.title, "enter confirm · esc cancel");
  let y = inner.y;
  for (const l of bodyLines) {
    if (y >= inner.y + inner.h - 2) break;
    s.text(inner.x, y++, l, { fg: C.text, bg: C.bgModal }, inner.w);
  }
  const ey = inner.y + inner.h - 1;
  if (m.error) s.text(inner.x, ey, clip(`✗ ${m.error}`, inner.w - 20), { fg: C.danger, bg: C.bgModal });
  const label = m.busy ? " working… " : ` ${m.confirmLabel} `;
  const cancel = " esc cancel ";
  s.text(inner.x + inner.w - textWidth(label), ey, label, { fg: C.bg, bg: m.danger ? C.danger : C.accent, bold: true });
  s.text(inner.x + inner.w - textWidth(label) - textWidth(cancel) - 1, ey, cancel, { fg: C.textMuted, bg: C.bgPanel });
  return null;
}

function drawList(s: Screen, m: ListModal, ui: UIState): { x: number; y: number } | null {
  const r = centered(s.cols, s.rows, m.width, m.height);
  const inner = modalFrame(s, r, m.title, m.hint ?? "↑↓ move · enter pick · esc close");
  let y = inner.y;
  let cursor: { x: number; y: number } | null = null;
  const bg = C.bgModal;
  if (m.filterable) {
    const q = m.filter.value;
    const focused = m.filterFocused !== false;
    const fbg = focused ? C.bgSelected : C.bgPanel;
    s.text(inner.x, y, padEnd(`${focused ? "›" : "/"} ${q}`, inner.w), { fg: focused ? C.textBright : C.textMuted, bg: fbg }, inner.w);
    if (!q) s.text(inner.x + 2, y, focused ? "type to filter · ↓ to the list" : "/ to filter", { fg: C.textDim, bg: fbg });
    if (focused) cursor = { x: inner.x + 2 + textWidth(q), y };
    y += 2;
  }
  const items = visibleListItems(m);
  const rows = inner.y + inner.h - y - (m.error ? 1 : 0);
  if (items.length === 0) {
    s.text(inner.x, y, m.emptyText ?? "nothing to show", { fg: C.textDim, bg }, inner.w);
  } else {
    const idx = Math.min(Math.max(m.index, 0), items.length - 1);
    // Each item is 1 row + 1 if it has a detail line.
    const heights = items.map((it) => (it.detail ? 2 : 1));
    let top = 0;
    let used = 0;
    for (let i = 0; i <= idx; i++) used += heights[i]!;
    while (used > rows && top < idx) {
      used -= heights[top]!;
      top++;
    }
    let yy = y;
    for (let i = top; i < items.length && yy < y + rows; i++) {
      const it = items[i]!;
      const sel = i === idx;
      const rowBg = sel ? C.bgSelected : bg;
      s.fill(inner.x, yy, inner.w, heights[i]!, " ", { bg: rowBg });
      const glyph = it.glyph ?? (sel ? "▸" : " ");
      let cx = inner.x + s.text(inner.x, yy, `${glyph} `, { fg: it.color ?? (sel ? C.accent : C.textMuted), bg: rowBg, bold: sel });
      const right = it.right ?? "";
      const rw = textWidth(right);
      const lw = Math.max(inner.w - (cx - inner.x) - rw - 1, 4);
      cx += s.text(cx, yy, clip(it.label, lw), { fg: it.disabled ? C.textDim : sel ? C.textBright : C.text, bg: rowBg, bold: sel }, lw);
      if (it.hint && cx - inner.x + textWidth(it.hint) + 2 <= inner.w - rw - 1) s.text(cx + 1, yy, it.hint, { fg: C.textMuted, bg: rowBg }, inner.w - rw - (cx - inner.x) - 2);
      if (rw) s.text(inner.x + inner.w - rw, yy, right, { fg: sel ? C.accent : C.textDim, bg: rowBg });
      yy++;
      if (it.detail && yy < y + rows) {
        s.text(inner.x + 2, yy, clip(it.detail, inner.w - 2), { fg: C.textMuted, bg: rowBg }, inner.w - 2);
        yy++;
      }
    }
    if (items.length > rows) scrollbar(s, { x: inner.x, y, w: inner.w + 1, h: rows }, items.length, top, rows);
  }
  if (m.error) s.text(inner.x, inner.y + inner.h - 1, clip(`✗ ${m.error}`, inner.w), { fg: C.danger, bg }, inner.w);
  if (m.busy) s.text(inner.x + inner.w - 10, inner.y + inner.h - 1, `${breathingCursor(ui.frame)} working`, { fg: C.textMuted, bg });
  return cursor;
}

function drawText(s: Screen, m: TextModal): null {
  const r = centered(s.cols, s.rows, m.width, m.height);
  const inner = modalFrame(s, r, m.title, m.hint ?? "↑↓ scroll · esc close");
  const lines = wrap(m.body, inner.w - 1);
  const top = Math.min(Math.max(m.scroll, 0), Math.max(lines.length - inner.h, 0));
  for (let i = 0; i < inner.h; i++) {
    const l = lines[top + i];
    if (l === undefined) break;
    const st: Style = /^[A-Z][A-Z0-9 /:+.-]{2,}$/.test(l.trim()) ? { fg: C.accent, bg: C.bgModal, bold: true } : { fg: C.text, bg: C.bgModal };
    s.text(inner.x, inner.y + i, l, st, inner.w - 1);
  }
  scrollbar(s, { x: inner.x, y: inner.y, w: inner.w + 1, h: inner.h }, lines.length, top, inner.h);
  return null;
}
