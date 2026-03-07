import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { PromptBuilder, AgentInfo, PhaseInfo } from "../agents/prompt-builder";
import type { TaskScheduler } from "../tasks/scheduler";
import type { TeamManager } from "../teams/manager";
import { getAgentTypeDefinition } from "../agents/types";
import { TaskStateMachine } from "./state";
import { logError } from "../logging";
import type { OrchestrationState, TaskCheckpoint, PendingRegression } from "./types";

const RECOVERY_ATTEMPT_KEY_PREFIX = "recovery_attempt:";

export class RecoveryManager {
  constructor(
    private readonly db: Database,
    private readonly agentManager: AgentManager,
    private readonly promptBuilder: PromptBuilder,
    private readonly taskScheduler: TaskScheduler,
    private readonly teamManager: TeamManager,
    private readonly getPhaseCompleteHandled: () => Set<string>,
    private readonly getPendingRegressions: () => Map<string, PendingRegression>,
    private readonly setAgentState: (agentId: string, state: string, metadata?: Record<string, unknown>) => void,
    private readonly getDelegation: (id: string) => { id: string; status: string } | null,
  ) {}

  /**
   * Clean up stale agent process state on startup.
   * Also checks agent_instances with non-null PIDs.
   */
  cleanupStaleState(): void {
    try {
      const agentsWithPids = this.db
        .prepare("SELECT id, process_pid FROM agents WHERE process_pid IS NOT NULL")
        .all() as { id: string; process_pid: number }[];

      for (const row of agentsWithPids) {
        const inMemory = this.agentManager.getRunningAgent(row.id);
        if (!inMemory) {
          try {
            process.kill(row.process_pid, 0);
            process.kill(row.process_pid, 9);
          } catch (err) {
            logError(this.db, "cleanup_kill_orphan", { agentId: row.id, pid: row.process_pid, method: "cleanupStaleState" }, err);
          }

          this.db
            .prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = ?")
            .run(row.id);

          this.emitRemediationEvent("startup_agent_cleanup", row.id, null, { pid: row.process_pid });
        }
      }

      for (const [agentId, running] of this.agentManager.getRunningAgents()) {
        try {
          process.kill(running.process.pid, 0);
        } catch (err) {
          logError(this.db, "cleanup_dead_agent", { agentId, method: "cleanupStaleState" }, err);
          this.agentManager.getRunningAgents().delete(agentId);
          this.db
            .prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = ?")
            .run(agentId);
        }
      }

      // Startup reconciliation: check agent_instances with PIDs not tracked in memory
      const instancesWithPids = this.db
        .prepare(
          "SELECT id, template_agent_id, process_pid, task_id FROM agent_instances WHERE process_pid IS NOT NULL AND status IN ('running', 'waiting_delegation')",
        )
        .all() as Array<{ id: string; template_agent_id: string; process_pid: number; task_id: string }>;

      for (const inst of instancesWithPids) {
        const tracked = this.agentManager.getRunningAgent(inst.id);
        if (!tracked) {
          try {
            process.kill(inst.process_pid, 0);
            process.kill(inst.process_pid, 9);
          } catch { /* already dead */ }

          this.db
            .prepare("UPDATE agent_instances SET status = 'failed', process_pid = NULL, updated_at = datetime('now') WHERE id = ?")
            .run(inst.id);

          this.emitRemediationEvent("startup_instance_cleanup", inst.template_agent_id, inst.task_id, {
            instanceId: inst.id,
            pid: inst.process_pid,
          });
        }
      }
    } catch (err) {
      logError(this.db, "cleanup_stale_state", { method: "cleanupStaleState" }, err);
    }
  }

  async recoverAllStaleTasks(): Promise<number> {
    let recovered = 0;

    try {
      const runningTasks = this.db
        .prepare("SELECT * FROM tasks WHERE status = 'running'")
        .all() as Array<Record<string, unknown>>;

      for (const row of runningTasks) {
        const taskId = row.id as string;
        const task = this.taskScheduler.getTask(taskId);
        if (!task) continue;

        const assignedAgent = this.db
          .prepare("SELECT id, process_pid FROM agents WHERE current_task_id = ?")
          .get(taskId) as { id: string; process_pid: number | null } | null;

        if (!assignedAgent) {
          const didRecover = await this.recoverTask(taskId);
          if (didRecover) recovered++;
          continue;
        }

        const inMemory = this.agentManager.getRunningAgent(assignedAgent.id);
        if (inMemory) continue;

        if (assignedAgent.process_pid) {
          try {
            process.kill(assignedAgent.process_pid, 0);
            continue;
          } catch (err) {
            logError(this.db, "recovery_liveness_check", { agentId: assignedAgent.id, pid: assignedAgent.process_pid, method: "recoverAllStaleTasks" }, err);
          }
        }

        const activeDelegation = this.getActiveDelegationForParent(assignedAgent.id);
        if (activeDelegation) {
          const childRuntimeId = activeDelegation.child_instance_id ?? activeDelegation.child_agent_id;
          const childRunning = this.agentManager.getRunningAgent(childRuntimeId);
          if (childRunning) continue;
        }

        const didRecover = await this.recoverTask(taskId);
        if (didRecover) {
          this.emitRemediationEvent("task_recovered", assignedAgent.id, taskId, { method: "recoverAllStaleTasks" });
          recovered++;
        }
      }
    } catch (err) {
      logError(this.db, "recovery_error", { method: "recoverAllStaleTasks" }, err);
    }

    return recovered;
  }

  async recoverTask(taskId: string): Promise<boolean> {
    const task = this.taskScheduler.getTask(taskId);
    if (!task || task.status !== "running") return false;
    if (!task.team_id) return false;

    // One-shot recovery policy: check if we've already tried to recover this task
    const recoveryKey = `${RECOVERY_ATTEMPT_KEY_PREFIX}${taskId}`;
    const existingAttempt = this.db
      .prepare("SELECT value FROM daemon_state WHERE key = ?")
      .get(recoveryKey) as { value: string } | null;

    if (existingAttempt) {
      // Already recovered once — fail the task
      try {
        this.taskScheduler.failTask(taskId, "Recovery failed: task already recovered once and agent died again");
      } catch (err) {
        logError(this.db, "one_shot_recovery_fail", { taskId, method: "recoverTask" }, err);
      }
      this.emitRemediationEvent("one_shot_recovery_exhausted", null, taskId, { previousAttempt: existingAttempt.value });
      // Clean up the recovery key
      this.db.prepare("DELETE FROM daemon_state WHERE key = ?").run(recoveryKey);
      return false;
    }

    // Record recovery attempt
    this.db
      .prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)")
      .run(recoveryKey, new Date().toISOString());

    const teamExec = this.teamManager.getTeamForExecution(task.team_id);
    if (!teamExec) return false;

    const entrypointAgentId = teamExec.entrypoint_agent_id;
    const agent = this.agentManager.getAgent(entrypointAgentId);
    if (!agent) return false;

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    if (!typeDef) return false;

    const orchState = (task.orchestration_state ?? {}) as Partial<OrchestrationState>;
    if (!orchState || typeof orchState !== "object") return false;

    const checkpoint = this.getLatestCheckpoint(taskId);

    if (orchState.phase_guards) {
      for (const guard of orchState.phase_guards) {
        this.getPhaseCompleteHandled().add(guard);
      }
    }
    if (orchState.pending_regression) {
      this.getPendingRegressions().set(entrypointAgentId, orchState.pending_regression);
    }

    const activeGroupId = orchState.active_delegation_group_id;
    if (activeGroupId) {
      const group = this.db
        .prepare("SELECT status FROM delegation_groups WHERE id = ?")
        .get(activeGroupId) as { status: string } | null;
      if (group && group.status === "running") {
        this.setAgentState(entrypointAgentId, "waiting_delegation", {
          delegation_id: activeGroupId,
        });
        return true;
      }
    }

    const sessionId =
      orchState.session_id ??
      (checkpoint?.session_id || null) ??
      this.agentManager.getSessionId(entrypointAgentId);

    const canResume = typeDef.supports_resume && !!sessionId;

    if (this.agentManager.getRunningAgent(entrypointAgentId)) {
      this.agentManager.killAgent(entrypointAgentId);
      await this.agentManager.waitForExit(entrypointAgentId);
    }

    try {
      const workingDir = process.cwd();
      const spawnOpts = canResume
        ? { workingDir, sessionId: sessionId! }
        : { workingDir };
      await this.agentManager.spawnAgent(entrypointAgentId, spawnOpts);
    } catch (err) {
      logError(this.db, "recovery_spawn", { taskId, agentId: entrypointAgentId, method: "recoverTask" }, err);
      return false;
    }

    if (!this.agentManager.getRunningAgent(entrypointAgentId)) {
      logError(this.db, "recovery_spawn_unconfirmed", { taskId, agentId: entrypointAgentId, method: "recoverTask" }, new Error("Spawn did not result in a running agent"));
      return false;
    }

    this.db
      .prepare("UPDATE agents SET current_task_id = NULL WHERE current_task_id = ? AND id != ?")
      .run(taskId, entrypointAgentId);

    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(taskId, entrypointAgentId);

    const isStreaming = typeDef.supports_stdin ?? false;
    const phases = (teamExec.team.phases as { name: string; prompt: string }[]) ?? [];
    const currentPhase = task.current_phase;

    const agentInfo: AgentInfo = {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      instruction: agent.config.instruction,
    };

    let phaseInfo: PhaseInfo | undefined;
    if (phases.length > 0 && currentPhase < phases.length) {
      phaseInfo = {
        name: phases[currentPhase].name,
        prompt: phases[currentPhase].prompt,
        index: currentPhase,
        total: phases.length,
      };
    }

    const pendingReg = this.getPendingRegressions().get(entrypointAgentId);

    const prompt = this.promptBuilder.buildInitialPrompt({
      agent: agentInfo,
      task: { id: taskId, title: task.title, description: task.description ?? undefined },
      phase: phaseInfo,
      isStreaming,
      regressionReason: pendingReg?.reason,
    });

    const recoveryPrefix = canResume
      ? "[SYSTEM] Session recovered. Continuing from last checkpoint.\n\n"
      : "[SYSTEM] Task recovered after agent restart. Resuming from current phase.\n\n";

    const closeStdin = !isStreaming;
    try {
      this.agentManager.sendInput(entrypointAgentId, recoveryPrefix + prompt, closeStdin);
    } catch (err) {
      logError(this.db, "recovery_send_input", { taskId, agentId: entrypointAgentId, method: "recoverTask" }, err);
      return false;
    }

    this.emitRemediationEvent("task_recovery_spawned", entrypointAgentId, taskId, {
      canResume,
      sessionId: canResume ? sessionId : null,
    });

    this.updateOrchestrationState(taskId, {
      step: "AGENT_RUNNING",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: canResume ? sessionId : null,
      active_delegation_group_id: null,
      active_delegation_child_count: 0,
      active_delegation_settled_count: 0,
      phase_guards: Array.from(this.getPhaseCompleteHandled()).filter((k) => k.startsWith(`${taskId}:`)),
      pending_regression: pendingReg ?? null,
      checkpoint_prompt_hash: null,
    });

    return true;
  }

  /**
   * Clean up all runtime state when a task reaches a terminal state.
   * Clears agent assignments, fails active instances, kills live processes.
   */
  cleanupTerminalTaskState(taskId: string): void {
    try {
      // Clear agent assignments for this task
      this.db
        .prepare("UPDATE agents SET current_task_id = NULL, process_pid = NULL WHERE current_task_id = ?")
        .run(taskId);

      // Fail any non-terminal instances
      const activeInstances = this.db
        .prepare(
          "SELECT id, process_pid FROM agent_instances WHERE task_id = ? AND status IN ('running', 'waiting_delegation', 'pending')",
        )
        .all(taskId) as Array<{ id: string; process_pid: number | null }>;

      for (const inst of activeInstances) {
        if (inst.process_pid) {
          try {
            process.kill(inst.process_pid, 9);
          } catch { /* already dead */ }
        }
        this.agentManager.killAgent(inst.id);
      }

      this.db
        .prepare(
          "UPDATE agent_instances SET status = 'failed', process_pid = NULL, updated_at = datetime('now') WHERE task_id = ? AND status IN ('running', 'waiting_delegation', 'pending')",
        )
        .run(taskId);

      // Clean up the recovery attempt key
      this.db
        .prepare("DELETE FROM daemon_state WHERE key = ?")
        .run(`${RECOVERY_ATTEMPT_KEY_PREFIX}${taskId}`);
    } catch (err) {
      logError(this.db, "terminal_task_cleanup", { taskId, method: "cleanupTerminalTaskState" }, err);
    }
  }

  updateOrchestrationState(taskId: string, state: OrchestrationState): void {
    try {
      const sm = new TaskStateMachine(taskId, this.db);
      sm.transitionTo(state.step);

      this.db
        .prepare(
          "UPDATE tasks SET orchestration_state = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(JSON.stringify(state), taskId);
    } catch (err) {
      logError(this.db, "orchestration_state_update", { taskId, step: state.step, method: "updateOrchestrationState" }, err);
    }
  }

  getOrchestrationState(taskId: string): OrchestrationState | null {
    try {
      const row = this.db
        .prepare("SELECT orchestration_state FROM tasks WHERE id = ?")
        .get(taskId) as { orchestration_state: string } | null;
      if (!row) return null;
      const parsed = JSON.parse(row.orchestration_state);
      if (!parsed.step) return null;
      return parsed as OrchestrationState;
    } catch (err) {
      logError(this.db, "orchestration_state_read", { taskId, method: "getOrchestrationState" }, err);
      return null;
    }
  }

  writeCheckpoint(
    taskId: string,
    checkpointType: string,
    contextSnapshot: Record<string, unknown> = {},
  ): void {
    try {
      const seqRow = this.db
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq FROM task_checkpoints WHERE task_id = ?",
        )
        .get(taskId) as { next_seq: number };

      const agentRow = this.db
        .prepare("SELECT id FROM agents WHERE current_task_id = ?")
        .get(taskId) as { id: string } | null;
      const sessionId = agentRow
        ? this.agentManager.getSessionId(agentRow.id)
        : null;

      const termSeqRow = agentRow
        ? (this.db
            .prepare(
              "SELECT MAX(sequence) as max_seq FROM terminal_outputs WHERE agent_id = ?",
            )
            .get(agentRow.id) as { max_seq: number | null } | null)
        : null;

      this.db
        .prepare(
          `INSERT INTO task_checkpoints (task_id, sequence, checkpoint_type, session_id, context_snapshot, terminal_seq)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          seqRow.next_seq,
          checkpointType,
          sessionId,
          JSON.stringify(contextSnapshot),
          termSeqRow?.max_seq ?? null,
        );
    } catch (err) {
      logError(this.db, "checkpoint_write", { taskId, checkpointType, method: "writeCheckpoint" }, err);
    }
  }

  getLatestCheckpoint(taskId: string): TaskCheckpoint | null {
    try {
      const row = this.db
        .prepare(
          "SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY sequence DESC LIMIT 1",
        )
        .get(taskId) as {
        id: number;
        task_id: string;
        sequence: number;
        checkpoint_type: string;
        session_id: string | null;
        context_snapshot: string;
        terminal_seq: number | null;
        created_at: string;
      } | null;

      if (!row) return null;
      return {
        ...row,
        context_snapshot: JSON.parse(row.context_snapshot),
      };
    } catch (err) {
      logError(this.db, "checkpoint_read", { taskId, method: "getLatestCheckpoint" }, err);
      return null;
    }
  }

  persistCheckpoints(
    getActiveDelegationForParent: (agentId: string) => { id: string } | null,
  ): void {
    const runningTask = this.getRunningTask();
    if (!runningTask) return;

    const agentRow = this.db
      .prepare("SELECT id FROM agents WHERE current_task_id = ?")
      .get(runningTask.id) as { id: string } | null;

    if (!agentRow) return;

    const sessionId = this.agentManager.getSessionId(agentRow.id);
    const activeDelegation = getActiveDelegationForParent(agentRow.id);
    const pendingReg = this.getPendingRegressions().get(agentRow.id);

    const state: OrchestrationState = {
      step: activeDelegation ? "WAITING_DELEGATION" : "AGENT_RUNNING",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: sessionId,
      active_delegation_group_id: activeDelegation?.delegation_group_id ?? null,
      active_delegation_child_count: activeDelegation?.expected_count ?? 0,
      active_delegation_settled_count: activeDelegation?.settled_count ?? 0,
      phase_guards: Array.from(this.getPhaseCompleteHandled()).filter((k) =>
        k.startsWith(`${runningTask.id}:`),
      ),
      pending_regression: pendingReg ?? null,
      checkpoint_prompt_hash: null,
    };

    this.updateOrchestrationState(runningTask.id, state);
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

  private getRunningTask(): import("../tasks/scheduler").Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'running' LIMIT 1")
      .get() as Record<string, unknown> | null;

    if (!row) return null;
    return this.taskScheduler.getTask(row.id as string);
  }

  private getActiveDelegationForParent(parentAgentId: string): {
    child_agent_id: string;
    child_instance_id: string | null;
    delegation_group_id: string | null;
    expected_count: number | null;
    settled_count: number | null;
  } | null {
    try {
      const row = this.db
        .prepare(
          `SELECT d.child_agent_id,
                  d.child_instance_id,
                  d.delegation_group_id,
                  dg.expected_count,
                  dg.settled_count
           FROM delegations d
           LEFT JOIN delegation_groups dg ON dg.id = d.delegation_group_id
           WHERE d.parent_instance_id = ? AND d.status IN ('pending', 'running')
           LIMIT 1`,
        )
        .get(parentAgentId) as {
        child_agent_id: string;
        child_instance_id: string | null;
        delegation_group_id: string | null;
        expected_count: number | null;
        settled_count: number | null;
      } | null;
      return row ?? null;
    } catch (err) {
      logError(this.db, "get_active_delegation_parent", { parentAgentId, method: "getActiveDelegationForParent" }, err);
      return null;
    }
  }
}
