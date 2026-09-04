import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { PromptBuilder, AgentInfo, PhaseInfo } from "../agents/prompt-builder";
import type { TaskScheduler } from "../tasks/scheduler";
import type { TeamManager, Phase } from "../teams/manager";
import { agentTypeUsesInlinePrompt } from "../agents/types";
import { logError } from "../logging";
import type { OrchestrationState } from "./types";
import { resolvePhaseConfig } from "./phase-config";
import { getBoolSetting, SETTING_PARALLEL_TASKS } from "../config/app-settings";

/**
 * Implemented by the input pipeline (realtime-session.ts): delivers pending
 * timeline input to a task's root agent, resuming its session or cold-starting
 * it. The queue routes a woken task through this when input is waiting, so
 * input wakes respect the same concurrency cap as first starts.
 */
export interface TaskWakeFeeder {
  hasPendingFeed(taskId: string): boolean;
  feedTask(taskId: string): Promise<boolean>;
  consumePendingFeed(taskId: string): { text: string; commit: () => void } | null;
}

export class TaskRunner {
  private wakeFeeder: TaskWakeFeeder | null = null;

  setWakeFeeder(feeder: TaskWakeFeeder): void {
    this.wakeFeeder = feeder;
  }

  constructor(
    private readonly db: Database,
    private readonly agentManager: AgentManager,
    private readonly promptBuilder: PromptBuilder,
    private readonly taskScheduler: TaskScheduler,
    private readonly teamManager: TeamManager,
    private readonly updateOrchestrationState: (taskId: string, state: OrchestrationState) => void,
    private readonly writeCheckpoint: (taskId: string, type: string, snapshot?: Record<string, unknown>) => void,
  ) {}

  private static readonly PARALLEL_MAX_CONCURRENT = 5;

  /**
   * A task occupies a concurrency slot while it has live agents or is paused.
   * A paused task keeps its slot — pausing must NOT free the daemon to start
   * the next queued task (critical when parallel execution is disabled, cap=1).
   * Idle active tasks hold no slot: running-with-no-agents is a resting state.
   */
  private countOccupiedSlots(): number {
    return (this.db
      .prepare(
        `SELECT COUNT(*) as c FROM tasks t
         WHERE t.status = 'active'
           AND (t.paused = 1 OR EXISTS (
             SELECT 1 FROM agent_instances ai
             WHERE ai.task_id = t.id AND ai.status IN ('running', 'waiting_delegation', 'pending')
           ))`,
      )
      .get() as { c: number }).c;
  }

  async processTaskQueue(): Promise<{ processed: number }> {
    const parallel = getBoolSetting(this.db, SETTING_PARALLEL_TASKS, true);
    const cap = parallel ? TaskRunner.PARALLEL_MAX_CONCURRENT : 1;
    if (this.countOccupiedSlots() >= cap) {
      return { processed: 0 };
    }

    const task = this.taskScheduler.getNextStartableTask();
    if (!task) {
      return { processed: 0 };
    }

    this.taskScheduler.markStarted(task.id);
    const startedTask = this.taskScheduler.getTask(task.id);
    if (!startedTask) {
      return { processed: 1 };
    }

    if (!startedTask.team_id) {
      // Teamless (conversational) task: nothing to run without input. If input
      // is waiting, deliver it through the pipeline (it resolves the fallback
      // entrypoint); otherwise rest idle until input arrives.
      if (this.wakeFeeder?.hasPendingFeed(task.id)) {
        const fed = await this.wakeFeeder.feedTask(task.id);
        if (fed) this.markAgentRunning(task.id, 0);
      }
      return { processed: 1 };
    }

    const teamExec = this.teamManager.getTeamForExecution(startedTask.team_id);
    if (!teamExec) {
      this.taskScheduler.failRun(task.id, "Team has no entrypoint agent");
      return { processed: 1 };
    }

    const entrypointAgentId = teamExec.entrypoint_agent_id;
    const agent = this.agentManager.getAgent(entrypointAgentId);
    if (!agent) {
      this.taskScheduler.failRun(task.id, `Entrypoint agent not found: ${entrypointAgentId}`);
      return { processed: 1 };
    }

    // Effective def: the machine-scoped provider override (config page) wins
    // over the template row's type, matching what spawnAgent will resolve.
    const typeDef = this.agentManager.getEffectiveRootTypeDef(entrypointAgentId);
    const isStreaming = typeDef?.supports_stdin ?? false;

    // Resume prior entrypoint session if one exists for this task and the agent type supports resume.
    // A wake or restart should continue the prior skipper's conversation rather than start cold.
    const priorEntrypoint = (typeDef?.supports_resume
      ? this.db
        .prepare(
          `SELECT session_id FROM agent_instances
           WHERE task_id = ? AND parent_instance_id IS NULL
             AND template_agent_id = ? AND session_id IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(task.id, entrypointAgentId)
      : null) as { session_id: string } | null;
    const resumeSessionId = priorEntrypoint?.session_id ?? null;

    if (!resumeSessionId) {
      // No prior session to resume — start fresh.
      this.agentManager.clearSessionId(entrypointAgentId);
    }

    // Only tear down a stale instance belonging to THIS task (e.g. a resume).
    // Killing by template id would murder a sibling same-team task's entrypoint.
    const staleInstance = this.agentManager.getRunningInstanceForTask(entrypointAgentId, task.id);
    if (staleInstance) {
      this.agentManager.killAgent(staleInstance.id);
      await this.agentManager.waitForExit(staleInstance.id);
    }

    const agentInfo: AgentInfo = {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      instruction: agent.config.instruction,
    };

    const phases = teamExec.team.phases as Phase[];
    const startPhase = Math.max(0, startedTask.current_phase ?? 0);
    let phaseInfo: PhaseInfo | undefined;
    if (phases.length > 0) {
      const safePhase = Math.min(startPhase, phases.length - 1);
      const resolved = resolvePhaseConfig(phases[safePhase], startedTask.task_config as Record<string, unknown>);
      phaseInfo = {
        name: resolved.name,
        prompt: resolved.prompt,
        index: safePhase,
        total: phases.length,
      };
    }

    const { prompt: basePrompt, noteIds } = this.promptBuilder.buildInitialPromptTracked({
      agent: agentInfo,
      task: { id: startedTask.id, title: startedTask.title, description: startedTask.description ?? undefined },
      phase: phaseInfo,
      isStreaming,
      isResume: resumeSessionId !== null,
      injectedInput: startedTask.run_input ?? undefined,
    }, entrypointAgentId);

    // A wake carries the pending input as an INPUT_FEED block appended to the
    // full prompt (phases, notes, resume preamble included) — the unified
    // replacement for the old iterate / resume / realtime-feed paths. Entries
    // are only marked fed after the prompt actually reaches the agent.
    const pendingFeed = this.wakeFeeder?.consumePendingFeed(task.id) ?? null;
    const prompt = pendingFeed ? `${basePrompt}\n\n${pendingFeed.text}` : basePrompt;

    const usesInlinePrompt = typeDef ? agentTypeUsesInlinePrompt(typeDef) : false;
    // Agents spawn in the orchestrator's cwd (where Claude Code config/hooks live).
    // The task's working_directory is communicated via the prompt.
    const workingDir = process.cwd();

    // Set current_task_id BEFORE spawn so the manager can reference it
    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(task.id, entrypointAgentId);

    let spawnedRuntimeId: string;
    try {
      const spawned = await this.agentManager.spawnAgent(entrypointAgentId, {
        workingDir,
        taskId: task.id,
        initialPrompt: usesInlinePrompt ? prompt : undefined,
        sessionId: resumeSessionId ?? undefined,
      });
      spawnedRuntimeId = spawned.id;
    } catch (err) {
      this.taskScheduler.failRun(
        task.id,
        `Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { processed: 1 };
    }
    // agent_instances row created by spawnAgent → spawnRuntimeAgent with unique UUID

    if (noteIds.length > 0) {
      this.promptBuilder.recordNoteDelivery(entrypointAgentId, noteIds);
    }

    const closeStdin = !isStreaming;
    try {
      if (!usesInlinePrompt) {
        // Target the exact runtime instance just spawned — NOT the template id.
        // Under parallel same-team tasks the template has multiple live
        // instances; sendInput(templateId) resolves to an arbitrary sibling and
        // writes this task's prompt to the wrong process's stdin, leaving the
        // new claude-code --print with no stdin ("Input must be provided...").
        this.agentManager.sendInput(spawnedRuntimeId, prompt, closeStdin);
      }
    } catch (err) {
      logError(this.db, "task_startup_send_input", { taskId: task.id, agentId: entrypointAgentId, method: "processTaskQueue" }, err);
      this.taskScheduler.failRun(
        task.id,
        `Failed to send initial prompt: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { processed: 1 };
    }

    pendingFeed?.commit();
    this.markAgentRunning(task.id, startPhase);

    return { processed: 1 };
  }

  private markAgentRunning(taskId: string, phase: number): void {
    this.updateOrchestrationState(taskId, {
      step: "AGENT_RUNNING",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: null,
      active_delegation_group_id: null,
      active_delegation_child_count: 0,
      active_delegation_settled_count: 0,
      phase_guards: [],
      pending_regression: null,
      checkpoint_prompt_hash: null,
    });
    this.writeCheckpoint(taskId, "PHASE_START", { phase });
  }

  getRunningTask(): import("../tasks/scheduler").Task | null {
    const row = this.db
      .prepare(
        `SELECT t.* FROM tasks t
         WHERE t.status = 'active' AND EXISTS (
           SELECT 1 FROM agent_instances ai
           WHERE ai.task_id = t.id AND ai.status IN ('running', 'waiting_delegation', 'pending')
         )
         LIMIT 1`,
      )
      .get() as Record<string, unknown> | null;

    if (!row) return null;
    return this.taskScheduler.getTask(row.id as string);
  }
}
