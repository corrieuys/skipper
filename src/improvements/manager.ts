import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "crypto";
import { eventBus } from "../events/bus";
import { isCustomAgentType } from "../agents/types";
import { getCustomAgent, customAgentIdFromType, updateCustomAgent } from "../custom-agents/store";
import {
  getSingleAgent,
  isSingleAgentRefType,
  singleAgentIdFromRefType,
  singleAgentRefType,
  updateSingleAgent,
} from "../single-agents/store";
import {
  type LocalTeam,
  type LocalTeamInput,
  getLocalTeam,
  reflattenTeamsReferencingAgentType,
  teamsReferencingAgentType,
  updateLocalTeam,
} from "../teams/local-teams";
import { ScheduledTaskScheduler } from "../tasks/scheduled-scheduler";
import { getBoolSetting, setBoolSetting } from "../config/app-settings";

/**
 * Improvements: configuration changes a root Skipper stages at the end of a run.
 * Staging never touches the target; the operator approves (optionally after
 * editing) on the Improvements page, and only then is the live record written
 * through its normal writer (which emits team:changed / recurring:changed).
 *
 * Any number of pending improvements may target the same text. Each one keeps
 * the revision (hash) of the live text it was written against. When the live
 * text moves on (another improvement approved, or a manual edit), the others
 * are in conflict: approve refuses them until the operator edits one, which
 * rebases it onto the current text.
 */

export type ImprovementKind =
  | "phase_prompt"
  | "agent_instruction"
  | "lead_instructions"
  | "recurring_description"
  | "skill_suggestion";

export type ImprovementStatus = "pending" | "approved" | "rejected";

export interface Improvement {
  id: string;
  kind: ImprovementKind;
  status: ImprovementStatus;
  target_key: string;
  target_label: string;
  team_id: string | null;
  scheduled_task_id: string | null;
  phase_index: number | null;
  phase_name: string | null;
  agent_ref: string | null;
  skill_name: string | null;
  before_text: string;
  base_revision: string;
  proposed_text: string;
  reason: string;
  source_task_id: string | null;
  source_task_title: string | null;
  edited_at: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A config target an improvement can change. Skill suggestions have none. */
export type ImprovementTarget =
  | { kind: "phase_prompt"; teamId: string; phaseIndex: number; phaseName: string }
  | { kind: "lead_instructions"; teamId: string }
  /** `agentRef`: an inline member id, or a library type (`single:<id>` / `custom:<id>`). */
  | { kind: "agent_instruction"; teamId: string; agentRef: string }
  | { kind: "recurring_description"; scheduledTaskId: string };

export const MAX_IMPROVEMENT_TEXT = 50_000;

/** Short content hash of a target's live text. Equal text, equal revision. */
export function textRevision(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Live target read / write
// ---------------------------------------------------------------------------

export interface LiveTarget {
  text: string;
  revision: string;
  key: string;
  label: string;
  /** Library agent targets only: how many teams use the agent. */
  usedByTeams?: number;
}

function live(text: string, key: string, label: string, usedByTeams?: number): LiveTarget {
  return { text, revision: textRevision(text), key, label, ...(usedByTeams !== undefined ? { usedByTeams } : {}) };
}

/** Target key for a library agent: shared by every team that references it. */
export function libraryTargetKey(type: string): string {
  return `agent:${type}`;
}

/** The target's current text, or null when it no longer exists. */
export function readLiveTarget(db: Database, target: ImprovementTarget): LiveTarget | null {
  if (target.kind === "recurring_description") {
    const rec = new ScheduledTaskScheduler(db).getScheduledTask(target.scheduledTaskId);
    if (!rec) return null;
    return live(rec.description ?? "", `recurring:${rec.id}`, `Recurring task "${rec.title}"`);
  }

  if (target.kind === "agent_instruction" && isSingleAgentRefType(target.agentRef)) {
    const rec = getSingleAgent(db, singleAgentIdFromRefType(target.agentRef));
    if (!rec) return null;
    return live(rec.instruction, libraryTargetKey(target.agentRef), `Library agent "${rec.name}"`, teamsReferencingAgentType(db, target.agentRef).length);
  }
  if (target.kind === "agent_instruction" && isCustomAgentType(target.agentRef)) {
    const rec = getCustomAgent(db, customAgentIdFromType(target.agentRef));
    if (!rec) return null;
    return live(rec.systemPrompt, libraryTargetKey(target.agentRef), `Library agent "${rec.name}"`, teamsReferencingAgentType(db, target.agentRef).length);
  }

  const team = getLocalTeam(db, target.teamId);
  if (!team) return null;
  if (target.kind === "lead_instructions") {
    return live(team.skipper_prompt, `lead:${team.id}`, `Team "${team.name}" › Skipper lead instructions`);
  }
  if (target.kind === "phase_prompt") {
    const phase = team.phases[target.phaseIndex];
    if (!phase || phase.name !== target.phaseName) return null;
    return live(
      phase.prompt ?? "",
      `phase:${team.id}:${target.phaseIndex}:${phase.name}`,
      `Team "${team.name}" › Phase ${target.phaseIndex + 1} "${phase.name}"`,
    );
  }
  const member = team.agents.find((a) => a.id === target.agentRef);
  // A member that became a library reference is no longer this target.
  if (!member || isSingleAgentRefType(member.type) || isCustomAgentType(member.type)) return null;
  return live(member.instruction ?? "", `agent:${team.id}:${member.id}`, `Team "${team.name}" › agent "${member.name}"`);
}

function teamInput(team: LocalTeam, patch: Partial<LocalTeamInput>): LocalTeamInput {
  return {
    id: team.id,
    name: team.name,
    skipper_prompt: team.skipper_prompt,
    hooks: team.hooks,
    phases: team.phases,
    agents: team.agents,
    config: team.config,
    ...patch,
  };
}

/** Write `text` into the target through its normal writer (each emits its own event). */
function applyToTarget(db: Database, target: ImprovementTarget, text: string): void {
  if (target.kind === "recurring_description") {
    new ScheduledTaskScheduler(db).setDescription(target.scheduledTaskId, text);
    return;
  }
  if (target.kind === "agent_instruction" && isSingleAgentRefType(target.agentRef)) {
    const id = singleAgentIdFromRefType(target.agentRef);
    const rec = getSingleAgent(db, id);
    if (!rec) throw new Error("Library agent no longer exists");
    updateSingleAgent(db, id, {
      name: rec.name,
      agent_type: rec.agent_type,
      model: rec.model,
      instruction: text,
      capabilities: rec.capabilities,
      config: rec.config,
    });
    // Same as the library route: re-project every team that references it.
    reflattenTeamsReferencingAgentType(db, singleAgentRefType(id));
    return;
  }
  if (target.kind === "agent_instruction" && isCustomAgentType(target.agentRef)) {
    const id = customAgentIdFromType(target.agentRef);
    const rec = getCustomAgent(db, id);
    if (!rec) throw new Error("Library agent no longer exists");
    const { id: _id, createdAt: _c, updatedAt: _u, ...input } = rec;
    updateCustomAgent(db, id, { ...input, systemPrompt: text });
    return;
  }

  const team = getLocalTeam(db, target.teamId);
  if (!team) throw new Error("Team no longer exists");
  if (target.kind === "lead_instructions") {
    updateLocalTeam(db, team.id, teamInput(team, { skipper_prompt: text }));
    return;
  }
  if (target.kind === "phase_prompt") {
    const phases = team.phases.map((p, i) => (i === target.phaseIndex ? { ...p, prompt: text } : p));
    updateLocalTeam(db, team.id, teamInput(team, { phases }));
    return;
  }
  const agents = team.agents.map((a) => (a.id === target.agentRef ? { ...a, instruction: text } : a));
  updateLocalTeam(db, team.id, teamInput(team, { agents }));
}

/** Rebuild the target an improvement row points at. Null for skill suggestions. */
export function targetOf(imp: Improvement): ImprovementTarget | null {
  switch (imp.kind) {
    case "phase_prompt":
      return { kind: "phase_prompt", teamId: imp.team_id ?? "", phaseIndex: imp.phase_index ?? -1, phaseName: imp.phase_name ?? "" };
    case "lead_instructions":
      return { kind: "lead_instructions", teamId: imp.team_id ?? "" };
    case "agent_instruction":
      return { kind: "agent_instruction", teamId: imp.team_id ?? "", agentRef: imp.agent_ref ?? "" };
    case "recurring_description":
      return { kind: "recurring_description", scheduledTaskId: imp.scheduled_task_id ?? "" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function changed(id: string, change: "created" | "updated"): void {
  eventBus.emit("improvement:changed", { improvementId: id, change });
}

export function getImprovement(db: Database, id: string): Improvement | null {
  return (db.prepare("SELECT * FROM improvements WHERE id = ?").get(id) as Improvement | null) ?? null;
}

export interface ListImprovementsFilter {
  status?: ImprovementStatus;
  /** Rows matching ANY of these scopes. Omit all three for every row. */
  teamId?: string | null;
  scheduledTaskId?: string | null;
  targetKeys?: string[];
  limit?: number;
}

/** Newest first. */
export function listImprovements(db: Database, filter: ListImprovementsFilter = {}): Improvement[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  const scopes: string[] = [];
  if (filter.teamId) {
    scopes.push("team_id = ?");
    params.push(filter.teamId);
  }
  if (filter.scheduledTaskId) {
    scopes.push("scheduled_task_id = ?");
    params.push(filter.scheduledTaskId);
  }
  if (filter.targetKeys && filter.targetKeys.length > 0) {
    scopes.push(`target_key IN (${filter.targetKeys.map(() => "?").join(", ")})`);
    params.push(...filter.targetKeys);
  }
  if (scopes.length > 0) where.push(`(${scopes.join(" OR ")})`);
  const sql = `SELECT * FROM improvements${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  params.push(filter.limit ?? 500);
  return db.prepare(sql).all(...params) as Improvement[];
}

export function countPendingImprovements(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM improvements WHERE status = 'pending'").get() as { c: number }).c;
}

export type ImprovementState =
  | { state: "decided" }
  | { state: "suggestion" }
  | { state: "missing" }
  | { state: "ready"; live: LiveTarget }
  | { state: "conflict"; live: LiveTarget };

/** Where a pending improvement stands against the live text right now. */
export function improvementState(db: Database, imp: Improvement): ImprovementState {
  if (imp.status !== "pending") return { state: "decided" };
  const target = targetOf(imp);
  if (!target) return { state: "suggestion" };
  const current = readLiveTarget(db, target);
  if (!current) return { state: "missing" };
  return current.revision === imp.base_revision ? { state: "ready", live: current } : { state: "conflict", live: current };
}

function checkText(label: string, text: string): string {
  if (!text.trim()) throw new Error(`${label} must not be empty`);
  if (text.length > MAX_IMPROVEMENT_TEXT) throw new Error(`${label} is longer than ${MAX_IMPROVEMENT_TEXT} characters`);
  return text;
}

function sourceTaskTitle(db: Database, taskId: string | null | undefined): string | null {
  if (!taskId) return null;
  const row = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title: string | null } | null;
  return row?.title ?? null;
}

export interface StageImprovementInput {
  target: ImprovementTarget;
  proposedText: string;
  /** Revision of the live text the caller read. Must still match. */
  revision: string;
  reason: string;
  sourceTaskId?: string | null;
}

/**
 * Stage a change to a live target. Never writes the target. Refuses when the
 * caller's revision is out of date (it must read the text again), when the
 * target is gone, or when the proposal equals the live text.
 */
export function stageImprovement(db: Database, input: StageImprovementInput): Improvement {
  const proposed = checkText("Proposed text", input.proposedText);
  const reason = checkText("Reason", input.reason);
  const { target } = input;
  if (target.kind !== "recurring_description" && !isLibraryTarget(target)) {
    const team = getLocalTeam(db, target.teamId);
    if (team?.remote) throw new Error("This team comes from a remote repository; change it in the repository.");
  }
  const current = readLiveTarget(db, target);
  if (!current) throw new Error("Target not found");
  if (input.revision !== current.revision) {
    throw new Error(`The text changed since you read it (revision is now ${current.revision}). Read it again and rebuild your proposal on the current text.`);
  }
  if (proposed === current.text) throw new Error("The proposed text is the same as the current text");

  const id = randomUUID();
  db.prepare(
    `INSERT INTO improvements (
       id, kind, status, target_key, target_label, team_id, scheduled_task_id, phase_index, phase_name,
       agent_ref, before_text, base_revision, proposed_text, reason, source_task_id, source_task_title
     ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    target.kind,
    current.key,
    current.label,
    "teamId" in target ? target.teamId : null,
    target.kind === "recurring_description" ? target.scheduledTaskId : null,
    target.kind === "phase_prompt" ? target.phaseIndex : null,
    target.kind === "phase_prompt" ? target.phaseName : null,
    target.kind === "agent_instruction" ? target.agentRef : null,
    current.text,
    current.revision,
    proposed,
    reason,
    input.sourceTaskId ?? null,
    sourceTaskTitle(db, input.sourceTaskId),
  );
  changed(id, "created");
  return getImprovement(db, id)!;
}

function isLibraryTarget(target: ImprovementTarget): boolean {
  return target.kind === "agent_instruction" && (isSingleAgentRefType(target.agentRef) || isCustomAgentType(target.agentRef));
}

export interface StageSkillSuggestionInput {
  teamId: string | null;
  skillName: string;
  /** Who used the skill: a team member id, or null for the whole team. */
  agentRef?: string | null;
  agentLabel?: string | null;
  problem: string;
  suggestion: string;
  sourceTaskId?: string | null;
}

/** A suggestion about a skill Skipper cannot change. Acknowledge / dismiss only. */
export function stageSkillSuggestion(db: Database, input: StageSkillSuggestionInput): Improvement {
  const skill = checkText("Skill name", input.skillName).trim();
  const problem = checkText("Problem", input.problem);
  const suggestion = checkText("Suggestion", input.suggestion);
  const id = randomUUID();
  const label = `Skill "${skill}"${input.agentLabel ? ` used by ${input.agentLabel}` : ""}`;
  db.prepare(
    `INSERT INTO improvements (
       id, kind, status, target_key, target_label, team_id, agent_ref, skill_name,
       proposed_text, reason, source_task_id, source_task_title
     ) VALUES (?, 'skill_suggestion', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `skill:${skill}`,
    label,
    input.teamId,
    input.agentRef ?? null,
    skill,
    suggestion,
    problem,
    input.sourceTaskId ?? null,
    sourceTaskTitle(db, input.sourceTaskId),
  );
  changed(id, "created");
  return getImprovement(db, id)!;
}

function requirePending(db: Database, id: string): Improvement {
  const imp = getImprovement(db, id);
  if (!imp) throw new Error("Improvement not found");
  if (imp.status !== "pending") throw new Error(`Improvement is already ${imp.status}`);
  return imp;
}

/**
 * Operator edit. Replaces the proposed text AND rebases the improvement onto the
 * current live text: the operator saw that text in the editor, so the edit is
 * the conflict resolution.
 */
export function editImprovement(db: Database, id: string, proposedText: string): Improvement {
  const imp = requirePending(db, id);
  const proposed = checkText("Proposed text", proposedText);
  const target = targetOf(imp);
  if (!target) {
    db.prepare("UPDATE improvements SET proposed_text = ?, edited_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(proposed, id);
  } else {
    const current = readLiveTarget(db, target);
    if (!current) throw new Error("The target no longer exists");
    db.prepare(
      `UPDATE improvements SET proposed_text = ?, before_text = ?, base_revision = ?,
         edited_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
    ).run(proposed, current.text, current.revision, id);
  }
  changed(id, "updated");
  return getImprovement(db, id)!;
}

/**
 * Apply the proposed text to the live target (a skill suggestion is only
 * acknowledged). Refuses a conflict: the live text moved since the proposal
 * was written, so the operator must edit (rebase) it first.
 */
export function approveImprovement(db: Database, id: string): Improvement {
  const imp = requirePending(db, id);
  const target = targetOf(imp);
  if (target) {
    const current = readLiveTarget(db, target);
    if (!current) throw new Error("The target no longer exists");
    if (current.revision !== imp.base_revision) {
      throw new Error("The live text changed since this was proposed. Edit it to resolve the conflict, then approve.");
    }
    applyToTarget(db, target, imp.proposed_text);
  }
  db.prepare("UPDATE improvements SET status = 'approved', decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  changed(id, "updated");
  return getImprovement(db, id)!;
}

/**
 * Operator gate (config page, runtime app_settings): when on, a staged config
 * change is approved (applied) the moment it is proposed. Skill suggestions have
 * nothing to apply, so they always wait for the operator.
 */
export const SETTING_IMPROVEMENTS_AUTO_APPROVE = "improvements_auto_approve";

export function isImprovementsAutoApproveOn(db: Database): boolean {
  return getBoolSetting(db, SETTING_IMPROVEMENTS_AUTO_APPROVE, false);
}

export function setImprovementsAutoApprove(db: Database, on: boolean): void {
  setBoolSetting(db, SETTING_IMPROVEMENTS_AUTO_APPROVE, on);
  eventBus.emit("improvements:settings_changed", { autoApprove: on, enabled: isImprovementsEnabled(db) });
}

/**
 * Operator switch (config page, runtime app_settings, default on): when off, no
 * root Skipper gets the housekeeping tools or the TEAM HOUSEKEEPING prompt block,
 * so nothing new is staged. Existing improvements stay reviewable.
 */
export const SETTING_IMPROVEMENTS_ENABLED = "improvements_enabled";

export function isImprovementsEnabled(db: Database): boolean {
  return getBoolSetting(db, SETTING_IMPROVEMENTS_ENABLED, true);
}

export function setImprovementsEnabled(db: Database, on: boolean): void {
  setBoolSetting(db, SETTING_IMPROVEMENTS_ENABLED, on);
  eventBus.emit("improvements:settings_changed", { autoApprove: isImprovementsAutoApproveOn(db), enabled: on });
}

/**
 * The agent's entry point: stage, then apply at once when auto-approve is on.
 * An auto-approve that fails (the live text moved between the two steps)
 * leaves the improvement staged for the operator.
 */
export function submitImprovement(db: Database, input: StageImprovementInput): { improvement: Improvement; applied: boolean } {
  const staged = stageImprovement(db, input);
  if (!isImprovementsAutoApproveOn(db)) return { improvement: staged, applied: false };
  try {
    return { improvement: approveImprovement(db, staged.id), applied: true };
  } catch {
    return { improvement: getImprovement(db, staged.id)!, applied: false };
  }
}

export function rejectImprovement(db: Database, id: string): Improvement {
  requirePending(db, id);
  db.prepare("UPDATE improvements SET status = 'rejected', decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  changed(id, "updated");
  return getImprovement(db, id)!;
}

// ---------------------------------------------------------------------------
// Run context (shared by the MCP tools and the prompt block)
// ---------------------------------------------------------------------------

export interface ImprovementContext {
  taskId: string;
  /** The task's team id (local or remote). */
  teamId: string | null;
  /** The task's local team, null when none or remote (team tools are then off). */
  team: LocalTeam | null;
  remoteTeam: boolean;
  /** The recurring task this run came from, when it still exists. */
  scheduledTaskId: string | null;
  /** Phase names this run overrides via task_config.phase_overrides. */
  overriddenPhases: Set<string>;
}

export function getImprovementContext(db: Database, taskId: string | null | undefined): ImprovementContext | null {
  if (!taskId) return null;
  const row = db
    .prepare("SELECT team_id, source_scheduled_task_id, task_config FROM tasks WHERE id = ?")
    .get(taskId) as { team_id: string | null; source_scheduled_task_id: string | null; task_config: string | null } | null;
  if (!row) return null;
  const team = row.team_id ? getLocalTeam(db, row.team_id) : null;
  const scheduledTaskId = row.source_scheduled_task_id && new ScheduledTaskScheduler(db).getScheduledTask(row.source_scheduled_task_id)
    ? row.source_scheduled_task_id
    : null;
  const overriddenPhases = new Set<string>();
  try {
    const overrides = (JSON.parse(row.task_config ?? "{}") as { phase_overrides?: Record<string, { prompt?: string }> }).phase_overrides;
    for (const [name, o] of Object.entries(overrides ?? {})) {
      if (typeof o?.prompt === "string" && o.prompt.trim()) overriddenPhases.add(name);
    }
  } catch {
    // unreadable config: no overrides
  }
  return {
    taskId,
    teamId: team ? team.id : null,
    team: team && !team.remote ? team : null,
    remoteTeam: !!team?.remote,
    scheduledTaskId,
    overriddenPhases,
  };
}

/** Whether a run has anything to maintain (a local team or a recurring task). */
export function hasImprovementTargets(ctx: ImprovementContext | null): boolean {
  return !!ctx && (!!ctx.team || !!ctx.scheduledTaskId);
}
