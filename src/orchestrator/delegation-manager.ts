import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { PromptBuilder, AgentInfo } from "../agents/prompt-builder";
import type { TaskScheduler } from "../tasks/scheduler";
import { getAgentTypeDefinition } from "../agents/types";
import { eventBus } from "../events/bus";
import { logError } from "../logging";

const MAX_DELEGATION_DEPTH = 3;
const MAX_DELEGATIONS_PER_PARENT = 3;
const DELEGATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface Delegation {
  id: string;
  parent_agent_id: string;
  child_agent_id: string;
  task_id: string;
  prompt: string;
  result: string | null;
  status: "pending" | "running" | "completed" | "failed";
  created_at: string;
  completed_at: string | null;
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
    parentAgentId: string,
    childAgentId: string,
    delegationPrompt: string,
  ): Promise<Delegation | null> {
    const parentRow = this.db
      .prepare("SELECT current_task_id FROM agents WHERE id = ?")
      .get(parentAgentId) as { current_task_id: string | null } | null;

    if (!parentRow?.current_task_id) return null;

    const taskId = parentRow.current_task_id;
    const task = this.taskScheduler.getTask(taskId);
    if (!task || task.status !== "running") return null;

    const parentAgent = this.agentManager.getAgent(parentAgentId);
    if (!parentAgent) return null;
    const parentTypeDef = getAgentTypeDefinition(parentAgent.type, this.db);
    if (!parentTypeDef || (!parentTypeDef.supports_stdin && !parentTypeDef.supports_resume)) {
      return null;
    }

    // Guard: no self-delegation
    if (parentAgentId === childAgentId) return null;

    const childAgent = this.agentManager.getAgent(childAgentId);
    if (!childAgent) return null;

    if (!this.agentsInSameTeam(parentAgentId, childAgentId)) return null;

    const depth = this.getDelegationDepth(parentAgentId, taskId);
    if (depth >= MAX_DELEGATION_DEPTH) return null;

    const existingDelegation = this.getActiveDelegationForParent(parentAgentId);
    if (existingDelegation) return null;

    // Guard: limit total delegations per parent per task to prevent infinite loops
    const totalDelegations = this.getDelegationCountForParent(parentAgentId, taskId);
    if (totalDelegations >= MAX_DELEGATIONS_PER_PARENT) {
      this.taskScheduler.failTask(
        taskId,
        `Agent "${parentAgent.name}" exceeded maximum delegations (${MAX_DELEGATIONS_PER_PARENT}) for this task`,
      );
      this.agentManager.killAgent(parentAgentId);
      return null;
    }

    const delegationId = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO delegations (id, parent_agent_id, child_agent_id, task_id, prompt, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
      )
      .run(delegationId, parentAgentId, childAgentId, taskId, delegationPrompt);

    if (this.agentManager.getRunningAgent(childAgentId)) {
      this.agentManager.killAgent(childAgentId);
      await this.agentManager.waitForExit(childAgentId);
    }

    try {
      const workingDir = process.cwd();
      await this.agentManager.spawnAgent(childAgentId, { workingDir });
    } catch (err) {
      logError(this.db, "delegation_spawn", { delegationId, parentAgentId, childAgentId, method: "handleDelegation" }, err);
      this.db
        .prepare("UPDATE delegations SET status = 'failed', completed_at = datetime('now') WHERE id = ?")
        .run(delegationId);
      return null;
    }

    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(taskId, childAgentId);

    const childTypeDef = getAgentTypeDefinition(childAgent.type, this.db);
    const isStreaming = childTypeDef?.supports_stdin ?? false;

    const childInfo: AgentInfo = {
      id: childAgent.id,
      name: childAgent.name,
      type: childAgent.type,
      goal: childAgent.config.goal,
    };

    const prompt = this.promptBuilder.buildDelegationPrompt({
      childAgent: childInfo,
      task: { id: task.id, title: task.title, description: task.description ?? undefined },
      delegationPrompt,
    });

    const closeStdin = !isStreaming;
    this.agentManager.sendInput(childAgentId, prompt, closeStdin);

    this.db
      .prepare("UPDATE delegations SET status = 'running' WHERE id = ?")
      .run(delegationId);

    try {
      this.agentManager.sendInput(
        parentAgentId,
        `[SYSTEM] Delegated to agent ${childAgentId}. Waiting for results...`,
      );
    } catch (err) {
      logError(this.db, "delegation_notify_parent", { parentAgentId, childAgentId, method: "handleDelegation" }, err);
    }

    this.setAgentState(parentAgentId, "waiting_delegation", { delegation_id: delegationId });

    this.updateOrchestrationState(taskId, {
      step: "WAITING_DELEGATION",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: this.agentManager.getSessionId(parentAgentId),
      active_delegation_id: delegationId,
      phase_guards: Array.from(this.getPhaseCompleteHandled()).filter((k) => k.startsWith(`${taskId}:`)),
      pending_regression: null,
      checkpoint_prompt_hash: null,
    });

    return this.getDelegation(delegationId);
  }

  handleDelegateComplete(childAgentId: string, result: string): void {
    try {
      const delegation = this.getActiveDelegationForChild(childAgentId);
      if (!delegation) return;

      this.db
        .prepare(
          "UPDATE delegations SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?",
        )
        .run(result, delegation.id);

      this.agentManager.killAgent(childAgentId);

      this.db
        .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
        .run(childAgentId);

      this.routeResultToParent(delegation.parent_agent_id, childAgentId, result);

      this.setAgentState(delegation.parent_agent_id, "working");

      this.updateOrchestrationState(delegation.task_id, {
        step: "AGENT_RUNNING",
        last_checkpoint_ts: new Date().toISOString(),
        session_id: this.agentManager.getSessionId(delegation.parent_agent_id),
        active_delegation_id: null,
        phase_guards: Array.from(this.getPhaseCompleteHandled()).filter((k) => k.startsWith(`${delegation.task_id}:`)),
        pending_regression: null,
        checkpoint_prompt_hash: null,
      });
      this.writeCheckpoint(delegation.task_id, "DELEGATION_COMPLETE", {
        delegation_id: delegation.id,
        child_agent_id: childAgentId,
      });
    } catch (err) {
      logError(this.db, "delegation_complete", { childAgentId, method: "handleDelegateComplete" }, err);
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
          .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
          .run(event.agentId);

        this.routeResultToParent(delegation.parent_agent_id, event.agentId, result);

        this.setAgentState(delegation.parent_agent_id, "working");
      } else {
        this.db
          .prepare(
            "UPDATE delegations SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?",
          )
          .run(`Child agent exited with code ${event.code}`, delegation.id);

        this.db
          .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
          .run(event.agentId);

        this.routeResultToParent(
          delegation.parent_agent_id,
          event.agentId,
          `[DELEGATION_FAILED] Agent exited with code ${event.code}`,
        );

        this.setAgentState(delegation.parent_agent_id, "working");
      }
    } catch (err) {
      logError(this.db, "child_exit_handler", { delegationId: delegation.id, childAgentId: event.agentId, exitCode: event.code, method: "handleChildExit" }, err);
    }
  }

  checkStaleDelegations(): number {
    const cutoff = new Date(Date.now() - DELEGATION_TIMEOUT_MS).toISOString();
    const stale = this.db
      .prepare(
        "SELECT * FROM delegations WHERE status = 'running' AND created_at < ?",
      )
      .all(cutoff) as Delegation[];

    for (const delegation of stale) {
      try {
        this.db
          .prepare(
            "UPDATE delegations SET status = 'failed', result = 'Delegation timed out', completed_at = datetime('now') WHERE id = ?",
          )
          .run(delegation.id);

        this.agentManager.killAgent(delegation.child_agent_id);

        this.db
          .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
          .run(delegation.child_agent_id);

        this.routeResultToParent(
          delegation.parent_agent_id,
          delegation.child_agent_id,
          `[DELEGATION_FAILED] Delegation timed out after 10 minutes`,
        );

        this.setAgentState(delegation.parent_agent_id, "working");
      } catch (err) {
        logError(this.db, "stale_delegation_cleanup", { delegationId: delegation.id, parentAgentId: delegation.parent_agent_id, childAgentId: delegation.child_agent_id }, err);
      }
    }

    return stale.length;
  }

  routeResultToParent(
    parentAgentId: string,
    childAgentId: string,
    result: string,
  ): void {
    const message = `[DELEGATION_RESULT from:${childAgentId}]\n${result}\n[END_DELEGATION_RESULT]`;

    const runningParent = this.agentManager.getRunningAgent(parentAgentId);
    if (runningParent) {
      try {
        this.agentManager.sendInput(parentAgentId, message);
        return;
      } catch (err) {
        logError(this.db, "route_result_stdin", { parentAgentId, childAgentId, method: "routeResultToParent" }, err);
      }
    }

    const parentAgent = this.agentManager.getAgent(parentAgentId);
    if (!parentAgent) return;

    const typeDef = getAgentTypeDefinition(parentAgent.type, this.db);
    if (typeDef?.supports_resume) {
      this.agentManager.sendResumeMessage(parentAgentId, message).catch(() => {
        // Resume failed — result lost
      });
    }
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

  getActiveDelegationForParent(parentAgentId: string): Delegation | null {
    try {
      const row = this.db
        .prepare(
          "SELECT * FROM delegations WHERE parent_agent_id = ? AND status IN ('pending', 'running') LIMIT 1",
        )
        .get(parentAgentId) as Delegation | null;
      return row ?? null;
    } catch (err) {
      logError(this.db, "get_active_delegation_parent", { parentAgentId, method: "getActiveDelegationForParent" }, err);
      return null;
    }
  }

  getActiveDelegationForChild(childAgentId: string): Delegation | null {
    try {
      const row = this.db
        .prepare(
          "SELECT * FROM delegations WHERE child_agent_id = ? AND status IN ('pending', 'running') LIMIT 1",
        )
        .get(childAgentId) as Delegation | null;
      return row ?? null;
    } catch (err) {
      logError(this.db, "get_active_delegation_child", { childAgentId, method: "getActiveDelegationForChild" }, err);
      return null;
    }
  }

  getDelegationDepth(agentId: string, taskId: string): number {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE chain(agent_id, depth) AS (
           SELECT parent_agent_id, 1
           FROM delegations
           WHERE child_agent_id = ? AND task_id = ? AND status IN ('pending', 'running')
           UNION ALL
           SELECT d.parent_agent_id, c.depth + 1
           FROM chain c
           JOIN delegations d ON d.child_agent_id = c.agent_id AND d.task_id = ? AND d.status IN ('pending', 'running')
         )
         SELECT MAX(depth) as max_depth FROM chain`,
      )
      .get(agentId, taskId, taskId) as { max_depth: number | null } | null;
    return rows?.max_depth ?? 0;
  }

  // Counts ALL delegations (any status) to prevent infinite loops where
  // a parent is resumed and re-delegates repeatedly. Active-only counting
  // would not work because each delegation completes before the parent resumes.
  private getDelegationCountForParent(parentAgentId: string, taskId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM delegations WHERE parent_agent_id = ? AND task_id = ?",
      )
      .get(parentAgentId, taskId) as { count: number };
    return row.count;
  }

  private agentsInSameTeam(agentA: string, agentB: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM team_agents ta1
         JOIN team_agents ta2 ON ta1.team_id = ta2.team_id
         WHERE ta1.agent_id = ? AND ta2.agent_id = ?
         LIMIT 1`,
      )
      .get(agentA, agentB);
    return !!row;
  }

  private gatherTerminalOutput(agentId: string): string {
    try {
      const rows = this.db
        .prepare(
          "SELECT data FROM terminal_outputs WHERE agent_id = ? AND stream = 'stdout' ORDER BY sequence",
        )
        .all(agentId) as { data: string }[];
      return rows.map((r) => r.data).join("");
    } catch (err) {
      logError(this.db, "gather_terminal_output", { agentId, method: "gatherTerminalOutput" }, err);
      return "";
    }
  }
}
