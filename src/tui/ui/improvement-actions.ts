import type { Action, Ctx } from "./actions";
import type { Field, FormModal } from "./state";
import type { ImprovementDetail, ImprovementSummary } from "../model/types";
import { TextBuffer } from "../input/text-editor";
import { toImprovementDetail, toImprovementSummary } from "../transport/local";
import { improvementRows, shortId } from "./view-model";

/**
 * Board 5 (experimental `improvements` feature): approve, edit, reject the
 * improvements the root Skipper stages, plus the Pending / All scope, the
 * auto-approve gate and a jump to the source task. Every action is gated by
 * `when` on the selected row's state, like the web card's buttons.
 *
 * In place, like every mutation here: the reply is only a toast; the
 * `improvement:changed` / `improvements:settings_changed` fat events patch the
 * store and the frame redraws. Nothing reloads the list after an action.
 */

/** `improvements/list` page size (the daemon caps it at 500). */
export const IMPROVEMENT_LIST_LIMIT = 500;

const onBoard = (ctx: Ctx): boolean => ctx.store.hasImprovements && ctx.ui.filter === "improvements";

/** The improvement under the rail cursor on board 5, if any. */
export function selectedImprovement(ctx: Ctx): ImprovementSummary | undefined {
  if (!onBoard(ctx) || ctx.ui.railKind !== "improvement" || !ctx.ui.selectedImprovementId) return undefined;
  return ctx.store.improvement(ctx.ui.selectedImprovementId);
}

const isSkill = (imp: ImprovementSummary): boolean => imp.kind === "skill_suggestion";

function pending(ctx: Ctx): ImprovementSummary | undefined {
  const imp = selectedImprovement(ctx);
  return imp && imp.status === "pending" ? imp : undefined;
}

function request(ctx: Ctx, action: string, params: Record<string, unknown>) {
  return ctx.transport.request("improvements", action, params);
}

/** Keep the rail cursor on a row the board shows (after the scope changed). */
function keepSelectionVisible(ctx: Ctx): void {
  const rows = improvementRows(ctx.store, ctx.ui);
  if (rows.some((r) => r.kind === "improvement" && r.improvement.id === ctx.ui.selectedImprovementId)) return;
  const first = rows.find((r) => r.kind === "improvement");
  ctx.ui.railKind = "improvement";
  ctx.ui.selectedImprovementId = first?.kind === "improvement" ? first.improvement.id : null;
  ctx.ui.detailScroll = 0;
  ctx.ui.improvementDiffExpanded = false;
}

function decide(ctx: Ctx, verdict: "approve" | "reject"): Promise<void> | void {
  const imp = pending(ctx);
  if (!imp) return;
  const skill = isSkill(imp);
  if (verdict === "approve") {
    return ctx.exec(async () => {
      await request(ctx, "approve", { id: imp.id });
      return `${skill ? "acknowledged" : "approved"}: ${imp.targetLabel}`;
    });
  }
  ctx.push({
    kind: "confirm",
    title: skill ? "Dismiss skill suggestion" : "Reject improvement",
    body: skill
      ? `Dismiss the suggestion for ${imp.targetLabel}?`
      : `Reject the proposed change to ${imp.targetLabel}? The live text stays as it is.`,
    confirmLabel: skill ? "Dismiss" : "Reject",
    danger: true,
    busy: false,
    error: null,
    onConfirm: async () => {
      await request(ctx, "reject", { id: imp.id });
      return `${skill ? "dismissed" : "rejected"}: ${imp.targetLabel}`;
    },
  });
}

/**
 * Edit reads the improvement first (the summary carries no text), then opens
 * the proposed text in a form. Saving sends `edit`, which also rebases the
 * text onto the live text: that is how a conflict is resolved. ctrl+l shows
 * the live text beside it.
 */
export async function openImprovementEditor(ctx: Ctx, imp: ImprovementSummary): Promise<void> {
  let detail: ImprovementDetail;
  try {
    const raw = await request(ctx, "read", { id: imp.id });
    if (!raw || typeof raw !== "object") throw new Error("Improvement not found");
    detail = toImprovementDetail(raw as Record<string, unknown>);
    ctx.store.setImprovementDetail(detail);
  } catch (err) {
    ctx.toast(`cannot edit: ${err instanceof Error ? err.message : String(err)}`, "error");
    return;
  }
  if (detail.status !== "pending") {
    ctx.toast("already decided", "warn");
    return;
  }
  const skill = isSkill(detail);
  const live = detail.liveText;
  const fields: Field[] = [
    { kind: "static", key: "target", label: "Target", text: detail.targetLabel },
    {
      kind: "textarea",
      key: "text",
      label: skill ? "Suggestion" : "Proposed text",
      buf: new TextBuffer(detail.proposedText, true),
      rows: 14,
      hint: live !== null ? "ctrl+l live text · ctrl+j newline" : "ctrl+j newline",
    },
  ];
  const modal: FormModal = {
    kind: "form",
    title: `Edit improvement · ${shortId(detail.id)}`,
    subtitle: skill
      ? "Saving replaces the suggestion text."
      : "Saving replaces the proposed text and rebases it onto the live text, which resolves a conflict. Approve it after.",
    fields,
    active: 1,
    submitLabel: "Save",
    error: null,
    busy: false,
    width: 96,
    footerHint: live !== null ? "ctrl+s save · ctrl+l live text · esc cancel" : "ctrl+s save · esc cancel",
    onKey: (key) => {
      if (key.type !== "ctrl" || key.ch !== "l") return false;
      if (live === null) return true;
      ctx.push({ kind: "text", title: `Live text · ${detail.targetLabel}`, body: live || "(empty)", scroll: 0, width: 96, height: 30, hint: "↑↓ scroll · esc back" });
      return true;
    },
    onSubmit: async (v) => {
      await request(ctx, "edit", { id: detail.id, text: String(v.text) });
      return skill ? `saved: ${detail.targetLabel}` : `saved: ${detail.targetLabel}. a approves it`;
    },
  };
  ctx.push(modal);
}

export const IMPROVEMENT_ACTIONS: Action[] = [
  {
    id: "improvement-approve",
    label: "Approve improvement",
    key: "a",
    keys: [{ ch: "a" }, { ch: "y" }],
    group: "review",
    hint: true,
    when: (ctx) => {
      const imp = pending(ctx);
      return !!imp && !isSkill(imp) && imp.state === "ready";
    },
    run: (ctx) => decide(ctx, "approve"),
  },
  {
    id: "improvement-acknowledge",
    label: "Acknowledge skill suggestion",
    key: "a",
    keys: [{ ch: "a" }, { ch: "y" }],
    group: "review",
    hint: true,
    when: (ctx) => {
      const imp = pending(ctx);
      return !!imp && isSkill(imp);
    },
    run: (ctx) => decide(ctx, "approve"),
  },
  {
    id: "improvement-edit",
    label: "Edit proposed text",
    key: "e",
    keys: [{ ch: "e" }],
    group: "review",
    hint: true,
    when: (ctx) => {
      const imp = pending(ctx);
      return !!imp && imp.state !== "missing";
    },
    run: (ctx) => openImprovementEditor(ctx, pending(ctx)!),
  },
  {
    id: "improvement-reject",
    label: "Reject improvement",
    key: "x",
    keys: [{ ch: "x" }, { ch: "N" }],
    group: "review",
    hint: true,
    when: (ctx) => {
      const imp = pending(ctx);
      return !!imp && !isSkill(imp);
    },
    run: (ctx) => decide(ctx, "reject"),
  },
  {
    id: "improvement-dismiss",
    label: "Dismiss skill suggestion",
    key: "x",
    keys: [{ ch: "x" }, { ch: "N" }],
    group: "review",
    hint: true,
    when: (ctx) => {
      const imp = pending(ctx);
      return !!imp && isSkill(imp);
    },
    run: (ctx) => decide(ctx, "reject"),
  },
  {
    id: "improvement-scope",
    label: "Pending / all improvements",
    key: "f",
    keys: [{ ch: "f" }],
    group: "view",
    hint: true,
    when: onBoard,
    run: async (ctx) => {
      const next = ctx.ui.improvementScope === "pending" ? "all" : "pending";
      ctx.ui.improvementScope = next;
      ctx.ui.railScroll = 0;
      keepSelectionVisible(ctx);
      if (next !== "all") return;
      // Decided rows are not loaded until the operator asks for them.
      await ctx.exec(async () => {
        const rows = await ctx.transport.request<Record<string, unknown>[]>("improvements", "list", { status: "all", limit: IMPROVEMENT_LIST_LIMIT });
        ctx.store.loadImprovements((Array.isArray(rows) ? rows : []).map(toImprovementSummary), "all", IMPROVEMENT_LIST_LIMIT);
        keepSelectionVisible(ctx);
      });
    },
  },
  {
    id: "improvement-auto-approve",
    label: "Auto-approve on/off",
    key: "A",
    keys: [{ ch: "A" }],
    group: "review",
    hint: true,
    when: (ctx) => onBoard(ctx) && ctx.store.autoApprove !== null,
    run: (ctx) => {
      if (ctx.store.autoApprove) {
        return ctx.exec(async () => {
          await request(ctx, "set-auto-approve", { on: false });
          return "auto-approve off: improvements wait for you";
        });
      }
      ctx.push({
        kind: "confirm",
        title: "Turn on auto-approve",
        body: "New improvements from the root Skipper are applied to team config at once, without your review. Skill suggestions still wait, and improvements already pending stay pending.",
        confirmLabel: "Turn on",
        danger: true,
        busy: false,
        error: null,
        onConfirm: async () => {
          await request(ctx, "set-auto-approve", { on: true });
          return "auto-approve on";
        },
      });
    },
  },
  {
    id: "improvement-source",
    label: "Open source task",
    key: "t",
    keys: [{ ch: "t" }],
    group: "view",
    hint: true,
    when: (ctx) => !!selectedImprovement(ctx)?.sourceTaskId,
    run: (ctx) => {
      const id = selectedImprovement(ctx)!.sourceTaskId!;
      if (!ctx.store.task(id)) {
        ctx.toast("the source task is no longer on this daemon", "warn");
        return;
      }
      ctx.ui.filter = "all";
      ctx.ui.railScroll = 0;
      ctx.ui.focus = "rail";
      ctx.ui.singleView = "rail";
      ctx.selectTask(id);
    },
  },
  {
    id: "improvement-expand",
    label: "Show / fold unchanged lines",
    key: "z",
    keys: [{ ch: "z" }],
    group: "view",
    hint: true,
    when: (ctx) => {
      const imp = selectedImprovement(ctx);
      return !!imp && !!ctx.store.improvementDetail(imp.id)?.diff;
    },
    run: (ctx) => {
      ctx.ui.improvementDiffExpanded = !ctx.ui.improvementDiffExpanded;
      ctx.ui.detailScroll = 0;
    },
  },
];
