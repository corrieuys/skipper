import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { PromptBuilder, AgentInfo, PhaseInfo } from "../agents/prompt-builder";
import type { TaskScheduler } from "../tasks/scheduler";
import type { TeamManager } from "../teams/manager";
import { getAgentTypeDefinition } from "../agents/types";
import { TaskStateMachine } from "./state";
import { logError } from "../logging";
import type { OrchestrationState, TaskCheckpoint, PendingRegression } from "./types";

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
   * Only clears PID/status — does NOT fail running tasks or clear task assignments.
   * Task recovery is handled separately by recoverAllStaleTasks().
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
          const childRunning = this.agentManager.getRunningAgent(activeDelegation.child_agent_id);
          if (childRunning) continue;
        }

        const didRecover = await this.recoverTask(taskId);
        if (didRecover) recovered++;
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

    const teamExec = this.teamManager.getTeamForExecution(task.team_id);
    if (!teamExec) return false;

    const entrypointAgentId = teamExec.entrypoint_agent_id;
    const agent = this.agentManager.getAgent(entrypointAgentId);
    if (!agent) return false;

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    if (!typeDef) return false;

    const orchState = task.orchestration_state as Partial<OrchestrationState>;

    const checkpoint = this.getLatestCheckpoint(taskId);

    if (orchState.phase_guards) {
      for (const guard of orchState.phase_guards) {
        this.getPhaseCompleteHandled().add(guard);
      }
    }
    if (orchState.pending_regression) {
      this.getPendingRegressions().set(entrypointAgentId, orchState.pending_regression);
    }

    if (orchState.active_delegation_id) {
      const delegation = this.getDelegation(orchState.active_delegation_id);
      if (delegation && (delegation.status === "pending" || delegation.status === "running")) {
        this.setAgentState(entrypointAgentId, "waiting_delegation", {
          delegation_id: orchState.active_delegation_id,
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
    this.agentManager.sendInput(entrypointAgentId, recoveryPrefix + prompt, closeStdin);

    this.updateOrchestrationState(taskId, {
      step: "AGENT_RUNNING",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: canResume ? sessionId : null,
      active_delegation_id: null,
      phase_guards: Array.from(this.getPhaseCompleteHandled()).filter((k) => k.startsWith(`${taskId}:`)),
      pending_regression: pendingReg ?? null,
      checkpoint_prompt_hash: null,
    });

    return true;
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
      active_delegation_id: activeDelegation?.id ?? null,
      phase_guards: Array.from(this.getPhaseCompleteHandled()).filter((k) =>
        k.startsWith(`${runningTask.id}:`),
      ),
      pending_regression: pendingReg ?? null,
      checkpoint_prompt_hash: null,
    };

    this.updateOrchestrationState(runningTask.id, state);
  }

  private getRunningTask(): import("../tasks/scheduler").Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'running' LIMIT 1")
      .get() as Record<string, unknown> | null;

    if (!row) return null;
    return this.taskScheduler.getTask(row.id as string);
  }

  private getActiveDelegationForParent(parentAgentId: string): { child_agent_id: string } | null {
    try {
      const row = this.db
        .prepare(
          "SELECT * FROM delegations WHERE parent_agent_id = ? AND status IN ('pending', 'running') LIMIT 1",
        )
        .get(parentAgentId) as { child_agent_id: string } | null;
      return row ?? null;
    } catch (err) {
      logError(this.db, "get_active_delegation_parent", { parentAgentId, method: "getActiveDelegationForParent" }, err);
      return null;
    }
  }
}
