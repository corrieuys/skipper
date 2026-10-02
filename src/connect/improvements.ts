import type { Database } from "bun:sqlite";
import { isExperimental } from "../config/feature-flags";
import { getLocalTeam } from "../teams/local-teams";
import { lineDiff } from "../improvements/diff";
import {
  type Improvement,
  type ImprovementKind,
  type ImprovementStatus,
  approveImprovement,
  editImprovement,
  getImprovement,
  improvementState,
  isImprovementsAutoApproveOn,
  isImprovementsEnabled,
  libraryTargetKey,
  listImprovements,
  rejectImprovement,
  setImprovementsAutoApprove,
} from "../improvements/manager";
import type { ResourceResult } from "./resources";

/**
 * Improvements over Connect (daemon --experimental; see
 * ../improvements/CLAUDE.md). Two projections, because one proposal can hold
 * three texts of up to 50k characters and the relay caps a frame at 1 MiB:
 *
 * - `ImprovementSummaryItem`: list rows and every fat event. No texts; the
 *   reason is cut to REASON_PREVIEW characters.
 * - `ImprovementDetailItem`: `improvements/read` and every action reply. Adds
 *   the full reason, the proposed / before / live texts and a line diff.
 *
 * A client holding a detail reads it again when a summary for the same id
 * arrives with a different `updatedAt` or `liveRevision`.
 */

export type ImprovementWireState = "ready" | "conflict" | "missing" | "suggestion" | "decided";

export interface ImprovementSummaryItem {
  id: string;
  kind: ImprovementKind;
  status: ImprovementStatus;
  /** Derived now: `conflict` = the live text moved since the proposal was written. */
  state: ImprovementWireState;
  targetKey: string;
  targetLabel: string;
  teamId: string | null;
  teamName: string | null;
  scheduledTaskId: string | null;
  phaseIndex: number | null;
  phaseName: string | null;
  agentRef: string | null;
  skillName: string | null;
  /** Cut to REASON_PREVIEW characters; `read` carries the full text. */
  reason: string;
  sourceTaskId: string | null;
  sourceTaskTitle: string | null;
  /** Library agent targets only: how many teams use the agent. */
  usedByTeams: number | null;
  /** Revision of the live text the proposal is built on (null for a skill suggestion). */
  baseRevision: string | null;
  /** Revision of the live text now (null when decided, missing or a skill suggestion). */
  liveRevision: string | null;
  editedAt: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImprovementDiffLine {
  op: "same" | "add" | "del";
  text: string;
}

export interface ImprovementDetailItem extends ImprovementSummaryItem {
  proposedText: string;
  /** The live text when the proposal was written (or last rebased). Empty for a skill suggestion. */
  beforeText: string;
  /** The live text now (null when decided, missing or a skill suggestion). */
  liveText: string | null;
  /** Pending ready / conflict: live → proposed. Decided: before → proposed. Else null. */
  diff: ImprovementDiffLine[] | null;
  diffBase: "live" | "before" | null;
}

const REASON_PREVIEW = 280;
const LIST_DEFAULT = 100;
const LIST_MAX = 500;

function preview(text: string): string {
  return text.length > REASON_PREVIEW ? `${text.slice(0, REASON_PREVIEW - 1)}…` : text;
}

function toWire(db: Database, imp: Improvement): { summary: ImprovementSummaryItem; liveText: string | null } {
  const st = improvementState(db, imp);
  const live = st.state === "ready" || st.state === "conflict" ? st.live : null;
  const skill = imp.kind === "skill_suggestion";
  return {
    liveText: live?.text ?? null,
    summary: {
      id: imp.id,
      kind: imp.kind,
      status: imp.status,
      state: st.state,
      targetKey: imp.target_key,
      targetLabel: imp.target_label,
      teamId: imp.team_id,
      teamName: imp.team_id ? getLocalTeam(db, imp.team_id)?.name ?? null : null,
      scheduledTaskId: imp.scheduled_task_id,
      phaseIndex: imp.phase_index,
      phaseName: imp.phase_name,
      agentRef: imp.agent_ref,
      skillName: imp.skill_name,
      reason: preview(imp.reason),
      sourceTaskId: imp.source_task_id,
      sourceTaskTitle: imp.source_task_title,
      usedByTeams: live?.usedByTeams ?? null,
      baseRevision: skill ? null : imp.base_revision,
      liveRevision: live?.revision ?? null,
      editedAt: imp.edited_at,
      decidedAt: imp.decided_at,
      createdAt: imp.created_at,
      updatedAt: imp.updated_at,
    },
  };
}

export function improvementSummary(db: Database, imp: Improvement): ImprovementSummaryItem {
  return toWire(db, imp).summary;
}

export function improvementDetail(db: Database, imp: Improvement): ImprovementDetailItem {
  const { summary, liveText } = toWire(db, imp);
  const skill = imp.kind === "skill_suggestion";
  const base = skill ? null : liveText !== null ? "live" : summary.state === "decided" ? "before" : null;
  const diff = base === null
    ? null
    : lineDiff(base === "live" ? liveText! : imp.before_text, imp.proposed_text).map(({ op, line }) => ({ op, text: line }));
  return {
    ...summary,
    reason: imp.reason,
    proposedText: imp.proposed_text,
    beforeText: imp.before_text,
    liveText,
    diff,
    diffBase: base,
  };
}

/** Pending summaries in one scope (a team, a series, or target keys), for fat events. */
export function pendingImprovementSummaries(
  db: Database,
  scope: { teamId?: string; scheduledTaskId?: string; targetKeys?: string[] },
): ImprovementSummaryItem[] {
  return listImprovements(db, { status: "pending", ...scope }).map((imp) => improvementSummary(db, imp));
}

/** `improvement:changed` fat fields: the row plus the other pending rows on the same target. */
export function improvementEventFields(db: Database, id: string): { improvement: ImprovementSummaryItem; siblings: ImprovementSummaryItem[] } | null {
  const imp = getImprovement(db, id);
  if (!imp) return null;
  const siblings = listImprovements(db, { status: "pending", targetKeys: [imp.target_key] })
    .filter((s) => s.id !== imp.id)
    .map((s) => improvementSummary(db, s));
  return { improvement: improvementSummary(db, imp), siblings };
}

/** Pending summaries a library agent edit can move. */
export function libraryAgentImprovementSummaries(db: Database, agentType: string): ImprovementSummaryItem[] {
  return pendingImprovementSummaries(db, { targetKeys: [libraryTargetKey(agentType)] });
}

function listFor(db: Database, status: unknown, rawLimit: unknown): ImprovementSummaryItem[] {
  const n = Number(rawLimit);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), LIST_MAX) : LIST_DEFAULT;
  let rows: Improvement[];
  if (status === "all") {
    rows = listImprovements(db, { limit });
  } else if (status === "decided") {
    rows = [...listImprovements(db, { status: "approved", limit }), ...listImprovements(db, { status: "rejected", limit })]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
      .slice(0, limit);
  } else {
    rows = listImprovements(db, { status: "pending", limit });
  }
  return rows.map((imp) => improvementSummary(db, imp));
}

function requireId(params: Record<string, unknown>): string {
  const id = String(params.id ?? "").trim();
  if (!id) throw new Error("id is required");
  return id;
}

/**
 * `improvements/*`. Actions reply with the detail projection; the
 * `improvement:changed` fat event (with siblings) reconciles every client.
 */
export function handleImprovementsRequest(db: Database, action: string, params: Record<string, unknown>): ResourceResult {
  if (!isExperimental()) return { ok: false, error: "Improvements require the daemon --experimental flag" };
  try {
    return dispatch(db, action, params);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function dispatch(db: Database, action: string, params: Record<string, unknown>): ResourceResult {
  switch (action) {
    case "list":
      return { ok: true, data: listFor(db, params.status, params.limit) };
    case "read": {
      const imp = getImprovement(db, requireId(params));
      if (!imp) return { ok: false, error: "Improvement not found" };
      return { ok: true, data: improvementDetail(db, imp) };
    }
    case "edit": {
      const id = requireId(params);
      if (typeof params.text !== "string") return { ok: false, error: "text is required" };
      return { ok: true, data: improvementDetail(db, editImprovement(db, id, params.text)) };
    }
    case "approve":
      return { ok: true, data: improvementDetail(db, approveImprovement(db, requireId(params))) };
    case "reject":
      return { ok: true, data: improvementDetail(db, rejectImprovement(db, requireId(params))) };
    case "settings":
      return { ok: true, data: { autoApprove: isImprovementsAutoApproveOn(db), enabled: isImprovementsEnabled(db) } };
    case "set-auto-approve": {
      const raw = params.on;
      if (raw === undefined || raw === null) return { ok: false, error: "on is required" };
      const on = raw === true || raw === "true" || raw === "on" || raw === 1 || raw === "1";
      setImprovementsAutoApprove(db, on);
      return { ok: true, data: { autoApprove: on } };
    }
    default:
      return { ok: false, error: `Unknown improvements action: ${action}` };
  }
}
