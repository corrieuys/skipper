import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { PromptBuilder, AgentInfo, PhaseInfo } from "../agents/prompt-builder";
import type { TaskScheduler } from "../tasks/scheduler";
import type { TeamManager, Phase } from "../teams/manager";
import type { ConsensusManager } from "./consensus-manager";
import { agentTypeUsesInlinePrompt, getAgentTypeDefinition } from "../agents/types";
import { eventBus } from "../events/bus";
import { logError } from "../logging";
import type { OrchestrationState } from "./types";
import { getTaskTemplateId, resolvePhaseConfig } from "../templates/helpers";
import { getBoolSetting, SETTING_PARALLEL_TASKS } from "../config/app-settings";

export class TaskRunner {
  private consensusManager: ConsensusManager | null = null;

  setConsensusManager(cm: ConsensusManager): void {
    this.consensusManager = cm;
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

  async processTaskQueue(): Promise<{ processed: number }> {
    const parallel = getBoolSetting(this.db, SETTING_PARALLEL_TASKS, true);
    const cap = parallel ? TaskRunner.PARALLEL_MAX_CONCURRENT : 1;
    // A paused task still occupies its concurrency slot — pausing must NOT free
    // the daemon to start the next approved task (critical when parallel
    // execution is disabled, cap=1).
    const runningCount = (this.db
      .prepare("SELECT COUNT(*) as c FROM tasks WHERE status IN ('running', 'paused') AND task_type != 'real_time'")
      .get() as { c: number }).c;
    if (runningCount >= cap) {
      return { processed: 0 };
    }


    const task = this.taskScheduler.getNextApprovedTask();
    if (!task) {
      return { processed: 0 };
    }

    this.taskScheduler.startTask(task.id);
    const startedTask = (this.taskScheduler as { getTask?: (id: string) => typeof task | null }).getTask?.(task.id) ?? task;
    if (!startedTask) {
      this.taskScheduler.failTask(task.id, "Task disappeared after start");
      return { processed: 1 };
    }

    if (!startedTask.team_id) {
      this.taskScheduler.failTask(task.id, "Task has no team assigned");
      return { processed: 1 };
    }

    const teamExec = this.teamManager.getTeamForExecution(startedTask.team_id);
    if (!teamExec) {
      this.taskScheduler.failTask(task.id, "Team has no entrypoint agent");
      return { processed: 1 };
    }

    const entrypointAgentId = teamExec.entrypoint_agent_id;
    const agent = this.agentManager.getAgent(entrypointAgentId);
    if (!agent) {
      this.taskScheduler.failTask(task.id, `Entrypoint agent not found: ${entrypointAgentId}`);
      return { processed: 1 };
    }

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    const isStreaming = typeDef?.supports_stdin ?? false;

    // Resume prior entrypoint session if one exists for this task and the agent type supports resume.
    // Restart should continue the prior skipper's conversation rather than start cold.
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

    if (this.agentManager.getRunningAgent(entrypointAgentId)) {
      this.agentManager.killAgent(entrypointAgentId);
      await this.agentManager.waitForExit(entrypointAgentId);
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
    let resolvedStartPhase: Phase | undefined;
    if (phases.length > 0) {
      const safePhase = Math.min(startPhase, phases.length - 1);
      const templateId = getTaskTemplateId(startedTask.task_config);
      const resolved = resolvePhaseConfig(this.db, phases[safePhase], templateId, startedTask.task_config as Record<string, unknown>);
      resolvedStartPhase = { name: resolved.name, prompt: resolved.prompt, review: resolved.review, consensus: resolved.consensus ?? undefined };
      phaseInfo = {
        name: resolved.name,
        prompt: resolved.prompt,
        index: safePhase,
        total: phases.length,
      };
    }

    // Check if the starting phase is a consensus phase (using resolved config to respect overrides)
    if (resolvedStartPhase?.consensus && resolvedStartPhase.consensus.agent_count >= 2) {
      await this.consensusManager?.startConsensusPhase({
        task: startedTask,
        entrypointAgentId,
        phase: resolvedStartPhase,
        phaseIndex: startPhase,
        totalPhases: phases.length,
      });
      return { processed: 1 };
    }

    const { prompt, noteIds } = this.promptBuilder.buildInitialPromptTracked({
      agent: agentInfo,
      task: { id: startedTask.id, title: startedTask.title, description: startedTask.description ?? undefined },
      phase: phaseInfo,
      isStreaming,
      isResume: resumeSessionId !== null,
    }, entrypointAgentId);

    const usesInlinePrompt = typeDef ? agentTypeUsesInlinePrompt(typeDef) : false;
    // Agents spawn in the orchestrator's cwd (where Claude Code config/hooks live).
    // The task's working_directory is communicated via the prompt and used for worktree creation.
    const workingDir = process.cwd();

    // Set current_task_id BEFORE spawn so the manager can reference it
    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(task.id, entrypointAgentId);

    try {
      await this.agentManager.spawnAgent(entrypointAgentId, {
        workingDir,
        taskId: task.id,
        initialPrompt: usesInlinePrompt ? prompt : undefined,
        sessionId: resumeSessionId ?? undefined,
      });
    } catch (err) {
      this.taskScheduler.failTask(
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
        this.agentManager.sendInput(entrypointAgentId, prompt, closeStdin);
      }
    } catch (err) {
      logError(this.db, "task_startup_send_input", { taskId: task.id, agentId: entrypointAgentId, method: "processTaskQueue" }, err);
      this.taskScheduler.failTask(
        task.id,
        `Failed to send initial prompt: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { processed: 1 };
    }

    this.updateOrchestrationState(task.id, {
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
    this.writeCheckpoint(task.id, "PHASE_START", { phase: startPhase });

    return { processed: 1 };
  }

  getRunningTask(): import("../tasks/scheduler").Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'running' LIMIT 1")
      .get() as Record<string, unknown> | null;

    if (!row) return null;
    return this.taskScheduler.getTask(row.id as string);
  }
}
