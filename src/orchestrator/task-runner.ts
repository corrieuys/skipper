import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { PromptBuilder, AgentInfo, PhaseInfo } from "../agents/prompt-builder";
import type { TaskScheduler } from "../tasks/scheduler";
import type { TeamManager } from "../teams/manager";
import { getAgentTypeDefinition } from "../agents/types";
import type { OrchestrationState } from "./types";

export class TaskRunner {
  constructor(
    private readonly db: Database,
    private readonly agentManager: AgentManager,
    private readonly promptBuilder: PromptBuilder,
    private readonly taskScheduler: TaskScheduler,
    private readonly teamManager: TeamManager,
    private readonly updateOrchestrationState: (taskId: string, state: OrchestrationState) => void,
    private readonly writeCheckpoint: (taskId: string, type: string, snapshot?: Record<string, unknown>) => void,
  ) {}

  async processTaskQueue(): Promise<{ processed: number }> {
    const runningTask = this.getRunningTask();
    if (runningTask) {
      return { processed: 0 };
    }

    const task = this.taskScheduler.getNextApprovedTask();
    if (!task) {
      return { processed: 0 };
    }

    this.taskScheduler.startTask(task.id);

    if (!task.team_id) {
      this.taskScheduler.failTask(task.id, "Task has no team assigned");
      return { processed: 1 };
    }

    const teamExec = this.teamManager.getTeamForExecution(task.team_id);
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

    if (this.agentManager.getRunningAgent(entrypointAgentId)) {
      this.agentManager.killAgent(entrypointAgentId);
      await this.agentManager.waitForExit(entrypointAgentId);
    }

    try {
      const workingDir = process.cwd();
      await this.agentManager.spawnAgent(entrypointAgentId, { workingDir });
    } catch (err) {
      this.taskScheduler.failTask(
        task.id,
        `Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { processed: 1 };
    }

    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(task.id, entrypointAgentId);

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    const isStreaming = typeDef?.supports_stdin ?? false;

    const agentInfo: AgentInfo = {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      instruction: agent.config.instruction,
    };

    const phases = teamExec.team.phases as { name: string; prompt: string }[];
    let phaseInfo: PhaseInfo | undefined;
    if (phases.length > 0) {
      phaseInfo = {
        name: phases[0].name,
        prompt: phases[0].prompt,
        index: 0,
        total: phases.length,
      };
    }

    const prompt = this.promptBuilder.buildInitialPrompt({
      agent: agentInfo,
      task: { id: task.id, title: task.title, description: task.description ?? undefined },
      phase: phaseInfo,
      isStreaming,
    });

    const closeStdin = !isStreaming;
    this.agentManager.sendInput(entrypointAgentId, prompt, closeStdin);

    this.updateOrchestrationState(task.id, {
      step: "AGENT_RUNNING",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: null,
      active_delegation_id: null,
      phase_guards: [],
      pending_regression: null,
      checkpoint_prompt_hash: null,
    });
    this.writeCheckpoint(task.id, "PHASE_START", { phase: 0 });

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
