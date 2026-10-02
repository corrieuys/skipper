import { escapeHtml } from "../atoms/escape-html";
import { formatTimestamp } from "../atoms/format-timestamp";
import type { Improvement, ImprovementKind, ImprovementState } from "../../improvements/manager";
import { lineDiff } from "../../improvements/diff";

/**
 * One improvement on the Improvements page (src/improvements). The card is the
 * swap unit: every action (approve, reject, edit, save, cancel) targets
 * `closest .imp-card` with outerHTML, and the WS push replaces a card by id.
 */

const KIND_LABELS: Record<ImprovementKind, string> = {
  phase_prompt: "Phase prompt",
  agent_instruction: "Agent instruction",
  lead_instructions: "Lead instructions",
  recurring_description: "Recurring task description",
  skill_suggestion: "Skill suggestion",
};

export function improvementCardId(id: string): string {
  return `imp-${id}`;
}

function diffHtml(before: string, after: string): string {
  const rows = lineDiff(before, after)
    .map(({ op, line }) => {
      const sign = op === "add" ? "+" : op === "del" ? "-" : " ";
      return `<div class="imp-diff__line imp-diff__line--${op}"><span class="imp-diff__sign">${sign}</span>${escapeHtml(line) || "&nbsp;"}</div>`;
    })
    .join("");
  return `<div class="imp-diff">${rows}</div>`;
}

function sourceLink(imp: Improvement): string {
  const title = imp.source_task_title?.trim() || "a run";
  if (!imp.source_task_id) return escapeHtml(title);
  return `<a href="/?task=${encodeURIComponent(imp.source_task_id)}">${escapeHtml(title)}</a>`;
}

function statusBadge(imp: Improvement, state: ImprovementState): string {
  const skill = imp.kind === "skill_suggestion";
  if (imp.status === "approved") return `<span class="sk-badge sk-badge--completed">${skill ? "Acknowledged" : "Approved"}</span>`;
  if (imp.status === "rejected") return `<span class="sk-badge sk-badge--pending">${skill ? "Dismissed" : "Rejected"}</span>`;
  if (state.state === "conflict") return `<span class="sk-badge sk-badge--danger">Conflict</span>`;
  if (state.state === "missing") return `<span class="sk-badge sk-badge--danger">Target gone</span>`;
  return `<span class="sk-badge sk-badge--waiting">Pending</span>`;
}

function header(imp: Improvement, state: ImprovementState): string {
  const reach = (state.state === "ready" || state.state === "conflict") && state.live.usedByTeams !== undefined
    ? `<span class="sk-muted sk-text-xs">Used by ${state.live.usedByTeams} team${state.live.usedByTeams === 1 ? "" : "s"}</span>`
    : "";
  return `<div class="imp-card__head">
      <span class="imp-card__target">${escapeHtml(imp.target_label)}</span>
      <span class="sk-badge">${KIND_LABELS[imp.kind] ?? escapeHtml(imp.kind)}</span>
      ${statusBadge(imp, state)}
      ${reach}
      <span class="imp-card__meta sk-muted sk-text-xs">${formatTimestamp(imp.created_at)} from ${sourceLink(imp)}${imp.edited_at ? " · edited" : ""}</span>
    </div>`;
}

function errorLine(error?: string): string {
  return error ? `<div class="imp-card__error">${escapeHtml(error)}</div>` : "";
}

export interface ImprovementCardOptions {
  error?: string;
  /** Adds hx-swap-oob="outerHTML" for a WS push. */
  oob?: boolean;
}

export function improvementCard(imp: Improvement, state: ImprovementState, opts: ImprovementCardOptions = {}): string {
  const id = improvementCardId(imp.id);
  const skill = imp.kind === "skill_suggestion";
  const pending = imp.status === "pending";

  let body: string;
  if (skill) {
    body = `<div class="imp-card__section"><div class="sk-label">Suggestion</div><div class="imp-card__text">${escapeHtml(imp.proposed_text)}</div></div>`;
  } else if (state.state === "ready" || state.state === "conflict") {
    body = `${state.state === "conflict" ? `<div class="imp-card__notice">The live text changed after this was proposed. Edit it to resolve the conflict, then approve.</div>` : ""}
      <div class="imp-card__section"><div class="sk-label">Current text → proposed text</div>${diffHtml(state.live.text, imp.proposed_text)}</div>`;
  } else if (state.state === "missing") {
    body = `<div class="imp-card__notice">The target no longer exists (the phase, agent, team or recurring task was removed or renamed). Reject this improvement.</div>
      <div class="imp-card__section"><div class="sk-label">Proposed text</div><div class="imp-card__text">${escapeHtml(imp.proposed_text)}</div></div>`;
  } else {
    body = `<div class="imp-card__section"><div class="sk-label">Text before → proposed text</div>${diffHtml(imp.before_text, imp.proposed_text)}</div>`;
  }

  const target = `hx-target="closest .imp-card" hx-swap="outerHTML"`;
  const canApprove = skill || state.state === "ready";
  const actions = pending
    ? `<div class="imp-card__actions">
        <button class="sk-btn sk-btn--sm sk-btn--primary" hx-post="/api/improvements/${encodeURIComponent(imp.id)}/approve" ${target}${canApprove ? "" : " disabled"}>${skill ? "Acknowledge" : "Approve"}</button>
        ${state.state === "missing" ? "" : `<button class="sk-btn sk-btn--sm" hx-get="/fragments/improvements/${encodeURIComponent(imp.id)}/edit" ${target}>Edit</button>`}
        <button class="sk-btn sk-btn--sm sk-btn--danger" hx-post="/api/improvements/${encodeURIComponent(imp.id)}/reject" ${target}>${skill ? "Dismiss" : "Reject"}</button>
      </div>`
    : "";

  return `<div class="sk-panel imp-card${pending ? "" : " imp-card--decided"}" id="${id}"${opts.oob ? ' hx-swap-oob="outerHTML"' : ""}>
    ${header(imp, state)}
    <div class="imp-card__body">
      <div class="imp-card__section"><div class="sk-label">${skill ? "Problem" : "Reason"}</div><div class="imp-card__text">${escapeHtml(imp.reason)}</div></div>
      ${body}
      ${errorLine(opts.error)}
      ${actions}
    </div>
  </div>`;
}

/** Edit mode: the live text (read-only) beside the editable proposal. Saving rebases onto the live text. */
export function improvementEditCard(imp: Improvement, state: ImprovementState, error?: string): string {
  const id = encodeURIComponent(imp.id);
  const skill = imp.kind === "skill_suggestion";
  const liveText = state.state === "ready" || state.state === "conflict" ? state.live.text : null;
  const current = liveText === null
    ? ""
    : `<div class="imp-edit__col"><div class="sk-label">Current live text</div><div class="imp-card__text imp-edit__live">${escapeHtml(liveText)}</div></div>`;
  return `<div class="sk-panel imp-card imp-card--editing" id="${improvementCardId(imp.id)}">
    ${header(imp, state)}
    <form class="imp-card__body" hx-post="/api/improvements/${id}/edit" hx-target="closest .imp-card" hx-swap="outerHTML">
      <div class="imp-card__section"><div class="sk-label">${skill ? "Problem" : "Reason"}</div><div class="imp-card__text">${escapeHtml(imp.reason)}</div></div>
      <div class="imp-edit${current ? " imp-edit--split" : ""}">
        ${current}
        <div class="imp-edit__col"><div class="sk-label">${skill ? "Suggestion" : "Proposed text"}</div>
          <textarea name="proposed_text" class="sk-textarea imp-edit__textarea" rows="14">${escapeHtml(imp.proposed_text)}</textarea>
        </div>
      </div>
      ${errorLine(error)}
      <div class="imp-card__actions">
        <button type="submit" class="sk-btn sk-btn--sm sk-btn--primary">Save</button>
        <button type="button" class="sk-btn sk-btn--sm" hx-get="/fragments/improvements/${id}" hx-target="closest .imp-card" hx-swap="outerHTML">Cancel</button>
      </div>
    </form>
  </div>`;
}
