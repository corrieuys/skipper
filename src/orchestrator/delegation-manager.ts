import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { PromptBuilder, AgentInfo } from "../agents/prompt-builder";
import type { TaskScheduler } from "../tasks/scheduler";
import { getAgentTypeDefinition } from "../agents/types";
import { SKIPPER_AGENT_ID } from "../agents/skipper";
import { eventBus } from "../events/bus";
import { logError } from "../logging";

const MAX_DELEGATION_DEPTH = 3;
const MAX_DELEGATIONS_PER_PARENT = 20;
const MAX_BATCH_SIZE = 8;
const CHILD_RETRY_LIMIT = 1;
const DELEGATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DELEGATION_TIMEOUT_SECONDS = Math.floor(DELEGATION_TIMEOUT_MS / 1000);
const GROUP_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const GROUP_TIMEOUT_SECONDS = Math.floor(GROUP_TIMEOUT_MS / 1000);
const CHILD_FAILURE_ESCALATION_THRESHOLD = 2;

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
  constructor(
    private readonly db: Database,
    private readonly agentManager: AgentManager,
    private readonly promptBuilder: PromptBuilder,
    private readonly taskScheduler: TaskScheduler,
    private readonly setAgentState: (agentId: string, state: string, metadata?: Record<string, unknown>) => void,
    private readonly updateOrchestrationState: (taskId: string, state: import("./types").OrchestrationState) => void,
    private readonly writeCheckpoint: (taskId: string, type: string, snapshot?: Record<string, unknown>) => void,
    private readonly getPhaseCompleteHandled: () => Set<string>,
  ) {}

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

    if (normalized.length === 0 || normalized.length > MAX_BATCH_SIZE) return [];

    const parentTemplateId = this.agentManager.getTemplateAgentId(parentRuntimeId) ?? parentRuntimeId;
    const parentInstanceId = this.resolveRuntimeParentInstance(parentRuntimeId, parentTemplateId);
    const parentTask = this.getTaskForRuntime(parentInstanceId);
    if (!parentTask?.task_id) return [];

    const taskId = parentTask.task_id;
    const task = this.taskScheduler.getTask(taskId);
    if (!task || task.status !== "running") return [];

    const parentAgent = this.agentManager.getAgent(parentTemplateId);
    if (!parentAgent) return [];
    const parentTypeDef = getAgentTypeDefinition(parentAgent.type, this.db);
    if (!parentTypeDef || (!parentTypeDef.supports_stdin && !parentTypeDef.supports_resume)) {
      return [];
    }

    const depth = this.getDelegationDepth(parentInstanceId, taskId);
    if (depth >= MAX_DELEGATION_DEPTH) {
      this.emitDelegationEvent("delegation:max_depth_reached", {
        parentAgent: parentTemplateId,
        taskId,
        depth,
        maxDepth: MAX_DELEGATION_DEPTH,
      });
      this.routeResultToParent(
        parentInstanceId,
        parentInstanceId,
        `[DELEGATION_FAILED] Maximum delegation depth (${MAX_DELEGATION_DEPTH}) reached. Complete the work directly instead of delegating further.`,
        taskId,
      );
      return [];
    }

    const existingGroup = this.getActiveDelegationGroupForParent(parentInstanceId);
    if (existingGroup) return [];

    const totalDelegations = this.getDelegationCountForParent(parentInstanceId, taskId);
    if (totalDelegations + normalized.length > MAX_DELEGATIONS_PER_PARENT) {
      this.taskScheduler.failTask(
        taskId,
        `Agent "${parentAgent.name}" exceeded maximum delegations (${MAX_DELEGATIONS_PER_PARENT}) for this task`,
      );
      this.agentManager.killAgent(parentInstanceId);
      return [];
    }

    const eligibleItems: Array<{ item: DelegationBatchItem; childAgent: NonNullable<ReturnType<AgentManager["getAgent"]>> }> = [];
    for (const item of normalized) {
      const childAgent = this.resolveDelegationTarget(item.to);
      if (!childAgent) continue;
      if (!this.isDelegationTargetAllowed(parentInstanceId, parentTemplateId, childAgent.id, taskId)) continue;
      if (!this.agentsInSameTeam(parentTemplateId, childAgent.id)) continue;
      this.validateDelegationRole(parentTemplateId, childAgent.id, taskId);
      eligibleItems.push({ item, childAgent });
    }
    if (eligibleItems.length === 0) return [];

    const rootInstanceId = this.getRootInstanceId(parentInstanceId, taskId);
    const groupId = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO delegation_groups (id, task_id, parent_instance_id, policy, expected_count, settled_count, failed_count, status)
         VALUES (?, ?, ?, 'wait_all_mixed', ?, 0, 0, 'running')`,
      )
      .run(groupId, taskId, parentInstanceId, eligibleItems.length);

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
          parentTemplateId,
          childAgent.id,
          parentInstanceId,
          childInstanceId,
          groupId,
          taskId,
          item.work,
        );

      const spawned = await this.spawnChildInstance({
        taskId,
        delegationId,
        parentRuntimeId: parentInstanceId,
        rootInstanceId,
        childTemplateId: childAgent.id,
        childInstanceId,
        work: item.work,
        label: item.label,
        attempt: 1,
      });

      if (spawned) {
        started.push(this.getDelegation(delegationId)!);
      } else {
        this.settleDelegationFailure(delegationId, parentInstanceId, childInstanceId, taskId, "Failed to spawn delegated child instance");
      }
    }

    if (started.length === 0) {
      this.db
        .prepare("UPDATE delegation_groups SET status = 'completed', completed_at = datetime('now') WHERE id = ?")
        .run(groupId);
      return [];
    }

    this.setAgentState(parentTemplateId, "waiting_delegation", { delegation_group_id: groupId });
    this.db
      .prepare("UPDATE agent_instances SET status = 'waiting_delegation', updated_at = datetime('now') WHERE id = ?")
      .run(parentInstanceId);
    eventBus.emit("instance:state_changed", {
      instanceId: parentInstanceId,
      templateAgentId: parentTemplateId,
      taskId,
      parentInstanceId: null,
      rootInstanceId: rootInstanceId,
      status: "waiting_delegation",
    });

    this.updateOrchestrationState(taskId, {
      step: "WAITING_DELEGATION",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: this.agentManager.getSessionId(parentInstanceId),
      active_delegation_group_id: groupId,
      active_delegation_child_count: started.length,
      active_delegation_settled_count: 0,
      phase_guards: Array.from(this.getPhaseCompleteHandled()).filter((k) => k.startsWith(`${taskId}:`)),
      pending_regression: null,
      checkpoint_prompt_hash: null,
    });

    eventBus.emit("delegation_group:progress", {
      groupId,
      taskId,
      parentInstanceId: parentInstanceId,
      settledCount: 0,
      expectedCount: eligibleItems.length,
      failedCount: 0,
      status: "running",
    });

    return started;
  }

  async handleDelegationBatchSignal(parentRuntimeId: string, rawJson: string): Promise<Delegation[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const batch: DelegationBatchItem[] = parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => item as Record<string, unknown>)
      .map((item) => ({
        to: typeof item.to === "string" ? item.to : "",
        work: typeof item.work === "string" ? item.work : "",
        label: typeof item.label === "string" ? item.label : undefined,
      }));
    return this.handleDelegationBatch(parentRuntimeId, batch);
  }

  handleDelegateComplete(childRuntimeId: string, result: string): void {
    try {
      const delegation = this.getActiveDelegationForChild(childRuntimeId);
      if (!delegation) return;

      this.db
        .prepare(
          "UPDATE delegations SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?",
        )
        .run(result, delegation.id);

      this.agentManager.killAgent(childRuntimeId);

      this.db
        .prepare("UPDATE agent_instances SET status = 'completed', updated_at = datetime('now') WHERE id = ?")
        .run(childRuntimeId);
      this.clearTemplateTaskIfNoActive(delegation.child_agent_id);

      this.handleGroupProgress(delegation, childRuntimeId, false);
    } catch (err) {
      logError(this.db, "delegation_complete", { childRuntimeId, method: "handleDelegateComplete" }, err);
    }
  }

  handleChildExit(delegation: Delegation, event: { agentId: string; code: number | null }): void {
    try {
      if (event.code === 0) {
        const result = this.gatherTerminalOutput(event.agentId);
        this.db
          .prepare(
            "UPDATE delegations SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?",
          )
          .run(result, delegation.id);
        this.db
          .prepare("UPDATE agent_instances SET status = 'completed', updated_at = datetime('now') WHERE id = ?")
          .run(event.agentId);
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
        this.db
          .prepare("UPDATE agent_instances SET status = 'failed', updated_at = datetime('now') WHERE id = ?")
          .run(event.agentId);
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
        "SELECT * FROM delegations WHERE status = 'running' AND unixepoch(created_at) < (unixepoch('now') - ?)",
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
          this.db
            .prepare("UPDATE agent_instances SET status = 'failed', updated_at = datetime('now') WHERE id = ?")
            .run(delegation.child_instance_id);
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
            this.db
              .prepare("UPDATE agent_instances SET status = 'failed', updated_at = datetime('now') WHERE id = ?")
              .run(del.child_instance_id);
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
  }): Promise<boolean> {
    const childAgent = this.agentManager.getAgent(input.childTemplateId);
    if (!childAgent) return false;

    try {
      await this.agentManager.spawnAgentInstance(input.childTemplateId, input.childInstanceId, {
        workingDir: process.cwd(),
        taskId: input.taskId,
        parentInstanceId: input.parentRuntimeId,
        rootInstanceId: input.rootInstanceId,
        attempt: input.attempt,
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

    const childTypeDef = getAgentTypeDefinition(childAgent.type, this.db);
    const isStreaming = childTypeDef?.supports_stdin ?? false;

    const childInfo: AgentInfo = {
      id: childAgent.id,
      name: childAgent.name,
      type: childAgent.type,
      instruction: childAgent.config.instruction,
    };

    const prompt = this.promptBuilder.buildDelegationPrompt({
      childAgent: childInfo,
      task: {
        id: input.taskId,
        title: this.taskScheduler.getTask(input.taskId)?.title ?? "Delegated Task",
        description: this.taskScheduler.getTask(input.taskId)?.description ?? undefined,
      },
      delegationPrompt: input.work,
    });

    const closeStdin = !isStreaming;
    try {
      this.agentManager.sendInput(input.childInstanceId, prompt, closeStdin);
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
      const payload = failed
        ? `[DELEGATION_FAILED] ${delegation.result ?? "Delegation failed"}`
        : delegation.result ?? "";
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
        this.db
          .prepare(
            `INSERT INTO escalations (id, agent_id, task_id, type, question, severity)
             VALUES (?, ?, ?, 'repeated_child_failures', ?, 'high')`,
          )
          .run(
            crypto.randomUUID(),
            delegation.parent_agent_id,
            delegation.task_id,
            `Delegation group ${groupId}: ${updated.failed_count}/${updated.expected_count} children failed. Parent instance: ${updated.parent_instance_id}`,
          );
        eventBus.emit("escalation:created", {
          escalationId: "",
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

    if (group.expected_count === 1 && delegations.length === 1) {
      const childId = delegations[0].child_instance_id ?? delegations[0].child_agent_id;
      const result = delegations[0].result?.trim() || "(no output)";
      const message = `[DELEGATION_RESULT from:${childId}]\n${result}\n[END_DELEGATION_RESULT]`;
      this.routeResultToParent(group.parent_instance_id, childId, message, group.task_id);
    } else {
      const message = `[DELEGATION_BATCH_RESULT id:${group.id}]\n${lines}\n[END_DELEGATION_BATCH_RESULT]`;
      this.routeResultToParent(group.parent_instance_id, group.id, message, group.task_id);
    }

    const parentTemplateId = this.agentManager.getTemplateAgentId(group.parent_instance_id) ?? group.parent_instance_id;
    this.setAgentState(parentTemplateId, "working");
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
  ): void {
    const payload = result.includes("[DELEGATION_")
      ? result
      : `[DELEGATION_RESULT from:${childRuntimeId}]\n${result}\n[END_DELEGATION_RESULT]`;
    const runningParent = this.agentManager.getRunningAgent(parentRuntimeId);
    if (runningParent) {
      try {
        this.agentManager.sendInput(parentRuntimeId, payload);
        return;
      } catch (err) {
        logError(this.db, "route_result_stdin", { parentRuntimeId, childRuntimeId, method: "routeResultToParent" }, err);
      }
    }

    const parentTemplateId = this.agentManager.getTemplateAgentId(parentRuntimeId) ?? parentRuntimeId;
    const parentAgent = this.agentManager.getAgent(parentTemplateId);
    if (!parentAgent) return;

    const typeDef = getAgentTypeDefinition(parentAgent.type, this.db);
    if (typeDef?.supports_resume) {
      const closeStdin = !(typeDef.supports_stdin ?? false);
      this.agentManager.sendResumeMessage(parentRuntimeId, payload, closeStdin).catch((err) => {
        logError(
          this.db,
          "route_result_resume_failed",
          {
            parentRuntimeId,
            childRuntimeId,
            method: "routeResultToParent",
            messageLength: result.length,
          },
          err,
        );
        if (taskId) {
          try {
            this.taskScheduler.failTask(taskId, `Failed to route delegation result to parent agent: ${String(err)}`);
          } catch (failErr) {
            logError(
              this.db,
              "route_result_resume_failed_task_fail",
              { parentRuntimeId, childRuntimeId, taskId, method: "routeResultToParent" },
              failErr,
            );
          }
        }
      });
    }
  }

  private tryRetryDelegation(delegation: Delegation): boolean | "pending" {
    const childInstanceId = delegation.child_instance_id;
    if (!childInstanceId) return false;

    const row = this.db
      .prepare("SELECT attempt, parent_instance_id, root_instance_id, task_id, template_agent_id FROM agent_instances WHERE id = ?")
      .get(childInstanceId) as {
        attempt: number;
        parent_instance_id: string | null;
        root_instance_id: string | null;
        task_id: string;
        template_agent_id: string;
      } | null;
    if (!row) return false;
    if (row.attempt >= CHILD_RETRY_LIMIT + 1) return false;

    this.db
      .prepare("UPDATE agent_instances SET status = 'failed', updated_at = datetime('now') WHERE id = ?")
      .run(childInstanceId);

    const nextInstanceId = crypto.randomUUID();
    const nextAttempt = row.attempt + 1;

    this.db
      .prepare(
        "UPDATE delegations SET child_instance_id = ?, status = 'pending', result = NULL, completed_at = NULL WHERE id = ?",
      )
      .run(nextInstanceId, delegation.id);

    this.spawnChildInstance({
      taskId: row.task_id,
      delegationId: delegation.id,
      parentRuntimeId: row.parent_instance_id ?? delegation.parent_instance_id ?? delegation.parent_agent_id,
      rootInstanceId: row.root_instance_id ?? delegation.parent_instance_id ?? delegation.parent_agent_id,
      childTemplateId: row.template_agent_id,
      childInstanceId: nextInstanceId,
      work: delegation.prompt,
      attempt: nextAttempt,
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
      this.db
        .prepare("UPDATE agent_instances SET status = 'failed', updated_at = datetime('now') WHERE id = ?")
        .run(delegation.child_instance_id);
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

  private isDelegationTargetAllowed(
    parentInstanceId: string,
    parentTemplateId: string,
    childTemplateId: string,
    taskId: string,
  ): boolean {
    if (parentTemplateId === childTemplateId) return false;
    if (parentTemplateId !== SKIPPER_AGENT_ID && childTemplateId === SKIPPER_AGENT_ID) return false;
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
      return rows.map((r) => r.data).join("");
    } catch (err) {
      logError(this.db, "gather_terminal_output", { runtimeId, method: "gatherTerminalOutput" }, err);
      return "";
    }
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
