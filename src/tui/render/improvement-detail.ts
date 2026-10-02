import { Screen, type Style, wrap, clip, textWidth } from "./screen";
import type { Rect } from "./layout";
import type { Store } from "../model/store";
import type { ImprovementDetail, ImprovementDiffLine, ImprovementSummary } from "../model/types";
import type { UIState } from "../ui/state";
import { ago, shortId } from "../ui/view-model";
import { C, S, improvementKindLabel, improvementLook } from "./theme";
import { panel, pill, scrollbar } from "./widgets";
import type { DetailDrawResult } from "./detail";

/**
 * The main pane on board 5: one staged improvement. Header (target, state
 * pill, meta, conflict / missing notice), then a scrolling body: the reason,
 * and the coloured line diff (live or before → proposed) with unchanged lines
 * folded to 3 lines of context (`z` shows every line). A missing target shows
 * the proposed text only; a skill suggestion shows its suggestion text.
 */

export const CONFLICT_NOTICE = "The live text changed after this was proposed. Edit it to resolve the conflict, then approve.";
export const MISSING_NOTICE = "The target no longer exists (the phase, agent, team or recurring task was removed or renamed). Reject this improvement.";

/** Unchanged lines kept on each side of a change when the diff is folded. */
export const DIFF_CONTEXT = 3;

export interface ImpLine {
  text: string;
  st: Style;
  /** Optional prefix in its own style (the diff sign). */
  prefix?: { text: string; st: Style };
}

export type DiffRow = { kind: "line"; op: ImprovementDiffLine["op"]; text: string } | { kind: "fold"; count: number };

/**
 * Keep every changed line plus `context` unchanged lines around each change;
 * longer unchanged runs collapse into one fold row. A run of one line is shown
 * as is (a fold row would not save a line).
 */
export function foldDiff(diff: ImprovementDiffLine[], expanded: boolean, context = DIFF_CONTEXT): DiffRow[] {
  const rows: DiffRow[] = [];
  if (expanded) {
    for (const d of diff) rows.push({ kind: "line", op: d.op, text: d.text });
    return rows;
  }
  const keep = diff.map(() => false);
  diff.forEach((d, i) => {
    if (d.op === "same") return;
    for (let j = Math.max(i - context, 0); j <= Math.min(i + context, diff.length - 1); j++) keep[j] = true;
  });
  let i = 0;
  while (i < diff.length) {
    if (keep[i]) {
      rows.push({ kind: "line", op: diff[i]!.op, text: diff[i]!.text });
      i++;
      continue;
    }
    let j = i;
    while (j < diff.length && !keep[j]) j++;
    if (j - i === 1) rows.push({ kind: "line", op: diff[i]!.op, text: diff[i]!.text });
    else rows.push({ kind: "fold", count: j - i });
    i = j;
  }
  return rows;
}

/** Diff rows as wrapped, coloured lines: `+` in the ok colour, `-` in the danger colour, context muted. */
export function diffLines(diff: ImprovementDiffLine[], width: number, expanded: boolean): { lines: ImpLine[]; folded: boolean } {
  const rows = foldDiff(diff, expanded);
  const textW = Math.max(width - 2, 8);
  const lines: ImpLine[] = [];
  let folded = false;
  for (const r of rows) {
    if (r.kind === "fold") {
      folded = true;
      lines.push({ text: `⋯ ${r.count} unchanged line${r.count === 1 ? "" : "s"} (z shows them)`, st: S.dim, prefix: { text: "  ", st: S.dim } });
      continue;
    }
    const sign = r.op === "add" ? "+" : r.op === "del" ? "-" : " ";
    const st: Style = r.op === "add" ? { fg: C.ok } : r.op === "del" ? { fg: C.danger } : { fg: C.textMuted };
    const wrapped = wrap(r.text, textW);
    if (wrapped.length === 0) wrapped.push("");
    wrapped.forEach((l, i) => lines.push({ text: l, st, prefix: { text: i === 0 ? `${sign} ` : "  ", st: { ...st, bold: true } } }));
  }
  return { lines, folded };
}

/** Everything below the header: reason, then the diff / proposed text / suggestion. */
export function improvementBodyLines(sum: ImprovementSummary, detail: ImprovementDetail | undefined, error: string | null, width: number, expanded: boolean): { lines: ImpLine[]; folded: boolean } {
  const skill = sum.kind === "skill_suggestion";
  const lines: ImpLine[] = [];
  const para = (text: string, st: Style) => {
    for (const l of wrap(text.trim() || "(empty)", Math.max(width, 8))) lines.push({ text: l, st: text.trim() ? st : S.dim });
  };
  lines.push({ text: skill ? "PROBLEM" : "REASON", st: S.accentBold });
  para(detail?.reason ?? sum.reason, S.text);
  lines.push({ text: "", st: S.text });
  if (!detail) {
    lines.push({ text: error ? `✗ ${error}` : "loading the text…", st: error ? S.danger : S.dim });
    return { lines, folded: false };
  }
  if (skill) {
    lines.push({ text: "SUGGESTION", st: S.accentBold });
    para(detail.proposedText, S.text);
    return { lines, folded: false };
  }
  // The summary's state is the live one; a detail being re-read may lag it.
  if (sum.status === "pending" && sum.state === "missing") {
    lines.push({ text: "PROPOSED TEXT", st: S.accentBold });
    para(detail.proposedText, S.text);
    return { lines, folded: false };
  }
  if (!detail.diff) {
    lines.push({ text: "PROPOSED TEXT", st: S.accentBold });
    para(detail.proposedText, S.text);
    return { lines, folded: false };
  }
  lines.push({ text: detail.diffBase === "before" ? "TEXT BEFORE → PROPOSED TEXT" : "CURRENT TEXT → PROPOSED TEXT", st: S.accentBold });
  const d = diffLines(detail.diff, width, expanded);
  if (!detail.diff.some((l) => l.op !== "same")) lines.push({ text: "no difference", st: S.dim });
  lines.push(...d.lines);
  return { lines, folded: d.folded };
}

export function drawImprovementDetail(s: Screen, r: Rect, store: Store, ui: UIState, focused: boolean): DetailDrawResult {
  const id = ui.selectedImprovementId;
  const sum = id ? store.improvement(id) : undefined;
  const body = panel(s, r, "IMPROVEMENT", { focused, right: sum ? shortId(sum.id) : undefined });
  if (body.h <= 0) return { cursor: null, bodyRows: 0 };
  const x = body.x;
  const w = body.w;
  const bottom = body.y + body.h; // exclusive
  let y = body.y;
  if (!sum) {
    const lines = [
      "",
      store.pendingImprovementCount() === 0 ? "   nothing waiting on you." : "   no improvement selected.",
      "",
      "   After a run the root Skipper stages changes to its team's",
      "   phase prompts, agent and lead instructions and recurring task",
      "   description here. You approve, edit or reject each one.",
      "",
      ui.improvementScope === "pending" ? "   f   show decided ones too" : "   f   pending only",
      `   A   auto-approve ${store.autoApprove ? "on" : "off"}`,
    ];
    for (let i = 0; i < lines.length && y < bottom; i++) s.text(x, y++, lines[i]!, i === 1 ? S.bright : S.muted, w);
    return { cursor: null, bodyRows: 0 };
  }
  const detail = store.improvementDetail(sum.id);
  const look = improvementLook(sum);
  const now = Date.now();

  // ── target + state ──
  const pillW = textWidth(look.label.toUpperCase()) + 2;
  const titleW = Math.max(w - pillW - 1, 4);
  const wrappedTitle = wrap(sum.targetLabel || "(no target)", titleW);
  const title = wrappedTitle.slice(0, 2);
  if (wrappedTitle.length > 2) title[1] = clip(`${title[1]}…`, titleW);
  title.forEach((l, i) => {
    if (y + i < bottom) s.text(x, y + i, l, { fg: C.textBright, bold: true }, titleW);
  });
  pill(s, x + w - pillW, y, look.label.toUpperCase(), look.color, look.color);
  y += Math.max(title.length, 1);

  // ── meta ──
  if (y < bottom) {
    const parts: Array<[string, Style]> = [[improvementKindLabel(sum.kind), S.accent]];
    if (sum.teamName) parts.push([sum.teamName, S.muted]);
    if (sum.usedByTeams !== null) parts.push([`Used by ${sum.usedByTeams} team${sum.usedByTeams === 1 ? "" : "s"}`, S.violet]);
    parts.push([`created ${ago(sum.createdAt, now)} ago`, S.muted]);
    if (sum.sourceTaskId || sum.sourceTaskTitle) parts.push([`from ${sum.sourceTaskTitle?.trim() || "a run"}`, S.muted]);
    if (sum.editedAt) parts.push(["edited", S.warn]);
    if (sum.decidedAt) parts.push([`decided ${ago(sum.decidedAt, now)} ago`, S.muted]);
    let cx = x;
    for (let i = 0; i < parts.length; i++) {
      const [t, st] = parts[i]!;
      const sep = i > 0 ? " · " : "";
      const room = w - (cx - x) - sep.length;
      // A part that does not fit is clipped when there is room for a useful bit of it.
      if (textWidth(t) > room && room < 12) break;
      if (sep) cx += s.text(cx, y, sep, S.dim);
      cx += s.text(cx, y, clip(t, room), st, room);
    }
    y++;
  }

  // ── conflict / missing notice ──
  const notice = sum.status !== "pending" ? null : sum.state === "conflict" ? CONFLICT_NOTICE : sum.state === "missing" ? MISSING_NOTICE : null;
  if (notice && y < bottom) {
    const chip = sum.state === "conflict" ? "▲ CONFLICT" : "✗ TARGET GONE";
    const cw = pill(s, x, y, chip, C.danger, C.danger);
    const lines = wrap(notice, Math.max(w - cw - 1, 8));
    for (let i = 0; i < lines.length && y < bottom; i++) {
      s.text(x + cw + 1, y, lines[i]!, { fg: C.danger, bold: i === 0 }, w - cw - 1);
      y++;
    }
  }

  // ── body ──
  if (bottom - y > 8) y++;
  const hintY = bottom - 1;
  const bodyRect: Rect = { x, y, w, h: Math.max(hintY - y - (hintY - y > 3 ? 1 : 0), 0) };
  const { lines, folded } = improvementBodyLines(sum, detail, store.improvementError(sum.id), w - 1, ui.improvementDiffExpanded);
  const top = Math.min(Math.max(ui.detailScroll, 0), Math.max(lines.length - bodyRect.h, 0));
  ui.detailScroll = top;
  for (let i = 0; i < bodyRect.h; i++) {
    const ln = lines[top + i];
    if (!ln) break;
    let cx = x;
    if (ln.prefix) cx += s.text(cx, bodyRect.y + i, ln.prefix.text, ln.prefix.st, w - 1);
    s.text(cx, bodyRect.y + i, ln.text, ln.st, Math.max(w - 1 - (cx - x), 0));
  }
  scrollbar(s, bodyRect, lines.length, top, bodyRect.h);

  // ── bottom line: the gate + the fold ──
  if (hintY >= y) {
    const bits = [`auto-approve ${store.autoApprove ? "on" : "off"} (A)`];
    if (folded) bits.push("z shows every line");
    else if (ui.improvementDiffExpanded && detail?.diff) bits.push("z folds unchanged lines");
    if (detail && detail.id === sum.id && sum.status === "pending" && store.improvementDetailStale(sum.id)) bits.push("refreshing…");
    s.text(x, hintY, clip(bits.join(" · "), w), S.dim, w);
  }
  return { cursor: null, bodyRows: bodyRect.h };
}
