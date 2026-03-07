import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { PromptBuilder, AgentInfo, PhaseInfo } from "../agents/prompt-builder";
import type { TaskScheduler } from "../tasks/scheduler";
import type { Task } from "../tasks/scheduler";
import { getAgentTypeDefinition } from "../agents/types";
import { eventBus } from "../events/bus";
import { logError } from "../logging";
import type { OrchestrationState, PendingRegression } from "./types";

const MAX_REGRESSIONS = 3;

export class PhaseManager {
  private phaseCompleteHandled: Set<string> = new Set(); // "taskId:phase" dedup
  private pendingRegressions: Map<string, PendingRegression> = new Map(); // agentId -> regression

  constructor(
    private readonly db: Database,
    private readonly agentManager: AgentManager,
    private readonly promptBuilder: PromptBuilder,
    private readonly taskScheduler: TaskScheduler,
    private readonly teamManager: import("../teams/manager").TeamManager,
    private readonly updateOrchestrationState: (taskId: string, state: OrchestrationState) => void,
    private readonly writeCheckpoint: (taskId: string, type: string, snapshot?: Record<string, unknown>) => void,
  ) {}

  getPhaseCompleteHandled(): Set<string> {
    return this.phaseCompleteHandled;
  }

  getPendingRegression(agentId: string): PendingRegression | undefined {
    return this.pendingRegressions.get(agentId);
  }

  getPendingRegressions(): Map<string, PendingRegression> {
    return this.pendingRegressions;
  }

  handlePhaseComplete(agentId: string): void {
    const agentRow = this.db
      .prepare("SELECT current_task_id FROM agents WHERE id = ?")
      .get(agentId) as { current_task_id: string | null } | null;

    if (!agentRow?.current_task_id) return;

    const taskId = agentRow.current_task_id;
    const task = this.taskScheduler.getTask(taskId);
    if (!task || task.status !== "running") return;

    // Dedup guard
    const dedupKey = `${taskId}:${task.current_phase}`;
    if (this.phaseCompleteHandled.has(dedupKey)) return;
    this.phaseCompleteHandled.add(dedupKey);

    const teamExec = task.team_id
      ? this.teamManager.getTeamForExecution(task.team_id)
      : null;
    const phases = (teamExec?.team.phases as { name: string; prompt: string }[]) ?? [];

    if (phases.length === 0 || task.current_phase >= phases.length - 1) {
      try {
        this.taskScheduler.completeTask(task.id);
      } catch (err) {
        logError(this.db, "phase_complete_task", { taskId: task.id, agentId, method: "handlePhaseComplete" }, err);
      }
    } else {
      const advanced = this.taskScheduler.advancePhase(task.id);
      const nextPhase = advanced.current_phase;
      const entrypointAgentId = teamExec!.entrypoint_agent_id;

      const agent = this.agentManager.getAgent(entrypointAgentId);
      if (!agent) return;

      const agentInfo: AgentInfo = {
        id: agent.id,
        name: agent.name,
        type: agent.type,
        instruction: agent.config.instruction,
      };

      const phaseInfo: PhaseInfo = {
        name: phases[nextPhase].name,
        prompt: phases[nextPhase].prompt,
        index: nextPhase,
        total: phases.length,
      };

      const typeDef = getAgentTypeDefinition(agent.type, this.db);
      const isStreaming = typeDef?.supports_stdin ?? false;

      const prompt = this.promptBuilder.buildInitialPrompt({
        agent: agentInfo,
        task: { id: task.id, title: task.title, description: task.description ?? undefined },
        phase: phaseInfo,
        isStreaming,
      });

      try {
        this.agentManager.sendInput(entrypointAgentId, prompt);
      } catch (err) {
        logError(this.db, "phase_advance_send_input", { taskId: task.id, agentId: entrypointAgentId, phase: nextPhase, method: "handlePhaseComplete" }, err);
        try {
          this.taskScheduler.failTask(task.id, `Failed to send phase ${nextPhase} prompt: ${err instanceof Error ? err.message : String(err)}`);
        } catch (innerErr) {
          logError(this.db, "phase_advance_fail_task", { taskId: task.id, method: "handlePhaseComplete" }, innerErr);
        }
        return;
      }

      this.writeCheckpoint(task.id, "PHASE_START", { phase: nextPhase });
    }
  }

  handlePhaseRegression(agentId: string, targetPhaseOneIndexed: number, reason: string): void {
    const agentRow = this.db
      .prepare("SELECT current_task_id FROM agents WHERE id = ?")
      .get(agentId) as { current_task_id: string | null } | null;

    if (!agentRow?.current_task_id) return;

    const taskId = agentRow.current_task_id;
    const task = this.taskScheduler.getTask(taskId);
    if (!task || task.status !== "running") return;

    const targetPhase = targetPhaseOneIndexed - 1;

    if (targetPhase < 0 || targetPhase >= task.current_phase) return;

    this.recordPhaseRegression(taskId, agentId, task.current_phase, targetPhase, reason);

    try {
      const noteId = crypto.randomUUID();
      this.db
        .prepare(
          "INSERT INTO task_notes (id, task_id, agent_id, content) VALUES (?, ?, ?, ?)",
        )
        .run(noteId, taskId, agentId, `[PHASE REGRESSION to phase ${targetPhaseOneIndexed}] ${reason}`);
    } catch (err) {
      logError(this.db, "regression_note_create", { taskId, agentId, method: "handlePhaseRegression" }, err);
    }

    if (task.regression_count >= MAX_REGRESSIONS) {
      this.autoEscalateRegression(task, agentId, reason);
      return;
    }

    this.taskScheduler.regressPhase(taskId, targetPhase);

    for (let i = targetPhase; i <= task.current_phase; i++) {
      this.phaseCompleteHandled.delete(`${taskId}:${i}`);
    }

    this.writeCheckpoint(taskId, "REGRESSION", {
      from_phase: task.current_phase,
      to_phase: targetPhase,
      reason,
    });

    const teamExec = task.team_id
      ? this.teamManager.getTeamForExecution(task.team_id)
      : null;
    if (!teamExec) return;
    const phases = (teamExec.team.phases as { name: string; prompt: string }[]) ?? [];

    const agent = this.agentManager.getAgent(agentId);
    if (!agent) return;
    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    const isStreaming = typeDef?.supports_stdin ?? false;

    if (isStreaming) {
      this.respawnForRegression(task, teamExec.entrypoint_agent_id, phases, targetPhase, reason).catch((err) => {
        logError(this.db, "regression_respawn_async", { taskId, agentId, targetPhase, method: "handlePhaseRegression" }, err);
        try {
          this.taskScheduler.failTask(taskId, `Regression respawn failed: ${err instanceof Error ? err.message : String(err)}`);
        } catch (innerErr) {
          logError(this.db, "regression_respawn_async_fail_task", { taskId, method: "handlePhaseRegression" }, innerErr);
        }
      });
    } else {
      this.pendingRegressions.set(agentId, { targetPhase, reason });
    }
  }

  async respawnForRegression(
    task: Task,
    entrypointAgentId: string,
    phases: { name: string; prompt: string }[],
    targetPhase: number,
    reason: string,
  ): Promise<void> {
    const agent = this.agentManager.getAgent(entrypointAgentId);
    if (!agent) return;

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    const isStreaming = typeDef?.supports_stdin ?? false;

    const sessionId = this.agentManager.getSessionId(entrypointAgentId) ?? undefined;

    if (this.agentManager.getRunningAgent(entrypointAgentId)) {
      this.agentManager.killAgent(entrypointAgentId);
      await this.agentManager.waitForExit(entrypointAgentId);
    }

    try {
      const workingDir = process.cwd();
      await this.agentManager.spawnAgent(entrypointAgentId, { workingDir, sessionId });
    } catch (err) {
      logError(this.db, "regression_respawn", { taskId: task.id, agentId: entrypointAgentId, targetPhase, method: "respawnForRegression" }, err);
      try {
        this.taskScheduler.failTask(task.id, "Failed to respawn agent for regression");
      } catch (innerErr) {
        logError(this.db, "regression_respawn_fail_task", { taskId: task.id, method: "respawnForRegression" }, innerErr);
      }
      return;
    }

    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(task.id, entrypointAgentId);

    const agentInfo: AgentInfo = {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      instruction: agent.config.instruction,
    };

    const phaseInfo: PhaseInfo = {
      name: phases[targetPhase].name,
      prompt: phases[targetPhase].prompt,
      index: targetPhase,
      total: phases.length,
    };

    const prompt = this.promptBuilder.buildInitialPrompt({
      agent: agentInfo,
      task: { id: task.id, title: task.title, description: task.description ?? undefined },
      phase: phaseInfo,
      isStreaming,
      regressionReason: reason,
    });

    const closeStdin = !isStreaming;
    try {
      this.agentManager.sendInput(entrypointAgentId, prompt, closeStdin);
    } catch (err) {
      logError(this.db, "regression_send_input", { taskId: task.id, agentId: entrypointAgentId, targetPhase, method: "respawnForRegression" }, err);
      try {
        this.taskScheduler.failTask(task.id, `Failed to send regression prompt: ${err instanceof Error ? err.message : String(err)}`);
      } catch (innerErr) {
        logError(this.db, "regression_send_input_fail_task", { taskId: task.id, method: "respawnForRegression" }, innerErr);
      }
    }
  }

  handleSuccessfulExit(task: Task, agentId: string): void {
    const pendingRegression = this.pendingRegressions.get(agentId);
    if (pendingRegression) {
      this.pendingRegressions.delete(agentId);
      const teamExec = task.team_id
        ? this.teamManager.getTeamForExecution(task.team_id)
        : null;
      if (teamExec) {
        const phases = (teamExec.team.phases as { name: string; prompt: string }[]) ?? [];
        this.respawnForRegression(
          task,
          teamExec.entrypoint_agent_id,
          phases,
          pendingRegression.targetPhase,
          pendingRegression.reason,
        ).catch((err) => {
          logError(this.db, "regression_respawn_async", { taskId: task.id, agentId, method: "handleSuccessfulExit" }, err);
          try {
            this.taskScheduler.failTask(task.id, `Regression respawn failed: ${err instanceof Error ? err.message : String(err)}`);
          } catch (innerErr) {
            logError(this.db, "regression_respawn_async_fail_task", { taskId: task.id, method: "handleSuccessfulExit" }, innerErr);
          }
        });
      }
      return;
    }

    const teamExec = task.team_id
      ? this.teamManager.getTeamForExecution(task.team_id)
      : null;
    const phases = (teamExec?.team.phases as { name: string; prompt: string }[]) ?? [];

    if (phases.length === 0 || task.current_phase >= phases.length - 1) {
      try {
        this.taskScheduler.completeTask(task.id);
      } catch (err) {
        logError(this.db, "task_complete", { taskId: task.id, agentId, method: "handleSuccessfulExit" }, err);
      }
    } else {
      this.advanceAndRespawn(task, teamExec!.entrypoint_agent_id, phases).catch((err) => {
        logError(this.db, "advance_respawn_async", { taskId: task.id, agentId, method: "handleSuccessfulExit" }, err);
        try {
          this.taskScheduler.failTask(task.id, `Phase advance respawn failed: ${err instanceof Error ? err.message : String(err)}`);
        } catch (innerErr) {
          logError(this.db, "advance_respawn_async_fail_task", { taskId: task.id, method: "handleSuccessfulExit" }, innerErr);
        }
      });
    }
  }

  async advanceAndRespawn(
    task: Task,
    entrypointAgentId: string,
    phases: { name: string; prompt: string }[],
  ): Promise<void> {
    const advanced = this.taskScheduler.advancePhase(task.id);
    const nextPhase = advanced.current_phase;

    const agent = this.agentManager.getAgent(entrypointAgentId);
    if (!agent) return;

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    const isStreaming = typeDef?.supports_stdin ?? false;

    const runningAgent = this.agentManager.getRunningAgent(entrypointAgentId);
    const sessionId = runningAgent?.sessionId ?? undefined;

    try {
      const workingDir = process.cwd();
      await this.agentManager.spawnAgent(entrypointAgentId, { workingDir, sessionId });
    } catch (err) {
      logError(this.db, "phase_respawn", { taskId: task.id, agentId: entrypointAgentId, method: "advanceAndRespawn" }, err);
      this.taskScheduler.failTask(task.id, "Failed to respawn agent for next phase");
      return;
    }

    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(task.id, entrypointAgentId);

    const agentInfo: AgentInfo = {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      instruction: agent.config.instruction,
    };

    const phaseInfo: PhaseInfo = {
      name: phases[nextPhase].name,
      prompt: phases[nextPhase].prompt,
      index: nextPhase,
      total: phases.length,
    };

    const prompt = this.promptBuilder.buildInitialPrompt({
      agent: agentInfo,
      task: { id: task.id, title: task.title, description: task.description ?? undefined },
      phase: phaseInfo,
      isStreaming,
    });

    const closeStdin = !isStreaming;
    try {
      this.agentManager.sendInput(entrypointAgentId, prompt, closeStdin);
    } catch (err) {
      logError(this.db, "advance_respawn_send_input", { taskId: task.id, agentId: entrypointAgentId, phase: nextPhase, method: "advanceAndRespawn" }, err);
      try {
        this.taskScheduler.failTask(task.id, `Failed to send next phase prompt: ${err instanceof Error ? err.message : String(err)}`);
      } catch (innerErr) {
        logError(this.db, "advance_respawn_fail_task", { taskId: task.id, method: "advanceAndRespawn" }, innerErr);
      }
      return;
    }

    const phaseGuards = Array.from(this.phaseCompleteHandled)
      .filter((k) => k.startsWith(`${task.id}:`));
    this.updateOrchestrationState(task.id, {
      step: "AGENT_RUNNING",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: sessionId ?? null,
      active_delegation_id: null,
      phase_guards: phaseGuards,
      pending_regression: null,
      checkpoint_prompt_hash: null,
    });
    this.writeCheckpoint(task.id, "PHASE_START", {
      phase: nextPhase,
      session_id: sessionId ?? null,
    });
  }

  private autoEscalateRegression(task: Task, agentId: string, reason: string): void {
    try {
      const escalationId = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO escalations (id, agent_id, task_id, type, question, severity)
           VALUES (?, ?, ?, 'max_regressions', ?, 'high')`,
        )
        .run(
          escalationId,
          agentId,
          task.id,
          `Phase regression denied: maximum regressions (${MAX_REGRESSIONS}) reached for task "${task.title}". Last reason: ${reason}`,
        );

      eventBus.emit("escalation:created", {
        escalationId,
        agentId,
        taskId: task.id,
        type: "max_regressions",
        question: `Maximum regressions reached. Last reason: ${reason}`,
      });
    } catch (err) {
      logError(this.db, "escalation_create", { taskId: task.id, agentId, reason, method: "autoEscalateRegression" }, err);
    }
  }

  private recordPhaseRegression(
    taskId: string,
    agentId: string,
    fromPhase: number,
    toPhase: number,
    reason: string,
  ): void {
    try {
      this.db
        .prepare(
          "INSERT INTO phase_regressions (task_id, agent_id, from_phase, to_phase, reason) VALUES (?, ?, ?, ?, ?)",
        )
        .run(taskId, agentId, fromPhase, toPhase, reason);
    } catch (err) {
      logError(this.db, "phase_regression_record", { taskId, agentId, fromPhase, toPhase, method: "recordPhaseRegression" }, err);
    }
  }
}
