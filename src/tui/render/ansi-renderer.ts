import type { Renderer, RenderModel, PaneId } from "./types";
import type { Snapshot, ConnStatus, ActivityRow, PhaseInfo } from "../model/types";
import { computeLayout, type Rect } from "./layout";
import { TerminalDriver, moveTo, padTo, ansi, width } from "./terminal";

// Animation frame sets (advanced by the controller's anim tick).
const CUBE = ["◰", "◳", "◲", "◱"]; // rotating quadrant ~ the web UI's spinning cube
const PULSE = ["●", "◉", "◍", "◉"]; // heartbeat dot
const CURSOR = ["▏", "▎", "▋", "▊", "▋", "▎"]; // breathing feed cursor

const PANE_TITLES: Record<PaneId, string> = {
  output: "AGENT OUTPUT",
  agents: "ACTIVE AGENTS",
  tasks: "ACTIVE TASKS",
};

const PANE_EMPTY: Record<PaneId, string> = {
  output: "waiting for agent output…",
  agents: "no agents running",
  tasks: "no active tasks",
};

/** Built-in hand-rolled ANSI backend with light box chrome + cheap animation. */
export class AnsiRenderer implements Renderer {
  private readonly driver: TerminalDriver;
  private last: { cols: number; rows: number } | null = null;

  constructor(driver: TerminalDriver = new TerminalDriver()) {
    this.driver = driver;
  }

  mount(): void {
    this.driver.mount();
    this.last = null;
  }
  unmount(): void {
    this.driver.unmount();
  }
  size(): { cols: number; rows: number } {
    return this.driver.size();
  }
  onResize(cb: () => void): void {
    this.driver.onResize(cb);
  }

  render(model: RenderModel): void {
    const { cols, rows } = this.driver.size();
    const layout = computeLayout(cols, rows);
    const resized = !this.last || this.last.cols !== cols || this.last.rows !== rows;
    this.last = { cols, rows };

    let frame = resized ? `${ansi.reset}\x1b[2J` : ansi.reset;
    frame += this.header(layout.header, model);
    frame += this.footer(layout.footer, model);

    frame += this.box(layout.panes.output, "output", model, outputLines(model.data), true);
    frame += this.box(layout.panes.agents, "agents", model, agentLines(model.data, model.ui.frame), false);
    frame += this.box(layout.panes.tasks, "tasks", model, tasksLines(model.data, model.data.phase), false);

    this.driver.paint(frame);
  }

  private header(rect: Rect, model: RenderModel): string {
    const m = model.data.metrics;
    const f = model.ui.frame;
    const dot = connDot(model.conn, f);
    const phaseChip = phaseHeaderChip(model.data.phase);
    const left = `${ansi.bold}${ansi.white}SKIPPER${ansi.reset}${ansi.border}//${ansi.reset}${ansi.gray}dashboard${ansi.reset}${phaseChip}`;
    const right =
      `${dot} ${ansi.gray}${model.ui.transportLabel}${ansi.reset}   ` +
      `${ansi.green}▶ ${m.running}${ansi.reset}  ` +
      `${ansi.yellow}◷ ${m.queued}${ansi.reset}  ` +
      `${ansi.cyan}◆ ${m.activeAgentCount}${ansi.reset}  ` +
      `${ansi.blue}✓ ${m.completed}${ansi.reset}  ` +
      `${m.failed > 0 ? ansi.red : ansi.border}✗ ${m.failed}${ansi.reset}`;
    return moveTo(rect.x, rect.y) + fillLR(left, right, rect.w);
  }

  private footer(rect: Rect, model: RenderModel): string {
    const p = model.ui.focused;
    const keys = [
      `${ansi.gray}q${ansi.border}·quit${ansi.reset}`,
      `${ansi.gray}↑↓${ansi.border}·scroll${ansi.reset}`,
      `${ansi.gray}tab${ansi.border}·pane${ansi.reset}`,
      `${ansi.gray}r${ansi.border}·resync${ansi.reset}`,
    ].join("   ");
    const focus = `${ansi.border}focus:${ansi.reset}${ansi.magenta}${PANE_TITLES[p].toLowerCase()}${ansi.reset}`;
    return moveTo(rect.x, rect.y) + fillLR(keys, focus, rect.w);
  }

  /** Draw one bordered, titled, scrollable pane. `output` anchors to the tail. */
  private box(rect: Rect, id: PaneId, model: RenderModel, lines: string[], bottomAnchored: boolean): string {
    if (rect.h < 2 || rect.w < 2) return "";
    const innerW = rect.w - 2;
    const innerH = rect.h - 2;
    const focused = model.ui.focused === id;
    const edge = focused ? ansi.cyan : ansi.border;
    const empty = lines.length === 0;

    // Scroll math. bottomAnchored: scroll is scrollback from newest.
    const total = lines.length;
    const maxScroll = Math.max(total - innerH, 0);
    const scroll = clampScroll(model.ui.scroll[id], total, innerH);
    const start = bottomAnchored ? Math.max(total - innerH - scroll, 0) : Math.min(scroll, maxScroll);

    // Title bar built into the top border. Count hidden when the pane is empty.
    const titleTxt = `${focused ? ansi.bold + ansi.white : ansi.gray}${PANE_TITLES[id]}${ansi.reset}`;
    const countTxt = empty ? "" : `${ansi.border}${total}${ansi.reset}`;
    const scrolled = bottomAnchored && scroll > 0 ? `${ansi.yellow}↑${scroll}${ansi.reset} ` : "";
    let out = moveTo(rect.x, rect.y) + topBorder(edge, innerW, ` ${titleTxt} `, `${scrolled}${countTxt}`);

    for (let i = 0; i < innerH; i++) {
      let line: string;
      if (empty) {
        line = i === 0 ? `${ansi.border}${PANE_EMPTY[id]}${ansi.reset}` : "";
      } else {
        line = lines[start + i] ?? "";
      }
      out += moveTo(rect.x, rect.y + 1 + i) + `${edge}│${ansi.reset}` + padStyled(line, innerW) + `${edge}│${ansi.reset}`;
    }

    // Bottom border with a breathing cursor on the focused / output pane.
    const cursor = bottomAnchored && model.conn === "connected" && scroll === 0
      ? `${ansi.cyan}${CURSOR[model.ui.frame % CURSOR.length]}${ansi.reset}`
      : "";
    out += moveTo(rect.x, rect.y + rect.h - 1) + bottomBorder(edge, innerW, cursor);
    return out;
  }
}

/** Clamp a scroll offset to a valid range for the current data + viewport. */
export function clampScroll(offset: number, total: number, viewportH: number): number {
  const max = Math.max(total - viewportH, 0);
  if (!Number.isFinite(offset) || offset < 0) return 0;
  return Math.min(offset, max);
}

// ── borders ────────────────────────────────────────────────────────────────

function topBorder(edge: string, innerW: number, title: string, right: string): string {
  const tw = width(stripAnsi(title));
  const rw = width(stripAnsi(right));
  const dashes = Math.max(innerW - tw - rw - 1, 0);
  return `${edge}╭${ansi.reset}${title}${edge}${"─".repeat(dashes)}${ansi.reset}${right}${edge}${rw > 0 ? "─" : ""}╮${ansi.reset}`;
}

function bottomBorder(edge: string, innerW: number, right: string): string {
  const rw = width(stripAnsi(right));
  const dashes = Math.max(innerW - rw, 0);
  return `${edge}╰${"─".repeat(dashes)}${ansi.reset}${right}${edge}╯${ansi.reset}`;
}

function connDot(status: ConnStatus, frame: number): string {
  switch (status) {
    case "connected":
      return `${ansi.green}${PULSE[frame % PULSE.length]}${ansi.reset}`;
    case "connecting":
    case "reconnecting":
      return `${ansi.yellow}${frame % 2 === 0 ? "●" : "○"}${ansi.reset}`;
    case "closed":
      return `${ansi.red}●${ansi.reset}`;
  }
}

function fillLR(left: string, right: string, w: number): string {
  const lw = width(stripAnsi(left));
  const rw = width(stripAnsi(right));
  if (lw + rw + 1 > w) return padStyled(left, w);
  return left + " ".repeat(w - lw - rw) + right;
}

function padStyled(s: string, w: number): string {
  const visible = stripAnsi(s);
  const vw = width(visible);
  if (vw === w) return s + ansi.reset;
  if (vw < w) return s + " ".repeat(w - vw) + ansi.reset;
  return padTo(visible, w) + ansi.reset;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// ── content builders ────────────────────────────────────────────────────────

function colorFor(status: string): string {
  switch (status) {
    // Unified model display statuses (new daemons)
    case "active":
    case "working":
      return ansi.green;
    case "queued":
    case "paused":
    case "review":
      return ansi.yellow;
    case "idle":
      return ansi.cyan;
    case "blocked":
      return ansi.red;
    case "settled":
      return ansi.gray;
    // Legacy statuses (remote daemons running old versions)
    case "running":
      return ansi.green;
    case "approved":
    case "waiting_delegation":
      return ansi.yellow;
    case "completed":
      return ansi.cyan;
    case "failed":
      return ansi.red;
    default:
      return ansi.gray;
  }
}

export function tasksLines(data: Snapshot, phase: PhaseInfo | null): string[] {
  const lines: string[] = [];
  for (const t of data.tasks) {
    // Prefer the derived display status from new daemons; fall back to the
    // stored status for remote daemons running old versions.
    const status = t.display_status || t.status;
    const c = colorFor(status);
    const label = status === "approved" ? "queued" : status;
    lines.push(`${c}●${ansi.reset} ${ansi.white}${t.title?.trim() || "(untitled)"}${ansi.reset}  ${c}${label}${ansi.reset}`);
    // Phase strip for the focus task, indented under its row.
    if (phase && phase.taskId === t.id && phase.total > 0) {
      lines.push(`  ${phaseStrip(phase)}`);
    }
  }
  return lines;
}

/** A segmented phase progress bar: done ▰ (green), current ▰ (cyan), todo ▱ (dim). */
export function phaseStrip(p: PhaseInfo): string {
  const segs: string[] = [];
  for (let i = 0; i < p.total; i++) {
    if (i < p.current) segs.push(`${ansi.green}▰${ansi.reset}`);
    else if (i === p.current) segs.push(`${ansi.cyan}${ansi.bold}▰${ansi.reset}`);
    else segs.push(`${ansi.border}▱${ansi.reset}`);
  }
  const review = p.needsReview ? ` ${ansi.yellow}✎ review${ansi.reset}` : "";
  const name = p.phaseName ? ` ${ansi.gray}${p.phaseName}${ansi.reset}` : "";
  return `${segs.join("")} ${ansi.white}${p.current + 1}/${p.total}${ansi.reset}${name}${review}`;
}

/** Compact phase chip for the header: shows the focus task's phase at a glance. */
function phaseHeaderChip(p: PhaseInfo | null): string {
  if (!p || p.total === 0) return "";
  const review = p.needsReview ? `${ansi.yellow}✎${ansi.reset}` : "";
  return `  ${ansi.border}⟨${ansi.reset}${ansi.cyan}phase ${p.current + 1}/${p.total}${ansi.reset}${review}${ansi.border}⟩${ansi.reset}`;
}

export function agentLines(data: Snapshot, frame: number): string[] {
  return data.agents.map((a, i) => {
    const running = a.status === "running";
    const glyph = running
      ? `${ansi.green}${CUBE[(frame + i) % CUBE.length]}${ansi.reset}`
      : `${ansi.yellow}◴${ansi.reset}`;
    const where = a.task_title?.trim() || a.task_id || "-";
    const st = running ? "" : `  ${ansi.yellow}${a.status}${ansi.reset}`;
    return `${glyph} ${ansi.bold}${ansi.white}${a.template_agent_name}${ansi.reset} ${ansi.border}▹${ansi.reset} ${ansi.gray}${where}${ansi.reset}${st}`;
  });
}

/** The star: parsed live agent output, coloured by kind. Newest last. */
export function outputLines(data: Snapshot): string[] {
  // Server sends newest-first; reverse so newest sits at the bottom.
  return [...data.activity].reverse().map(activityLine);
}

function activityLine(a: ActivityRow): string {
  const t = hhmm(a.created_at);
  const who = clipPlain(a.agent_name, 10);
  let tag: string;
  let bodyColor: string;
  switch (a.kind) {
    case "note":
      tag = `${ansi.orange}★${ansi.reset}`;
      bodyColor = ansi.orange;
      break;
    case "tool":
      tag = `${ansi.yellow}⚙${ansi.reset}`;
      bodyColor = ansi.gray;
      break;
    case "message":
      tag = `${ansi.cyan}▓${ansi.reset}`;
      bodyColor = ansi.white;
      break;
    default:
      tag = `${ansi.border}·${ansi.reset}`;
      bodyColor = ansi.border;
  }
  return `${ansi.border}${t}${ansi.reset} ${tag} ${ansi.magenta}${who}${ansi.reset} ${bodyColor}${a.text}${ansi.reset}`;
}

function clipPlain(s: string, max: number): string {
  return width(s) <= max ? s : s.slice(0, Math.max(max - 1, 0)) + "…";
}

function hhmm(iso: string | null | undefined): string {
  if (!iso) return "--:--";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
