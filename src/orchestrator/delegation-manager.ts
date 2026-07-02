import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { PromptBuilder, AgentInfo, PhaseInfo } from "../agents/prompt-builder";
import type { TaskScheduler } from "../tasks/scheduler";
import { agentTypeUsesInlinePrompt, getAgentTypeDefinition } from "../agents/types";
import { getEntrypointAgentId } from "../agents/skipper";
import { eventBus } from "../events/bus";
import { logError } from "../logging";
import { updateInstanceStatus } from "../agents/instance-status";
import { resolvePhaseConfig } from "./phase-config";

const CHILD_RETRY_LIMIT = 1;
const DELEGATION_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const DELEGATION_TIMEOUT_SECONDS = Math.floor(DELEGATION_TIMEOUT_MS / 1000);
const GROUP_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const GROUP_TIMEOUT_SECONDS = Math.floor(GROUP_TIMEOUT_MS / 1000);
const CHILD_FAILURE_ESCALATION_THRESHOLD = 2;
// Sent as the prompt when a timed-out child is retried via session resume
// (instead of a fresh restart). Pushes it to wrap up rather than start over.
const RETRY_NUDGE_PROMPT = [
  "[SYSTEM] [RETRY_NUDGE] Your delegation has been running past its timeout and was resumed.",
  "Review what you have already done and finish: wrap up the remaining work and report your result with [DELEGATE_COMPLETE] <result>.",
  "If you are blocked, report that via [DELEGATE_COMPLETE] with the blocker. Do not restart work already completed.",
].join("\n");

export const MAX_DELEGATION_RESULT_CHARS = 50_000;

export function truncateResult(text: string, limit: number = MAX_DELEGATION_RESULT_CHARS): string {
  if (text.length <= limit) return text;
  const marker = `\n\n[truncated — result exceeded ${limit} characters; showing start and end]\n\n`;
  const available = limit - marker.length;
  if (available <= 0) {
    return marker.trim();
  }
  const headChars = Math.floor(available * 0.35);
  const tailChars = Math.max(0, available - headChars);
  const head = text.slice(0, headChars);
  const tail = text.slice(text.length - tailChars);
  return `${head}${marker}${tail}`;
}

const DELEGATION_RESULT_START = /\[DELEGATION_RESULT from:[^\]]+\]\n/;
const DELEGATION_RESULT_END = "\n[END_DELEGATION_RESULT]";
const DELEGATION_BATCH_RESULT_START = /\[DELEGATION_BATCH_RESULT id:[^\]]+\]\n/;
const DELEGATION_BATCH_RESULT_END = "\n[END_DELEGATION_BATCH_RESULT]";

export interface Delegation {
  id: string;
  parent_agent_id: string;
  child_agent_id: string;
  parent_instance_id?: string | null;
  child_instance_id?: string | null;
  delegation_group_id?: string | null;
  task_id: string;
  prompt: string;
  result: string | null;
  status: "pending" | "running" | "completed" | "failed";
  created_at: string;
  completed_at: string | null;
}

interface DelegationBatchItem {
  to: string;
  work: string;
  label?: string;
}

/** Validated parent/task context every delegation-batch step operates on. */
interface DelegationBatchContext {
  parentTemplateId: string;
  parentInstanceId: string;
  taskId: string;
  isRealtime: boolean;
}

interface EligibleDelegationItem {
  item: DelegationBatchItem;
  childAgent: NonNullable<ReturnType<AgentManager["getAgent"]>>;
}

interface DelegationGroupRow {
  id: string;
  task_id: string;
  parent_instance_id: string;
  expected_count: number;
  settled_count: number;
  failed_count: number;
  status: "running" | "completed";
}

export class DelegationManager {
  private isConsensusGroupFn: ((groupId: string) => boolean) | null = null;

  setConsensusGroupCheck(fn: (groupId: string) => boolean): void {
    this.isConsensusGroupFn = fn;
  }

  constructor(
    private readonly db: Database,
    private readonly agentManager: AgentManager,
    private readonly promptBuilder: PromptBuilder,
    private readonly taskScheduler: TaskScheduler,
    private readonly setAgentState: (agentId: string, state: string, metadata?: Record<string, unknown>) => void,
    private readonly updateOrchestrationState: (taskId: string, state: import("./types").OrchestrationState) => void,
    private readonly writeCheckpoint: (taskId: string, type: string, snapshot?: Record<string, unknown>) => void,
    private readonly getPhaseCompleteHandled: () => Set<string>,
  ) { }

  async handleDelegation(
    parentRuntimeId: string,
    childAgentId: string,
    delegationPrompt: string,
  ): Promise<Delegation | null> {
    const delegation = await this.handleDelegationBatch(parentRuntimeId, [{ to: childAgentId, work: delegationPrompt }]);
    return delegation.length > 0 ? delegation[0] : null;
  }

  async handleDelegationBatch(parentRuntimeId: string, batchItems: DelegationBatchItem[]): Promise<Delegation[]> {
    const normalized = batchItems
      .map((item) => ({
        to: item.to?.trim(),
        work: item.work?.trim(),
        label: item.label?.trim(),
      }))
      .filter((item) => item.to && item.work) as DelegationBatchItem[];

    if (normalized.length === 0) return [];

    const ctx = this.resolveDelegationBatchContext(parentRuntimeId);
    if (!ctx) return [];

    const eligibleItems = this.filterEligibleDelegationTargets(ctx, normalized);
    if (eligibleItems.length === 0) {
      if (ctx.isRealtime) {
        this.routeResultToParent(
          ctx.parentInstanceId,
          ctx.parentInstanceId,
          "[DELEGATION_FAILED] No eligible realtime delegation targets. Assign the target agent to this realtime task first.",
          ctx.taskId,
        );
      }
      return [];
    }

    const rootInstanceId = this.getRootInstanceId(ctx.parentInstanceId, ctx.taskId);
    const groupId = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO delegation_groups (id, task_id, parent_instance_id, policy, expected_count, settled_count, failed_count, status)
         VALUES (?, ?, ?, 'wait_all_mixed', ?, 0, 0, 'running')`,
      )
      .run(groupId, ctx.taskId, ctx.parentInstanceId, eligibleItems.length);

    const started = await this.spawnDelegationGroupChildren(ctx, groupId, rootInstanceId, eligibleItems);

    if (started.length === 0) {
      this.db
        .prepare("UPDATE delegation_groups SET status = 'completed', completed_at = datetime('now') WHERE id = ?")
        .run(groupId);
      return [];
    }

    this.markParentWaitingOnGroup(ctx, groupId, rootInstanceId, started.length, eligibleItems.length);
    return started;
  }

  /** Resolve parent template/instance/task and check every batch precondition. */
  private resolveDelegationBatchContext(parentRuntimeId: string): DelegationBatchContext | null {
    const parentTemplateId = this.agentManager.getTemplateAgentId(parentRuntimeId) ?? parentRuntimeId;
    const parentInstanceId = this.resolveRuntimeParentInstance(parentRuntimeId, parentTemplateId);
    const parentTask = this.getTaskForRuntime(parentInstanceId);
    if (!parentTask?.task_id) return null;

    const taskId = parentTask.task_id;
    const task = this.taskScheduler.getTask(taskId);
    if (!task || task.status !== "running") return null;
    if (task.needs_review) return null;

    const parentAgent = this.agentManager.getAgent(parentTemplateId);
    if (!parentAgent) return null;
    const parentTypeDef = getAgentTypeDefinition(parentAgent.type, this.db);
    if (!parentTypeDef || (!parentTypeDef.supports_stdin && !parentTypeDef.supports_resume)) {
      return null;
    }

    if (this.getActiveDelegationGroupForParent(parentInstanceId)) return null;

    return { parentTemplateId, parentInstanceId, taskId, isRealtime: task.task_type === "real_time" };
  }

  private filterEligibleDelegationTargets(
    ctx: DelegationBatchContext,
    normalized: DelegationBatchItem[],
  ): EligibleDelegationItem[] {
    const eligibleItems: EligibleDelegationItem[] = [];
    for (const item of normalized) {
      const childAgent = this.resolveDelegationTarget(item.to);
      if (!childAgent) continue;
      if (!this.isDelegationTargetAllowed(ctx.parentInstanceId, ctx.parentTemplateId, childAgent.id, ctx.taskId)) continue;
      if (ctx.isRealtime) {
        if (!this.isRealtimeDelegationTargetAllowed(ctx.taskId, childAgent.id)) {
          this.emitDelegationEvent("delegation:realtime_target_not_assigned", {
            taskId: ctx.taskId,
            target: childAgent.id,
            hint: "Assign this agent in realtime task agent assignment before delegating.",
          });
          continue;
        }
      } else if (!this.agentsInSameTeam(ctx.parentTemplateId, childAgent.id)) {
        continue;
      }
      this.validateDelegationRole(ctx.parentTemplateId, childAgent.id, ctx.taskId);
      eligibleItems.push({ item, childAgent });
    }
    return eligibleItems;
  }

  private async spawnDelegationGroupChildren(
    ctx: DelegationBatchContext,
    groupId: string,
    rootInstanceId: string,
    eligibleItems: EligibleDelegationItem[],
  ): Promise<Delegation[]> {
    const started: Delegation[] = [];
    for (const { item, childAgent } of eligibleItems) {
      const delegationId = crypto.randomUUID();
      const childInstanceId = crypto.randomUUID();

      this.db
        .prepare(
          `INSERT INTO delegations (
             id, parent_agent_id, child_agent_id, parent_instance_id, child_instance_id, delegation_group_id, task_id, prompt, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(
          delegationId,
          ctx.parentTemplateId,
          childAgent.id,
          ctx.parentInstanceId,
          childInstanceId,
          groupId,
          ctx.taskId,
          item.work,
        );

      const spawned = await this.spawnChildInstance({
        taskId: ctx.taskId,
        delegationId,
        parentRuntimeId: ctx.parentInstanceId,
        rootInstanceId,
        childTemplateId: childAgent.id,
        childInstanceId,
        work: item.work,
        label: item.label,
        attempt: 1,
        workingDir: undefined, // Agents spawn in orchestrator cwd; task.working_directory is for worktrees
      });

      if (spawned) {
        started.push(this.getDelegation(delegationId)!);
      } else {
        this.settleDelegationFailure(delegationId, ctx.parentInstanceId, childInstanceId, ctx.taskId, "Failed to spawn delegated child instance");
      }
    }
    return started;
  }

  /** Flip parent to waiting_delegation and record the group in orchestration state. */
  private markParentWaitingOnGroup(
    ctx: DelegationBatchContext,
    groupId: string,
    rootInstanceId: string,
    startedCount: number,
    expectedCount: number,
  ): void {
    this.setAgentState(ctx.parentTemplateId, "waiting_delegation", { delegation_group_id: groupId });
    updateInstanceStatus(this.db, ctx.parentInstanceId, "waiting_delegation");
    eventBus.emit("instance:state_changed", {
      instanceId: ctx.parentInstanceId,
      templateAgentId: ctx.parentTemplateId,
      taskId: ctx.taskId,
      parentInstanceId: null,
      rootInstanceId: rootInstanceId,
      status: "waiting_delegation",
    });

    this.updateOrchestrationState(ctx.taskId, {
      step: "WAITING_DELEGATION",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: this.agentManager.getSessionId(ctx.parentInstanceId),
      active_delegation_group_id: groupId,
      active_delegation_child_count: startedCount,
      active_delegation_settled_count: 0,
      phase_guards: Array.from(this.getPhaseCompleteHandled()).filter((k) => k.startsWith(`${ctx.taskId}:`)),
      pending_regression: null,
      checkpoint_prompt_hash: null,
    });

    eventBus.emit("delegation_group:progress", {
      groupId,
      taskId: ctx.taskId,
      parentInstanceId: ctx.parentInstanceId,
      settledCount: 0,
      expectedCount,
      failedCount: 0,
      status: "running",
    });
  }

  async handleResumeDelegation(
    parentRuntimeId: string,
    priorChildInstanceId: string,
    delegationPrompt: string,
  ): Promise<Delegation | null> {
    const priorChild = this.db
      .prepare(
        "SELECT id, task_id, template_agent_id, session_id FROM agent_instances WHERE id = ?",
      )
      .get(priorChildInstanceId) as {
        id: string;
        task_id: string | null;
        template_agent_id: string;
        session_id: string | null;
      } | null;

    if (!priorChild) {
      this.emitDelegationEvent("delegation:resume_target_not_found", { priorChildInstanceId });
      return null;
    }

    const parentTemplateId = this.agentManager.getTemplateAgentId(parentRuntimeId) ?? parentRuntimeId;
    const parentInstanceId = this.resolveRuntimeParentInstance(parentRuntimeId, parentTemplateId);
    const parentTask = this.getTaskForRuntime(parentInstanceId);
    if (!parentTask?.task_id) return null;
    if (priorChild.task_id !== parentTask.task_id) {
      this.emitDelegationEvent("delegation:resume_task_mismatch", {
        priorChildInstanceId,
        priorTaskId: priorChild.task_id,
        currentTaskId: parentTask.task_id,
      });
      return null;
    }

    const childAgent = this.agentManager.getAgent(priorChild.template_agent_id);
    if (!childAgent) return null;
    const childTypeDef = getAgentTypeDefinition(childAgent.type, this.db);

    // Fall back to fresh delegation if no session to resume or type doesn't support resume.
    if (!priorChild.session_id || !childTypeDef?.supports_resume) {
      this.emitDelegationEvent("delegation:resume_fallback_fresh", {
        priorChildInstanceId,
        reason: !priorChild.session_id ? "no_session_id" : "type_does_not_support_resume",
      });
      return this.handleDelegation(parentRuntimeId, childAgent.id, delegationPrompt);
    }

    const task = this.taskScheduler.getTask(parentTask.task_id);
    if (!task || task.status !== "running") return null;
    if (task.needs_review) return null;

    const parentAgent = this.agentManager.getAgent(parentTemplateId);
    if (!parentAgent) return null;
    const parentTypeDef = getAgentTypeDefinition(parentAgent.type, this.db);
    if (!parentTypeDef || (!parentTypeDef.supports_stdin && !parentTypeDef.supports_resume)) {
      return null;
    }

    if (this.getActiveDelegationGroupForParent(parentInstanceId)) return null;
    if (!this.isDelegationTargetAllowed(parentInstanceId, parentTemplateId, childAgent.id, parentTask.task_id)) return null;
    if (task.task_type === "real_time" && !this.isRealtimeDelegationTargetAllowed(parentTask.task_id, childAgent.id)) {
      return null;
    } else if (task.task_type !== "real_time" && !this.agentsInSameTeam(parentTemplateId, childAgent.id)) {
      return null;
    }

    const rootInstanceId = this.getRootInstanceId(parentInstanceId, parentTask.task_id);
    const groupId = crypto.randomUUID();
    const delegationId = crypto.randomUUID();
    const newChildInstanceId = crypto.randomUUID();

    this.db
      .prepare(
        `INSERT INTO delegation_groups (id, task_id, parent_instance_id, policy, expected_count, settled_count, failed_count, status)
         VALUES (?, ?, ?, 'wait_all_mixed', 1, 0, 0, 'running')`,
      )
      .run(groupId, parentTask.task_id, parentInstanceId);

    this.db
      .prepare(
        `INSERT INTO delegations (
           id, parent_agent_id, child_agent_id, parent_instance_id, child_instance_id, delegation_group_id, task_id, prompt, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        delegationId,
        parentTemplateId,
        childAgent.id,
        parentInstanceId,
        newChildInstanceId,
        groupId,
        parentTask.task_id,
        delegationPrompt,
      );

    const spawned = await this.spawnChildInstance({
      taskId: parentTask.task_id,
      delegationId,
      parentRuntimeId: parentInstanceId,
      rootInstanceId,
      childTemplateId: childAgent.id,
      childInstanceId: newChildInstanceId,
      work: delegationPrompt,
      attempt: 1,
      workingDir: undefined,
      resumeSessionId: priorChild.session_id,
    });

    if (!spawned) {
      this.settleDelegationFailure(delegationId, parentInstanceId, newChildInstanceId, parentTask.task_id, "Failed to spawn resumed child instance");
      return null;
    }

    this.setAgentState(parentTemplateId, "waiting_delegation", { delegation_group_id: groupId });
    updateInstanceStatus(this.db, parentInstanceId, "waiting_delegation");
    eventBus.emit("instance:state_changed", {
      instanceId: parentInstanceId,
      templateAgentId: parentTemplateId,
      taskId: parentTask.task_id,
      parentInstanceId: null,
      rootInstanceId,
      status: "waiting_delegation",
    });

    this.updateOrchestrationState(parentTask.task_id, {
      step: "WAITING_DELEGATION",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: this.agentManager.getSessionId(parentInstanceId),
      active_delegation_group_id: groupId,
      active_delegation_child_count: 1,
      active_delegation_settled_count: 0,
      phase_guards: Array.from(this.getPhaseCompleteHandled()).filter((k) => k.startsWith(`${parentTask.task_id}:`)),
      pending_regression: null,
      checkpoint_prompt_hash: null,
    });

    return this.getDelegation(delegationId);
  }

  handleDelegateComplete(childRuntimeId: string, result: string): void {
    try {
      const delegation = this.getActiveDelegationForChild(childRuntimeId);
      if (!delegation) return;

      const truncatedResult = truncateResult(result);

      this.db
        .prepare(
          "UPDATE delegations SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?",
        )
        .run(truncatedResult, delegation.id);

      this.agentManager.killAgent(childRuntimeId);

      updateInstanceStatus(this.db, childRuntimeId, "completed");
      this.clearTemplateTaskIfNoActive(delegation.child_agent_id);

      this.handleGroupProgress(delegation, childRuntimeId, false);
    } catch (err) {
      logError(this.db, "delegation_complete", { childRuntimeId, method: "handleDelegateComplete" }, err);
    }
  }

  handleChildExit(delegation: Delegation, event: { agentId: string; code: number | null }): void {
    try {
      if (event.code === 0) {
        const result = truncateResult(this.gatherTerminalOutput(event.agentId));
        this.db
          .prepare(
            "UPDATE delegations SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?",
          )
          .run(result, delegation.id);
        updateInstanceStatus(this.db, event.agentId, "completed");
        this.clearTemplateTaskIfNoActive(delegation.child_agent_id);
        this.handleGroupProgress(delegation, event.agentId, false);
      } else {
        const retryResult = this.tryRetryDelegation(delegation);
        if (retryResult) return; // true or "pending" — retry is in progress

        this.db
          .prepare(
            "UPDATE delegations SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?",
          )
          .run(`Child agent exited with code ${event.code}`, delegation.id);
        updateInstanceStatus(this.db, event.agentId, "failed");
        this.clearTemplateTaskIfNoActive(delegation.child_agent_id);
        this.handleGroupProgress(delegation, event.agentId, true);
      }
    } catch (err) {
      logError(
        this.db,
        "child_exit_handler",
        { delegationId: delegation.id, childRuntimeId: event.agentId, exitCode: event.code, method: "handleChildExit" },
        err,
      );
    }
  }

  checkStaleDelegations(): number {
    const stale = this.db
      .prepare(
        `SELECT d.*
         FROM delegations d
         LEFT JOIN agent_instances ai ON ai.id = d.child_instance_id
         WHERE d.status = 'running'
           AND unixepoch(COALESCE(ai.created_at, d.created_at)) < (unixepoch('now') - ?)`,
      )
      .all(DELEGATION_TIMEOUT_SECONDS) as Delegation[];

    for (const delegation of stale) {
      try {
        const retryResult = this.tryRetryDelegation(delegation);
        if (retryResult) continue; // true or "pending" — retry is in progress

        this.db
          .prepare(
            "UPDATE delegations SET status = 'failed', result = 'Delegation timed out', completed_at = datetime('now') WHERE id = ?",
          )
          .run(delegation.id);

        if (delegation.child_instance_id) {
          this.agentManager.killAgent(delegation.child_instance_id);
          updateInstanceStatus(this.db, delegation.child_instance_id, "failed");
        }
        this.clearTemplateTaskIfNoActive(delegation.child_agent_id);

        this.handleGroupProgress(delegation, delegation.child_instance_id ?? delegation.child_agent_id, true);
      } catch (err) {
        logError(
          this.db,
          "stale_delegation_cleanup",
          { delegationId: delegation.id, parentRuntimeId: delegation.parent_instance_id, childRuntimeId: delegation.child_instance_id },
          err,
        );
      }
    }

    return stale.length;
  }

  /**
   * Check delegation_groups in running status that have exceeded the group timeout.
   * Force-settle all unsettled delegations, kill live children, and route failure to parent.
   */
  checkStaleDelegationGroups(): number {
    const staleGroups = this.db
      .prepare(
        "SELECT * FROM delegation_groups WHERE status = 'running' AND unixepoch(created_at) < (unixepoch('now') - ?)",
      )
      .all(GROUP_TIMEOUT_SECONDS) as DelegationGroupRow[];

    for (const group of staleGroups) {
      try {
        // Force-fail all unsettled delegations in this group
        const unsettled = this.db
          .prepare(
            "SELECT id, child_instance_id, child_agent_id FROM delegations WHERE delegation_group_id = ? AND status IN ('pending', 'running')",
          )
          .all(group.id) as Array<{ id: string; child_instance_id: string | null; child_agent_id: string }>;

        for (const del of unsettled) {
          this.db
            .prepare(
              "UPDATE delegations SET status = 'failed', result = 'Delegation group timed out', completed_at = datetime('now') WHERE id = ?",
            )
            .run(del.id);
          if (del.child_instance_id) {
            this.agentManager.killAgent(del.child_instance_id);
            updateInstanceStatus(this.db, del.child_instance_id, "failed");
          }
          this.clearTemplateTaskIfNoActive(del.child_agent_id);
        }

        // Mark group completed
        this.db
          .prepare(
            "UPDATE delegation_groups SET status = 'completed', settled_count = expected_count, failed_count = expected_count, completed_at = datetime('now') WHERE id = ?",
          )
          .run(group.id);

        // Route failure to parent via finishDelegationGroup
        const updatedGroup = this.db
          .prepare("SELECT * FROM delegation_groups WHERE id = ?")
          .get(group.id) as DelegationGroupRow | null;
        if (updatedGroup) {
          this.finishDelegationGroup(updatedGroup);
        }

        this.emitRemediationEvent("stale_delegation_group", null, group.task_id, {
          groupId: group.id,
          unsettledCount: unsettled.length,
        });
      } catch (err) {
        logError(this.db, "stale_delegation_group_cleanup", { groupId: group.id }, err);
      }
    }

    return staleGroups.length;
  }

  getDelegation(id: string): Delegation | null {
    try {
      const row = this.db
        .prepare("SELECT * FROM delegations WHERE id = ?")
        .get(id) as Delegation | null;
      return row ?? null;
    } catch (err) {
      logError(this.db, "get_delegation", { delegationId: id, method: "getDelegation" }, err);
      return null;
    }
  }

  getActiveDelegationForParent(parentRuntimeId: string): Delegation | null {
    try {
      const row = this.db
        .prepare(
          "SELECT * FROM delegations WHERE parent_instance_id = ? AND status IN ('pending', 'running') LIMIT 1",
        )
        .get(parentRuntimeId) as Delegation | null;
      return row ?? null;
    } catch (err) {
      logError(this.db, "get_active_delegation_parent", { parentRuntimeId, method: "getActiveDelegationForParent" }, err);
      return null;
    }
  }

  getActiveDelegationForChild(childRuntimeId: string): Delegation | null {
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM delegations
           WHERE (child_instance_id = ? OR child_agent_id = ?)
             AND status IN ('pending', 'running')
           LIMIT 1`,
        )
        .get(childRuntimeId, childRuntimeId) as Delegation | null;
      return row ?? null;
    } catch (err) {
      logError(this.db, "get_active_delegation_child", { childRuntimeId, method: "getActiveDelegationForChild" }, err);
      return null;
    }
  }

  getDelegationDepth(parentRuntimeId: string, taskId: string): number {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE chain(instance_id, depth) AS (
           SELECT parent_instance_id, 1
           FROM delegations
           WHERE child_instance_id = ? AND task_id = ? AND status IN ('pending', 'running')
           UNION ALL
           SELECT d.parent_instance_id, c.depth + 1
           FROM chain c
           JOIN delegations d ON d.child_instance_id = c.instance_id
            AND d.task_id = ?
            AND d.status IN ('pending', 'running')
         )
         SELECT MAX(depth) as max_depth FROM chain`,
      )
      .get(parentRuntimeId, taskId, taskId) as { max_depth: number | null } | null;
    return rows?.max_depth ?? 0;
  }

  private getActiveDelegationGroupForParent(parentRuntimeId: string): DelegationGroupRow | null {
    const row = this.db
      .prepare("SELECT * FROM delegation_groups WHERE parent_instance_id = ? AND status = 'running' LIMIT 1")
      .get(parentRuntimeId) as DelegationGroupRow | null;
    return row ?? null;
  }

  /**
   * Resolve the task's current phase into PhaseInfo so delegated children
   * receive the same phase instructions skipper does. Returns undefined if
   * the task has no team, the team has no phases, or the current_phase is
   * out of range — caller treats undefined as "no phase context to pass".
   */
  private getCurrentPhaseInfo(taskId: string): PhaseInfo | undefined {
    const task = this.taskScheduler.getTask(taskId);
    if (!task || !task.team_id) return undefined;
    const teamRow = this.db
      .prepare("SELECT phases FROM teams WHERE id = ?")
      .get(task.team_id) as { phases: string } | null;
    if (!teamRow?.phases) return undefined;
    let phases: Array<{ name: string; prompt: string }>;
    try {
      phases = JSON.parse(teamRow.phases) as Array<{ name: string; prompt: string }>;
    } catch {
      return undefined;
    }
    if (!Array.isArray(phases) || phases.length === 0) return undefined;
    const idx = Math.min(Math.max(0, task.current_phase ?? 0), phases.length - 1);
    const rawPhase = phases[idx];
    if (!rawPhase) return undefined;
    const resolved = resolvePhaseConfig(rawPhase, task.task_config as Record<string, unknown>);
    return {
      name: resolved.name,
      prompt: resolved.prompt,
      index: idx,
      total: phases.length,
    };
  }

  private async spawnChildInstance(input: {
    taskId: string;
    delegationId: string;
    parentRuntimeId: string;
    rootInstanceId: string;
    childTemplateId: string;
    childInstanceId: string;
    work: string;
    label?: string;
    attempt: number;
    workingDir?: string;
    resumeSessionId?: string;
  }): Promise<boolean> {
    const childAgent = this.agentManager.getAgent(input.childTemplateId);
    if (!childAgent) return false;
    const childTypeDef = getAgentTypeDefinition(childAgent.type, this.db);
    const isStreaming = childTypeDef?.supports_stdin ?? false;

    const childInfo: AgentInfo = {
      id: childAgent.id,
      name: childAgent.name,
      type: childAgent.type,
      instruction: childAgent.config.instruction,
    };

    // Check if parent is a consensus agent — propagate shortId and worktree path
    const consensusRow = this.db
      .prepare("SELECT agent_instance_id, worktree_path FROM consensus_worktrees WHERE agent_instance_id = ? LIMIT 1")
      .get(input.parentRuntimeId) as { agent_instance_id: string; worktree_path: string } | null;
    const consensusShortId = consensusRow ? input.parentRuntimeId.slice(0, 8) : undefined;
    // If parent is a consensus agent with a worktree, spawn child in that worktree
    const consensusWorktreePath = consensusRow?.worktree_path || undefined;

    const { prompt, noteIds } = this.promptBuilder.buildDelegationPromptTracked({
      childAgent: childInfo,
      task: {
        id: input.taskId,
        title: this.taskScheduler.getTask(input.taskId)?.title ?? "Delegated Task",
        description: this.taskScheduler.getTask(input.taskId)?.description ?? undefined,
        workingDirectory: this.taskScheduler.getTask(input.taskId)?.working_directory,
      },
      delegationPrompt: input.work,
      phase: this.getCurrentPhaseInfo(input.taskId),
      consensusShortId,
      consensusWorktree: !!consensusWorktreePath,
    }, input.childInstanceId);
    const usesInlinePrompt = childTypeDef ? agentTypeUsesInlinePrompt(childTypeDef) : false;

    try {
      await this.agentManager.spawnAgentInstance(input.childTemplateId, input.childInstanceId, {
        workingDir: consensusWorktreePath || input.workingDir || process.cwd(),
        taskId: input.taskId,
        parentInstanceId: input.parentRuntimeId,
        rootInstanceId: input.rootInstanceId,
        attempt: input.attempt,
        initialPrompt: usesInlinePrompt ? prompt : undefined,
        sessionId: input.resumeSessionId,
      });
    } catch (err) {
      logError(this.db, "delegation_spawn", { delegationId: input.delegationId, childTemplateId: input.childTemplateId }, err);
      return false;
    }

    this.db
      .prepare("UPDATE delegations SET status = 'running', child_instance_id = ? WHERE id = ?")
      .run(input.childInstanceId, input.delegationId);
    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(input.taskId, input.childTemplateId);

    if (input.label) {
      this.db
        .prepare("UPDATE agent_instances SET state_metadata = json_set(state_metadata, '$.label', ?) WHERE id = ?")
        .run(input.label, input.childInstanceId);
    }

    try {
      if (!usesInlinePrompt) {
        const closeStdin = !isStreaming;
        this.agentManager.sendInput(input.childInstanceId, prompt, closeStdin);
      }
      if (noteIds.length > 0) {
        this.promptBuilder.recordNoteDelivery(input.childInstanceId, noteIds);
      }
    } catch (err) {
      logError(this.db, "delegation_send_input", { delegationId: input.delegationId, childInstanceId: input.childInstanceId, method: "spawnChildInstance" }, err);
      this.agentManager.killAgent(input.childInstanceId);
      return false;
    }

    eventBus.emit("instance:state_changed", {
      instanceId: input.childInstanceId,
      templateAgentId: input.childTemplateId,
      taskId: input.taskId,
      parentInstanceId: input.parentRuntimeId,
      rootInstanceId: input.rootInstanceId,
      status: "running",
    });

    return true;
  }

  private handleGroupProgress(delegation: Delegation, childRuntimeId: string, failed: boolean): void {
    const groupId = delegation.delegation_group_id;
    if (!groupId) {
      const latest = this.getDelegation(delegation.id) ?? delegation;
      const payload = failed
        ? `[DELEGATION_FAILED] ${latest.result ?? "Delegation failed"}`
        : latest.result ?? "";
      this.routeResultToParent(delegation.parent_instance_id ?? delegation.parent_agent_id, childRuntimeId, payload, delegation.task_id);
      return;
    }

    const group = this.db
      .prepare("SELECT * FROM delegation_groups WHERE id = ?")
      .get(groupId) as DelegationGroupRow | null;
    if (!group || group.status !== "running") return;

    const updated = this.db
      .prepare(
        `UPDATE delegation_groups
         SET settled_count = settled_count + 1,
             failed_count = failed_count + ?,
             completed_at = CASE WHEN settled_count + 1 >= expected_count THEN datetime('now') ELSE completed_at END,
             status = CASE WHEN settled_count + 1 >= expected_count THEN 'completed' ELSE status END
         WHERE id = ?
         RETURNING *`,
      )
      .get(failed ? 1 : 0, groupId) as DelegationGroupRow | null;
    if (!updated) return;

    eventBus.emit("delegation_group:progress", {
      groupId,
      taskId: delegation.task_id,
      parentInstanceId: updated.parent_instance_id,
      settledCount: updated.settled_count,
      expectedCount: updated.expected_count,
      failedCount: updated.failed_count,
      status: updated.status,
    });

    // Escalate on repeated child failures
    if (
      updated.failed_count >= CHILD_FAILURE_ESCALATION_THRESHOLD &&
      updated.failed_count >= Math.ceil(updated.expected_count / 2)
    ) {
      try {
        const escalationId = crypto.randomUUID();
        this.db
          .prepare(
            `INSERT INTO escalations (id, agent_id, task_id, type, question, severity)
             VALUES (?, ?, ?, 'repeated_child_failures', ?, 'high')`,
          )
          .run(
            escalationId,
            delegation.parent_agent_id,
            delegation.task_id,
            `Delegation group ${groupId}: ${updated.failed_count}/${updated.expected_count} children failed. Parent instance: ${updated.parent_instance_id}`,
          );
        eventBus.emit("escalation:created", {
          escalationId,
          agentId: delegation.parent_agent_id,
          taskId: delegation.task_id,
          type: "repeated_child_failures",
          question: `${updated.failed_count}/${updated.expected_count} delegation children failed`,
        });
      } catch (err) {
        logError(this.db, "child_failure_escalation", { groupId, failedCount: updated.failed_count }, err);
      }
    }

    if (updated.settled_count >= updated.expected_count) {
      this.finishDelegationGroup(updated);
    } else {
      this.updateOrchestrationState(delegation.task_id, {
        step: "WAITING_DELEGATION",
        last_checkpoint_ts: new Date().toISOString(),
        session_id: this.agentManager.getSessionId(updated.parent_instance_id),
        active_delegation_group_id: groupId,
        active_delegation_child_count: updated.expected_count,
        active_delegation_settled_count: updated.settled_count,
        phase_guards: Array.from(this.getPhaseCompleteHandled()).filter((k) => k.startsWith(`${delegation.task_id}:`)),
        pending_regression: null,
        checkpoint_prompt_hash: null,
      });
    }
  }

  private finishDelegationGroup(group: DelegationGroupRow): void {
    // Consensus groups are handled by ConsensusManager, not normal delegation routing
    if (this.isConsensusGroupFn?.(group.id)) {
      return;
    }

    const delegations = this.db
      .prepare(
        `SELECT id, child_instance_id, child_agent_id, status, result, prompt
         FROM delegations
         WHERE delegation_group_id = ?
         ORDER BY created_at`,
      )
      .all(group.id) as Array<{ id: string; child_instance_id: string | null; child_agent_id: string; status: string; result: string | null; prompt: string }>;

    const lines = delegations.map((d, index) => {
      const worker = d.child_instance_id ? d.child_instance_id.slice(0, 8) : d.child_agent_id.slice(0, 8);
      const result = d.result?.trim() || "(no output)";
      return `${index + 1}. worker:${worker} status:${d.status}\n${result}`;
    }).join("\n\n");

    let routed = false;
    if (group.expected_count === 1 && delegations.length === 1) {
      const childId = delegations[0].child_instance_id ?? delegations[0].child_agent_id;
      const result = delegations[0].result?.trim() || "(no output)";
      const message = `[DELEGATION_RESULT from:${childId}]\n${result}\n[END_DELEGATION_RESULT]`;
      routed = this.routeResultToParent(group.parent_instance_id, childId, message, group.task_id);
    } else {
      const message = `[DELEGATION_BATCH_RESULT id:${group.id}]\n${lines}\n[END_DELEGATION_BATCH_RESULT]`;
      routed = this.routeResultToParent(group.parent_instance_id, group.id, message, group.task_id);
    }

    const parentTemplateId = this.agentManager.getTemplateAgentId(group.parent_instance_id) ?? group.parent_instance_id;
    this.setAgentState(parentTemplateId, "working");
    if (routed) {
      this.db
        .prepare("UPDATE agent_instances SET status = 'running', state_metadata = json_remove(state_metadata, '$.exit_code'), updated_at = datetime('now') WHERE id = ?")
        .run(group.parent_instance_id);
      eventBus.emit("instance:state_changed", {
        instanceId: group.parent_instance_id,
        templateAgentId: parentTemplateId,
        taskId: group.task_id,
        parentInstanceId: null,
        rootInstanceId: group.parent_instance_id,
        status: "running",
      });
    }

    this.updateOrchestrationState(group.task_id, {
      step: "AGENT_RUNNING",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: this.agentManager.getSessionId(group.parent_instance_id),
      active_delegation_group_id: null,
      active_delegation_child_count: 0,
      active_delegation_settled_count: 0,
      phase_guards: Array.from(this.getPhaseCompleteHandled()).filter((k) => k.startsWith(`${group.task_id}:`)),
      pending_regression: null,
      checkpoint_prompt_hash: null,
    });

    this.writeCheckpoint(group.task_id, "DELEGATION_COMPLETE", {
      delegation_group_id: group.id,
      settled_count: group.settled_count,
      failed_count: group.failed_count,
    });
  }

  routeResultToParent(
    parentRuntimeId: string,
    childRuntimeId: string,
    result: string,
    taskId?: string,
  ): boolean {
    const payload = this.normalizeDelegationPayload(result, childRuntimeId);
    // Enrich with notes the parent hasn't seen yet. The routing path bypasses
    // prompt-builder, so without this, any notes the child (or the operator
    // via Add Note) created during the child's run would be invisible to the
    // parent until the next fresh prompt-build. The helper is guarded because
    // some tests inject minimal mocks for promptBuilder.
    const enrichment = taskId && typeof this.promptBuilder.buildNotesEnrichmentBlock === "function"
      ? this.promptBuilder.buildNotesEnrichmentBlock(taskId, parentRuntimeId)
      : { text: "", noteIds: [] };
    const enrichedPayload = enrichment.text ? `${enrichment.text}\n${payload}` : payload;
    const markDelivered = (): void => {
      if (enrichment.noteIds.length > 0 && typeof this.promptBuilder.recordNoteDelivery === "function") {
        this.promptBuilder.recordNoteDelivery(parentRuntimeId, enrichment.noteIds);
      }
    };

    const runningParent = this.agentManager.getRunningAgent(parentRuntimeId);
    if (runningParent) {
      try {
        this.agentManager.sendInput(parentRuntimeId, enrichedPayload);
        markDelivered();
        return true;
      } catch (err) {
        logError(this.db, "route_result_stdin", { parentRuntimeId, childRuntimeId, method: "routeResultToParent" }, err);
      }
    }

    const parentTemplateId = typeof this.agentManager.getTemplateAgentId === "function"
      ? (this.agentManager.getTemplateAgentId(parentRuntimeId) ?? parentRuntimeId)
      : parentRuntimeId;
    const parentAgent = this.agentManager.getAgent(parentTemplateId);
    if (!parentAgent) {
      // Parent agent gone — clean up orphaned state
      this.cleanupOrphanedParent(parentRuntimeId, taskId, "Parent agent not found");
      return false;
    }

    const typeDef = getAgentTypeDefinition(parentAgent.type, this.db);
    if (typeDef?.supports_resume) {
      const closeStdin = !(typeDef.supports_stdin ?? false);
      this.agentManager.sendResumeMessage(parentRuntimeId, enrichedPayload, closeStdin)
        .then(() => {
          // Mark parent as running on successful resume
          try {
            markDelivered();
            this.db
              .prepare("UPDATE agent_instances SET status = 'running', state_metadata = json_remove(state_metadata, '$.exit_code'), updated_at = datetime('now') WHERE id = ?")
              .run(parentRuntimeId);
            eventBus.emit("instance:state_changed", {
              instanceId: parentRuntimeId,
              templateAgentId: parentTemplateId,
              status: "running",
            });
          } catch (cleanupErr) {
            logError(this.db, "route_result_parent_resume_success", { parentRuntimeId, childRuntimeId, method: "routeResultToParent" }, cleanupErr);
          }
        })
        .catch((err) => {
          logError(
            this.db,
            "route_result_resume_failed",
            {
              parentRuntimeId,
              childRuntimeId,
              method: "routeResultToParent",
              messageLength: payload.length,
            },
            err,
          );
          this.cleanupOrphanedParent(parentRuntimeId, taskId, `Failed to route delegation result to parent agent: ${String(err)}`);
        });
      return false; // async — caller must not assume synchronous success
    }

    // No running parent and no resume support — routing failed
    this.cleanupOrphanedParent(parentRuntimeId, taskId, "Parent not running and agent type does not support resume");
    return false;
  }

  private cleanupOrphanedParent(parentRuntimeId: string, taskId: string | undefined, reason: string): void {
    try {
      this.db
        .prepare("UPDATE agent_instances SET status = 'failed', state_metadata = json_set(state_metadata, '$.exit_code', -1), updated_at = datetime('now') WHERE id = ?")
        .run(parentRuntimeId);
      const failedTemplateId = this.agentManager.getTemplateAgentId(parentRuntimeId) ?? parentRuntimeId;
      eventBus.emit("instance:state_changed", {
        instanceId: parentRuntimeId,
        templateAgentId: failedTemplateId,
        status: "failed",
      });
    } catch (cleanupErr) {
      logError(this.db, "route_result_parent_cleanup", { parentRuntimeId, method: "routeResultToParent" }, cleanupErr);
    }
    if (taskId) {
      try {
        this.taskScheduler.failTask(taskId, reason);
      } catch (failErr) {
        logError(
          this.db,
          "route_result_resume_failed_task_fail",
          { parentRuntimeId, taskId, method: "routeResultToParent" },
          failErr,
        );
      }
    }
  }

  private tryRetryDelegation(delegation: Delegation): boolean | "pending" {
    const childInstanceId = delegation.child_instance_id;
    if (!childInstanceId) return false;

    const row = this.db
      .prepare("SELECT attempt, parent_instance_id, root_instance_id, task_id, template_agent_id, session_id FROM agent_instances WHERE id = ?")
      .get(childInstanceId) as {
        attempt: number;
        parent_instance_id: string | null;
        root_instance_id: string | null;
        task_id: string;
        template_agent_id: string;
        session_id: string | null;
      } | null;
    if (!row) return false;
    if (row.attempt >= CHILD_RETRY_LIMIT + 1) return false;

    // Kill the old child process before respawning. The stale-timeout caller
    // (checkStaleDelegations) retries delegations that are still 'running', so the
    // old process may be alive — without this it leaks as an untracked orphan
    // (replacement gets a new instance id, old row is marked failed). No-op when
    // the old process already exited (handleChildExit caller).
    this.agentManager.killAgent(childInstanceId);

    updateInstanceStatus(this.db, childInstanceId, "failed");

    const nextInstanceId = crypto.randomUUID();
    const nextAttempt = row.attempt + 1;

    this.db
      .prepare(
        "UPDATE delegations SET child_instance_id = ?, status = 'pending', result = NULL, completed_at = NULL WHERE id = ?",
      )
      .run(nextInstanceId, delegation.id);

    // Prefer resuming the child's existing session with a nudge over a fresh
    // restart: the timeout clock runs from instance creation, not last activity,
    // so a long-but-healthy child trips it — resuming preserves its work instead
    // of discarding it. Falls back to a fresh respawn (original prompt, no
    // session) when the type can't resume or no session was captured.
    const childAgent = this.agentManager.getAgent(row.template_agent_id);
    const childTypeDef = childAgent ? getAgentTypeDefinition(childAgent.type, this.db) : null;
    const canResume = !!row.session_id && !!childTypeDef?.supports_resume;
    const work = canResume ? RETRY_NUDGE_PROMPT : delegation.prompt;

    this.spawnChildInstance({
      taskId: row.task_id,
      delegationId: delegation.id,
      parentRuntimeId: row.parent_instance_id ?? delegation.parent_instance_id ?? delegation.parent_agent_id,
      rootInstanceId: row.root_instance_id ?? delegation.parent_instance_id ?? delegation.parent_agent_id,
      childTemplateId: row.template_agent_id,
      childInstanceId: nextInstanceId,
      work,
      attempt: nextAttempt,
      workingDir: undefined, // Agents spawn in orchestrator cwd
      resumeSessionId: canResume ? row.session_id! : undefined,
    }).catch((err) => {
      logError(this.db, "delegation_retry_spawn", { delegationId: delegation.id, nextInstanceId }, err);
      this.settleDelegationFailure(
        delegation.id,
        row.parent_instance_id ?? delegation.parent_instance_id ?? delegation.parent_agent_id,
        nextInstanceId,
        row.task_id,
        "Retry spawn failed",
      );
    });

    return "pending";
  }

  private settleDelegationFailure(
    delegationId: string,
    parentRuntimeId: string,
    childRuntimeId: string,
    taskId: string,
    reason: string,
  ): void {
    const delegation = this.getDelegation(delegationId);
    if (!delegation) return;

    this.db
      .prepare("UPDATE delegations SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?")
      .run(reason, delegationId);

    if (delegation.child_instance_id) {
      updateInstanceStatus(this.db, delegation.child_instance_id, "failed");
    }

    this.handleGroupProgress(delegation, childRuntimeId, true);

    const parentTemplateId = this.agentManager.getTemplateAgentId(parentRuntimeId) ?? parentRuntimeId;
    this.setAgentState(parentTemplateId, "working");

    if (!delegation.delegation_group_id) {
      this.routeResultToParent(
        parentRuntimeId,
        childRuntimeId,
        `[DELEGATION_FAILED] ${reason}`,
        taskId,
      );
    }
  }

  private getTaskForRuntime(runtimeId: string): { task_id: string | null } | null {
    const instance = this.db
      .prepare("SELECT task_id FROM agent_instances WHERE id = ?")
      .get(runtimeId) as { task_id: string | null } | null;
    if (instance?.task_id) return instance;

    const templateTask = this.db
      .prepare("SELECT current_task_id as task_id FROM agents WHERE id = ?")
      .get(runtimeId) as { task_id: string | null } | null;
    return templateTask ?? null;
  }

  private resolveRuntimeParentInstance(parentRuntimeId: string, parentTemplateId: string): string {
    if (this.agentManager.getRunningAgent(parentRuntimeId)) {
      return parentRuntimeId;
    }
    const runningInstances = this.agentManager.getRunningInstancesForTemplate(parentTemplateId);
    if (runningInstances.length > 0) {
      const first = runningInstances[0];
      if (first) return first;
    }
    return parentRuntimeId;
  }

  resolveDelegationTarget(target: string): NonNullable<ReturnType<AgentManager["getAgent"]>> | null {
    const normalized = target.trim();
    if (!normalized) return null;

    const byId = this.agentManager.getAgent(normalized);
    if (byId) return byId;

    const byNameRows = this.db
      .prepare(
        `SELECT id, name
         FROM agents
         WHERE lower(name) = lower(?)
         ORDER BY id
         LIMIT 5`,
      )
      .all(normalized) as { id: string; name: string }[];

    if (byNameRows.length === 0) {
      this.emitDelegationEvent("delegation:target_not_found", { target: normalized });
      return null;
    }

    if (byNameRows.length > 1) {
      const matchNames = byNameRows.map((r) => r.name).join(", ");
      this.emitDelegationEvent("delegation:ambiguous_target", {
        target: normalized,
        matches: byNameRows.map((r) => ({ id: r.id, name: r.name })),
        hint: `Ambiguous target "${normalized}" matched ${byNameRows.length} agents: ${matchNames}. Use the exact agent ID instead.`,
      });
      return null;
    }

    return this.agentManager.getAgent(byNameRows[0].id);
  }

  private getRootInstanceId(parentRuntimeId: string, taskId: string): string {
    const row = this.db
      .prepare("SELECT root_instance_id FROM agent_instances WHERE id = ?")
      .get(parentRuntimeId) as { root_instance_id: string | null } | null;
    if (row?.root_instance_id) return row.root_instance_id;

    this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_instances (
           id, task_id, template_agent_id, parent_instance_id, root_instance_id, status, process_pid, session_id, state_metadata, attempt
         ) VALUES (?, ?, ?, NULL, ?, 'running', NULL, ?, '{}', 1)`,
      )
      .run(parentRuntimeId, taskId, this.agentManager.getTemplateAgentId(parentRuntimeId) ?? parentRuntimeId, parentRuntimeId, this.agentManager.getSessionId(parentRuntimeId));
    return parentRuntimeId;
  }

  private getDelegationCountForParent(parentRuntimeId: string, taskId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM delegations WHERE parent_instance_id = ? AND task_id = ?",
      )
      .get(parentRuntimeId, taskId) as { count: number };
    return row.count;
  }

  private agentsInSameTeam(parentTemplateId: string, childTemplateId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM team_agents ta1
         JOIN team_agents ta2 ON ta1.team_id = ta2.team_id
         WHERE ta1.agent_id = ? AND ta2.agent_id = ?
         LIMIT 1`,
      )
      .get(parentTemplateId, childTemplateId);
    return !!row;
  }

  private isRealtimeDelegationTargetAllowed(taskId: string, childTemplateId: string): boolean {
    const row = this.db
      .prepare("SELECT task_config FROM tasks WHERE id = ?")
      .get(taskId) as { task_config: string | null } | null;
    if (!row) return false;

    try {
      const parsed = JSON.parse(row.task_config || "{}") as Record<string, unknown>;
      const assignedIds = Array.isArray(parsed.assigned_agent_ids)
        ? parsed.assigned_agent_ids.filter((id): id is string => typeof id === "string")
        : [];
      if (assignedIds.length === 0) return true;
      return assignedIds.includes(childTemplateId);
    } catch {
      return false;
    }
  }

  private isDelegationTargetAllowed(
    parentInstanceId: string,
    parentTemplateId: string,
    childTemplateId: string,
    taskId: string,
  ): boolean {
    if (parentTemplateId === childTemplateId) return false;
    // A non-entrypoint agent cannot delegate to the entrypoint agent
    const entrypointAgentId = getEntrypointAgentId(this.db, taskId);
    if (entrypointAgentId && parentTemplateId !== entrypointAgentId && childTemplateId === entrypointAgentId) return false;
    if (this.isAncestorTemplateInActiveChain(parentInstanceId, taskId, childTemplateId)) return false;
    return true;
  }

  private isAncestorTemplateInActiveChain(
    parentInstanceId: string,
    taskId: string,
    targetTemplateId: string,
  ): boolean {
    const row = this.db
      .prepare(
        `WITH RECURSIVE chain(instance_id) AS (
           SELECT ?
           UNION ALL
           SELECT d.parent_instance_id
           FROM delegations d
           JOIN chain c ON d.child_instance_id = c.instance_id
           WHERE d.task_id = ?
             AND d.status IN ('pending', 'running')
             AND d.parent_instance_id IS NOT NULL
         )
         SELECT 1
         FROM chain c
         JOIN agent_instances ai ON ai.id = c.instance_id
         WHERE ai.template_agent_id = ?
         LIMIT 1`,
      )
      .get(parentInstanceId, taskId, targetTemplateId);
    return !!row;
  }

  private gatherTerminalOutput(runtimeId: string): string {
    try {
      const rows = this.db
        .prepare(
          "SELECT data FROM terminal_outputs WHERE agent_id = ? AND stream = 'stdout' ORDER BY sequence",
        )
        .all(runtimeId) as { data: string }[];
      if (rows.length === 0) return "";

      let finalResult: string | null = null;
      const textChunks: string[] = [];
      const rawChunks: string[] = [];

      for (const row of rows) {
        const entry = row.data;
        rawChunks.push(entry);
        if (!entry.startsWith("{")) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(entry) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (parsed.type === "result" && typeof parsed.result === "string" && parsed.result.trim()) {
          finalResult = parsed.result;
          continue;
        }

        const extracted = this.extractTextFromTerminalJson(parsed);
        if (extracted) {
          textChunks.push(extracted);
        }
      }

      if (finalResult) return finalResult;
      if (textChunks.length > 0) return textChunks.join("\n\n");
      return rawChunks.join("\n");
    } catch (err) {
      logError(this.db, "gather_terminal_output", { runtimeId, method: "gatherTerminalOutput" }, err);
      return "";
    }
  }

  private extractTextFromTerminalJson(parsed: Record<string, unknown>): string | null {
    const message = parsed.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    if (message?.content && Array.isArray(message.content)) {
      const texts = message.content
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text!.trim())
        .filter((t) => t.length > 0);
      if (texts.length > 0) return texts.join("\n");
    }

    const item = parsed.item as { text?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
    if (item?.text && item.text.trim()) {
      return item.text.trim();
    }
    if (item?.content && Array.isArray(item.content)) {
      const texts = item.content
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text!.trim())
        .filter((t) => t.length > 0);
      if (texts.length > 0) return texts.join("\n");
    }

    return null;
  }

  private normalizeDelegationPayload(result: string, childRuntimeId: string): string {
    if (result.includes("[DELEGATION_RESULT")) {
      return this.truncateTaggedPayload(result, DELEGATION_RESULT_START, DELEGATION_RESULT_END);
    }
    if (result.includes("[DELEGATION_BATCH_RESULT")) {
      return this.truncateTaggedPayload(result, DELEGATION_BATCH_RESULT_START, DELEGATION_BATCH_RESULT_END);
    }
    const truncated = truncateResult(result);
    return `[DELEGATION_RESULT from:${childRuntimeId}]\n${truncated}\n[END_DELEGATION_RESULT]`;
  }

  private truncateTaggedPayload(payload: string, startPattern: RegExp, endMarker: string): string {
    const startMatch = payload.match(startPattern);
    const endIdx = payload.indexOf(endMarker);
    if (!startMatch || endIdx <= 0) {
      return truncateResult(payload);
    }
    const headerEnd = startMatch.index! + startMatch[0].length;
    if (headerEnd >= endIdx) {
      return truncateResult(payload);
    }
    const body = payload.slice(headerEnd, endIdx);
    if (body.length <= MAX_DELEGATION_RESULT_CHARS) {
      return payload;
    }
    const truncatedBody = truncateResult(body, MAX_DELEGATION_RESULT_CHARS);
    return payload.slice(0, headerEnd) + truncatedBody + payload.slice(endIdx);
  }

  /**
   * Soft validation of delegation role compatibility.
   * Logs a warning event if role mismatch but does not block.
   */
  validateDelegationRole(parentTemplateId: string, childTemplateId: string, taskId: string): void {
    try {
      const parentRole = this.db
        .prepare(
          "SELECT role FROM team_agents WHERE agent_id = ? LIMIT 1",
        )
        .get(parentTemplateId) as { role: string | null } | null;

      const childRole = this.db
        .prepare(
          "SELECT role FROM team_agents WHERE agent_id = ? LIMIT 1",
        )
        .get(childTemplateId) as { role: string | null } | null;

      if (parentRole?.role && childRole?.role && parentRole.role === childRole.role) {
        this.emitDelegationEvent("delegation:same_role_warning", {
          parentAgent: parentTemplateId,
          childAgent: childTemplateId,
          role: parentRole.role,
          taskId,
        });
      }
    } catch (err) {
      logError(this.db, "delegation_role_validation", { parentTemplateId, childTemplateId }, err);
    }
  }

  private emitRemediationEvent(type: string, agentId: string | null, taskId: string | null, details: Record<string, unknown>): void {
    try {
      this.db
        .prepare(
          "INSERT INTO events (type, payload, source_agent_id, task_id) VALUES (?, ?, ?, ?)",
        )
        .run(`remediation:${type}`, JSON.stringify(details), agentId, taskId);
    } catch (err) {
      logError(this.db, "remediation_event_emit", { type, agentId, taskId }, err);
    }
  }

  private emitDelegationEvent(type: string, details: Record<string, unknown>): void {
    try {
      this.db
        .prepare(
          "INSERT INTO events (type, payload) VALUES (?, ?)",
        )
        .run(type, JSON.stringify(details));
    } catch (err) {
      logError(this.db, "delegation_event_emit", { type }, err);
    }
  }

  private clearTemplateTaskIfNoActive(templateAgentId: string): void {
    const active = this.db
      .prepare(
        "SELECT 1 FROM delegations WHERE child_agent_id = ? AND status IN ('pending', 'running') LIMIT 1",
      )
      .get(templateAgentId);
    if (active) return;
    this.db
      .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
      .run(templateAgentId);
  }
}
