import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { PromptBuilder, AgentInfo, PhaseInfo } from "../agents/prompt-builder";
import type { TaskScheduler } from "../tasks/scheduler";
import type { Task } from "../tasks/scheduler";
import { agentTypeUsesInlinePrompt, getAgentTypeDefinition } from "../agents/types";
import { eventBus } from "../events/bus";
import { logError } from "../logging";
import type { ConsensusManager } from "./consensus-manager";
import type { Phase } from "../teams/manager";
import type { OrchestrationState } from "./types";
import { resolvePhaseConfig } from "./phase-config";

const MAX_REGRESSIONS = 20;

/**
 * Outcome of a handlePhaseComplete call — surfaced through the MCP
 * `complete_phase` tool so Skipper sees what actually happened instead of
 * always getting "phase_advancing". The string lands verbatim in the MCP
 * response body, so values are intentionally human-readable + stable.
 */
export type PhaseCompleteOutcome =
  | "advanced"          // advanceAndRespawn fired; next phase starting
  | "task_completed"    // last phase finished, task marked completed
  | "review_pending"    // phase has review:true, awaiting operator approval
  | "noop_dedup"        // this phase already handled (dedup hit)
  | "noop_in_flight"    // another handlePhaseComplete is mid-execution
  | "noop_not_running"  // task isn't running (cancelled, failed, completed)
  | "noop_unresolved";  // couldn't resolve task or team

export class PhaseManager {
  private phaseCompleteHandled: Set<string> = new Set(); // "taskId:phase" dedup
  // Per-task in-flight guard. The await inside handlePhaseComplete yields the
  // event loop; without this, a second concurrent call would read the
  // just-advanced current_phase (via taskScheduler.advancePhase running inside
  // advanceAndRespawn), see a new dedupKey, pass the dedup check, and on the
  // last-phase branch falsely call completeTask. The Set lives across the
  // entire async run and is cleared in finally{} so failed runs don't lock the
  // task forever.
  private phaseCompleteInFlight: Set<string> = new Set();
  private consensusManager: ConsensusManager | null = null;

  setConsensusManager(cm: ConsensusManager): void {
    this.consensusManager = cm;
  }

  constructor(
    private readonly db: Database,
    private readonly agentManager: AgentManager,
    private readonly promptBuilder: PromptBuilder,
    private readonly taskScheduler: TaskScheduler,
    private readonly teamManager: import("../teams/manager").TeamManager,
    private readonly updateOrchestrationState: (taskId: string, state: OrchestrationState) => void,
    private readonly writeCheckpoint: (taskId: string, type: string, snapshot?: Record<string, unknown>) => void,
    private readonly clearIdleState?: (taskId: string) => void,
  ) {}

  private resolveTaskForRuntime(agentId: string): string | null {
    const instanceRow = this.db
      .prepare("SELECT task_id FROM agent_instances WHERE id = ?")
      .get(agentId) as { task_id: string } | null;
    if (instanceRow?.task_id) return instanceRow.task_id;

    const agentRow = this.db
      .prepare("SELECT current_task_id FROM agents WHERE id = ?")
      .get(agentId) as { current_task_id: string | null } | null;
    return agentRow?.current_task_id ?? null;
  }

  getPhaseCompleteHandled(): Set<string> {
    return this.phaseCompleteHandled;
  }

  /**
   * Drop every in-memory dedup entry for this task. Called when a task is
   * iterated, retried, or resumed — otherwise the phase-complete dedup
   * from the previous run swallows the new run's first phase advancement
   * and the task gets stuck on phase 0.
   */
  clearTaskState(taskId: string): void {
    const prefix = `${taskId}:`;
    for (const key of this.phaseCompleteHandled) {
      if (key.startsWith(prefix)) this.phaseCompleteHandled.delete(key);
    }
  }

  hasPhaseBeenHandled(taskId: string, phase: number): boolean {
    return this.phaseCompleteHandled.has(`${taskId}:${phase}`);
  }

  async handlePhaseComplete(agentId: string): Promise<PhaseCompleteOutcome> {
    const taskId = this.resolveTaskForRuntime(agentId);
    if (!taskId) return "noop_unresolved";
    const task = this.taskScheduler.getTask(taskId);
    if (!task || task.status !== "running") return "noop_not_running";

    // Race guard: a second concurrent call must NOT proceed past this point.
    // Without it, the first call's `advancePhase` (inside advanceAndRespawn)
    // changes current_phase under us; the second call then reads the new
    // value, gets a different dedupKey, passes the dedup check, and on the
    // last-phase branch falsely calls completeTask. Per-task scope is fine —
    // distinct tasks are independent.
    if (this.phaseCompleteInFlight.has(taskId)) {
      logError(this.db, "phase_complete_in_flight", { taskId, agentId, currentPhase: task.current_phase, method: "handlePhaseComplete" }, new Error("concurrent call rejected"));
      return "noop_in_flight";
    }

    // Dedup guard — key is only added after successful processing so failures allow retry
    const dedupKey = `${taskId}:${task.current_phase}`;
    if (this.phaseCompleteHandled.has(dedupKey)) return "noop_dedup";

    this.phaseCompleteInFlight.add(taskId);
    try {
      const teamExec = task.team_id
        ? this.teamManager.getTeamForExecution(task.team_id)
        : null;
      const phases = (teamExec?.team.phases as Phase[]) ?? [];

      if (phases.length === 0 || task.current_phase >= phases.length - 1) {
        try {
          this.taskScheduler.completeTask(task.id);
          this.phaseCompleteHandled.add(dedupKey);
          return "task_completed";
        } catch (err) {
          logError(this.db, "phase_complete_task", { taskId: task.id, agentId, method: "handlePhaseComplete" }, err);
          return "noop_unresolved";
        }
      }

      const resolvedCurrentPhase = resolvePhaseConfig(phases[task.current_phase]!, task.task_config as Record<string, unknown>);
      if (resolvedCurrentPhase.review) {
        // Phase has review flag — pause for human review before advancing
        try {
          this.taskScheduler.setNeedsReview(task.id, true, { phaseName: phases[task.current_phase]!.name, phaseIndex: task.current_phase });
          this.phaseCompleteHandled.add(dedupKey);
          this.writeCheckpoint(task.id, "PHASE_REVIEW_PENDING", { completed_phase: task.current_phase });
          return "review_pending";
        } catch (err) {
          logError(this.db, "phase_review_set", { taskId: task.id, agentId, method: "handlePhaseComplete" }, err);
          return "noop_unresolved";
        }
      }

      // Delegate to advanceAndRespawn — single source of truth for
      // phase-advance + entrypoint respawn. It looks up the entrypoint's
      // session via getEntrypointSessionIdForTask so the next phase's Skipper
      // resumes with conversation continuity. Also handles consensus fan-out
      // and writes PHASE_START with the session_id baked in.
      this.phaseCompleteHandled.add(dedupKey);
      await this.advanceAndRespawn(task, teamExec!.entrypoint_agent_id, phases);
      return "advanced";
    } finally {
      this.phaseCompleteInFlight.delete(taskId);
    }
  }

  async handlePhaseRegression(agentId: string, targetPhaseOneIndexed: number, reason: string): Promise<void> {
    const taskId = this.resolveTaskForRuntime(agentId);
    if (!taskId) return;
    const task = this.taskScheduler.getTask(taskId);
    if (!task || task.status !== "running") return;

    const targetPhase = targetPhaseOneIndexed - 1;

    if (targetPhase < 0 || targetPhase >= task.current_phase) return;

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
    const phases = (teamExec.team.phases as Phase[]) ?? [];

    await this.respawnForRegression(task, teamExec.entrypoint_agent_id, phases, targetPhase, reason);
  }

  async respawnForRegression(
    task: Task,
    entrypointAgentId: string,
    phases: Phase[],
    targetPhase: number,
    reason: string,
  ): Promise<void> {
    const agent = this.agentManager.getAgent(entrypointAgentId);
    if (!agent) return;

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    const isStreaming = typeDef?.supports_stdin ?? false;
    const sessionId = this.agentManager.getEntrypointSessionIdForTask(task.id, entrypointAgentId) ?? undefined;

    const agentInfo: AgentInfo = {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      instruction: agent.config.instruction,
    };

    const resolved = resolvePhaseConfig(phases[targetPhase], task.task_config as Record<string, unknown>);
    const phaseInfo: PhaseInfo = {
      name: resolved.name,
      prompt: resolved.prompt,
      index: targetPhase,
      total: phases.length,
    };

    const { prompt, noteIds } = this.promptBuilder.buildInitialPromptTracked({
      agent: agentInfo,
      task: { id: task.id, title: task.title, description: task.description ?? undefined, workingDirectory: task.working_directory },
      phase: phaseInfo,
      isStreaming,
      regressionReason: reason,
      injectedInput: task.run_input ?? undefined,
    }, entrypointAgentId);
    const usesInlinePrompt = typeDef ? agentTypeUsesInlinePrompt(typeDef, sessionId) : false;

    // Target THIS task's entrypoint instance, not the shared template id —
    // parallel same-team tasks each have their own instance under one template.
    const runningInstance = this.agentManager.getRunningInstanceForTask(entrypointAgentId, task.id);
    const respawnRuntimeId = runningInstance?.id ?? crypto.randomUUID();
    if (runningInstance) {
      this.agentManager.markAsRespawning(runningInstance.id);
      this.agentManager.killAgent(runningInstance.id);
      await this.agentManager.waitForExit(runningInstance.id);
    }

    try {
      const workingDir = process.cwd();
      await this.agentManager.spawnAgentInstance(entrypointAgentId, respawnRuntimeId, {
        workingDir,
        taskId: task.id,
        sessionId,
        initialPrompt: usesInlinePrompt ? prompt : undefined,
        parentInstanceId: null,
        rootInstanceId: respawnRuntimeId,
        attempt: 1,
      });
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

    const closeStdin = !isStreaming;
    try {
      if (!usesInlinePrompt) {
        this.agentManager.sendInput(entrypointAgentId, prompt, closeStdin);
      }
      if (noteIds.length > 0) {
        this.promptBuilder.recordNoteDelivery(entrypointAgentId, noteIds);
      }
    } catch (err) {
      logError(this.db, "regression_send_input", { taskId: task.id, agentId: entrypointAgentId, targetPhase, method: "respawnForRegression" }, err);
      try {
        this.taskScheduler.failTask(task.id, `Failed to send regression prompt: ${err instanceof Error ? err.message : String(err)}`);
      } catch (innerErr) {
        logError(this.db, "regression_send_input_fail_task", { taskId: task.id, method: "respawnForRegression" }, innerErr);
      }
    }
  }

  async advanceAndRespawn(
    task: Task,
    entrypointAgentId: string,
    phases: Phase[],
    approvalNote?: string,
  ): Promise<void> {
    const nextPhaseIndex = task.current_phase + 1;
    const resolvedNext = resolvePhaseConfig(phases[nextPhaseIndex], task.task_config as Record<string, unknown>);
    const resolvedNextPhaseObj: Phase = { name: resolvedNext.name, prompt: resolvedNext.prompt, review: resolvedNext.review, consensus: resolvedNext.consensus ?? undefined };

    // Consensus phase — delegate to ConsensusManager
    if (resolvedNext.consensus && resolvedNext.consensus.agent_count >= 2) {
      this.taskScheduler.advancePhase(task.id);
      const updatedTask = this.taskScheduler.getTask(task.id)!;
      await this.consensusManager?.startConsensusPhase({
        task: updatedTask,
        entrypointAgentId,
        phase: resolvedNextPhaseObj,
        phaseIndex: nextPhaseIndex,
        totalPhases: phases.length,
      });
      return;
    }

    const advanced = this.taskScheduler.advancePhase(task.id);
    const nextPhase = advanced.current_phase;

    const agent = this.agentManager.getAgent(entrypointAgentId);
    if (!agent) return;

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    const isStreaming = typeDef?.supports_stdin ?? false;

    const sessionId = this.agentManager.getEntrypointSessionIdForTask(task.id, entrypointAgentId) ?? undefined;

    const agentInfo: AgentInfo = {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      instruction: agent.config.instruction,
    };

    const phaseInfo: PhaseInfo = {
      name: resolvedNext.name,
      prompt: resolvedNext.prompt,
      index: nextPhase,
      total: phases.length,
    };

    const { prompt, noteIds } = this.promptBuilder.buildInitialPromptTracked({
      agent: agentInfo,
      task: { id: task.id, title: task.title, description: task.description ?? undefined, workingDirectory: task.working_directory },
      phase: phaseInfo,
      isStreaming,
      approvalNote,
    }, entrypointAgentId);
    const usesInlinePrompt = typeDef ? agentTypeUsesInlinePrompt(typeDef, sessionId) : false;

    // Target THIS task's entrypoint instance, not the shared template id. With
    // parallel same-team tasks the template has several live instances; killing
    // by template id would tear down a sibling task's agent.
    const runningInstance = this.agentManager.getRunningInstanceForTask(entrypointAgentId, task.id);
    const respawnRuntimeId = runningInstance?.id ?? crypto.randomUUID();
    if (runningInstance) {
      this.agentManager.markAsRespawning(runningInstance.id);
      this.agentManager.killAgent(runningInstance.id);
      await this.agentManager.waitForExit(runningInstance.id);
    }

    try {
      const workingDir = process.cwd();
      // spawnAgentInstance bypasses the template-keyed spawn lock that
      // spawnAgent takes, so a sibling same-team task mid-respawn can't trip
      // "Spawn already in flight for agent <template>".
      await this.agentManager.spawnAgentInstance(entrypointAgentId, respawnRuntimeId, {
        workingDir,
        taskId: task.id,
        sessionId,
        initialPrompt: usesInlinePrompt ? prompt : undefined,
        parentInstanceId: null,
        rootInstanceId: respawnRuntimeId,
        attempt: 1,
      });
    } catch (err) {
      logError(this.db, "phase_respawn", { taskId: task.id, agentId: entrypointAgentId, method: "advanceAndRespawn" }, err);
      this.taskScheduler.failTask(task.id, "Failed to respawn agent for next phase");
      return;
    }

    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(task.id, entrypointAgentId);

    const closeStdin = !isStreaming;
    try {
      if (!usesInlinePrompt) {
        this.agentManager.sendInput(entrypointAgentId, prompt, closeStdin);
      }
      if (noteIds.length > 0) {
        this.promptBuilder.recordNoteDelivery(entrypointAgentId, noteIds);
      }
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
      active_delegation_group_id: null,
      active_delegation_child_count: 0,
      active_delegation_settled_count: 0,
      phase_guards: phaseGuards,
      pending_regression: null,
      checkpoint_prompt_hash: null,
    });
    this.writeCheckpoint(task.id, "PHASE_START", {
      phase: nextPhase,
      session_id: sessionId ?? null,
    });
  }

  async approveReview(taskId: string, approvalNote?: string): Promise<void> {
    const task = this.taskScheduler.getTask(taskId);
    if (!task || task.status !== "running" || !task.needs_review) return;

    this.taskScheduler.setNeedsReview(taskId, false);
    this.clearIdleState?.(taskId);

    const note = approvalNote?.trim() || undefined;
    if (note) {
      this.writeCheckpoint(taskId, "PHASE_REVIEW_APPROVED", { approved_phase: task.current_phase, note });
    }

    const teamExec = task.team_id
      ? this.teamManager.getTeamForExecution(task.team_id)
      : null;
    const phases = (teamExec?.team.phases as Phase[]) ?? [];

    if (phases.length === 0 || task.current_phase >= phases.length - 1) {
      try {
        this.taskScheduler.completeTask(task.id);
      } catch (err) {
        logError(this.db, "review_approve_complete", { taskId, method: "approveReview" }, err);
      }
    } else {
      await this.advanceAndRespawn(task, teamExec!.entrypoint_agent_id, phases, note);
    }
  }

  async rejectReview(taskId: string, message?: string): Promise<void> {
    const task = this.taskScheduler.getTask(taskId);
    if (!task || task.status !== "running" || !task.needs_review) return;

    const rejectionReason = message?.trim() || "Phase review rejected by operator";

    this.taskScheduler.setNeedsReview(taskId, false);
    this.clearIdleState?.(taskId);

    const targetPhase = task.current_phase > 0 ? task.current_phase - 1 : 0;
    if (task.current_phase > 0) {
      this.taskScheduler.regressPhase(taskId, targetPhase);
    }
    this.writeCheckpoint(taskId, "PHASE_REVIEW_REJECTED", { rejected_phase: task.current_phase, target_phase: targetPhase, reason: rejectionReason });

    // Clear dedup key so the re-run can trigger review again
    const dedupKey = `${taskId}:${targetPhase}`;
    this.phaseCompleteHandled.delete(dedupKey);

    const teamExec = task.team_id
      ? this.teamManager.getTeamForExecution(task.team_id)
      : null;
    if (teamExec) {
      const phases = (teamExec.team.phases as Phase[]) ?? [];
      await this.respawnForRegression(
        task,
        teamExec.entrypoint_agent_id,
        phases,
        targetPhase,
        rejectionReason,
      );
    } else {
      try {
        this.taskScheduler.failTask(taskId, rejectionReason);
      } catch (err) {
        logError(this.db, "review_reject_fail", { taskId, method: "rejectReview" }, err);
      }
    }
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
}
