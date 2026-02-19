import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { AgentManager } from "./manager";
import { PromptBuilder } from "./prompt-builder";
import type { AgentInfo, PhaseInfo } from "./prompt-builder";
import { TaskScheduler } from "../tasks/scheduler";
import type { Task } from "../tasks/scheduler";
import { TeamManager } from "../teams/manager";
import { getAgentTypeDefinition } from "./types";
import { eventBus } from "../events/bus";
import type { AgentExitEvent } from "../events/bus";

const DAEMON_INTERVAL_MS = 30_000;
const EXIT_GRACE_PERIOD_MS = 1_000;

export class ManagerDaemon {
  private db: Database;
  private agentManager: AgentManager;
  private promptBuilder: PromptBuilder;
  private taskScheduler: TaskScheduler;
  private teamManager: TeamManager;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private exitHandlerRegistered = false;

  constructor(db?: Database) {
    this.db = db ?? getDb();
    this.agentManager = new AgentManager(this.db);
    this.promptBuilder = new PromptBuilder(this.db);
    this.taskScheduler = new TaskScheduler(this.db);
    this.teamManager = new TeamManager(this.db);
    this.registerExitHandler();
  }

  // Expose for testing
  getAgentManager(): AgentManager {
    return this.agentManager;
  }

  getTaskScheduler(): TaskScheduler {
    return this.taskScheduler;
  }

  start(): void {
    if (this.intervalId) return;

    this.tick();
    this.intervalId = setInterval(() => this.tick(), DAEMON_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async tick(): Promise<void> {
    const runId = this.recordDaemonRun();
    let tasksProcessed = 0;
    let agentsChecked = 0;
    const errors: string[] = [];

    try {
      const result = await this.processTaskQueue();
      tasksProcessed = result.processed;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    try {
      agentsChecked = this.agentManager.getRunningAgents().size;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    this.completeDaemonRun(runId, tasksProcessed, agentsChecked, errors);
  }

  async processTaskQueue(): Promise<{ processed: number }> {
    // Check if any task is already running (one at a time)
    const runningTask = this.getRunningTask();
    if (runningTask) {
      return { processed: 0 };
    }

    // Fetch highest-priority approved task
    const task = this.taskScheduler.getNextApprovedTask();
    if (!task) {
      return { processed: 0 };
    }

    // Transition task to running immediately so errors can use failTask
    this.taskScheduler.startTask(task.id);

    // Look up team and entrypoint
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

    // Kill if already running (clean slate)
    if (this.agentManager.getRunningAgent(entrypointAgentId)) {
      this.agentManager.killAgent(entrypointAgentId);
      // Small delay for cleanup
      await new Promise((r) => setTimeout(r, 100));
    }

    // Spawn the entrypoint agent
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

    // Assign task to agent
    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(task.id, entrypointAgentId);

    // Build prompt
    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    const isStreaming = typeDef?.supports_stdin ?? false;

    const agentInfo: AgentInfo = {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      goal: agent.config.goal,
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

    // Send prompt to stdin
    const closeStdin = !isStreaming;
    this.agentManager.sendInput(entrypointAgentId, prompt, closeStdin);

    return { processed: 1 };
  }

  private registerExitHandler(): void {
    if (this.exitHandlerRegistered) return;
    this.exitHandlerRegistered = true;

    eventBus.on("agent:exit", (event: AgentExitEvent) => {
      // Grace period to let stdout processing finish
      setTimeout(() => {
        this.handleAgentExit(event);
      }, EXIT_GRACE_PERIOD_MS);
    });
  }

  private handleAgentExit(event: AgentExitEvent): void {
    // Skip respawn exits
    if (event.isRespawn) return;

    // Skip if delegation system handles it
    if (event.hasDelegation) return;

    try {
      // Find the task this agent was working on
      const agentRow = this.db
        .prepare("SELECT current_task_id FROM agents WHERE id = ?")
        .get(event.agentId) as { current_task_id: string | null } | null;

      if (!agentRow?.current_task_id) return;

      const taskId = agentRow.current_task_id;
      const task = this.taskScheduler.getTask(taskId);
      if (!task || task.status !== "running") return;

      if (event.code === 0) {
        // Exec-mode exit code 0: advance phase or complete task
        this.handleSuccessfulExit(task);
      } else {
        // Non-zero exit: fail the task
        try {
          this.taskScheduler.failTask(taskId, `Agent exited with code ${event.code}`);
        } catch {
          // Task may already be in a terminal state
        }
      }

      // Clear agent's task assignment
      this.db
        .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
        .run(event.agentId);
    } catch {
      // DB may be closed during shutdown
    }
  }

  private handleSuccessfulExit(task: Task): void {
    // Check if there are more phases
    const teamExec = task.team_id
      ? this.teamManager.getTeamForExecution(task.team_id)
      : null;
    const phases = (teamExec?.team.phases as { name: string; prompt: string }[]) ?? [];

    if (phases.length === 0 || task.current_phase >= phases.length - 1) {
      // Last phase or no phases — complete the task
      try {
        this.taskScheduler.completeTask(task.id);
      } catch {
        // Task may already be complete
      }
    } else {
      // More phases — advance and respawn
      this.advanceAndRespawn(task, teamExec!.entrypoint_agent_id, phases);
    }
  }

  private async advanceAndRespawn(
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

    // Get session ID for resume
    const runningAgent = this.agentManager.getRunningAgent(entrypointAgentId);
    const sessionId = runningAgent?.sessionId ?? undefined;

    // Respawn
    try {
      const workingDir = process.cwd();
      await this.agentManager.spawnAgent(entrypointAgentId, { workingDir, sessionId });
    } catch {
      this.taskScheduler.failTask(task.id, "Failed to respawn agent for next phase");
      return;
    }

    // Assign task
    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(task.id, entrypointAgentId);

    // Build next phase prompt
    const agentInfo: AgentInfo = {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      goal: agent.config.goal,
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
    this.agentManager.sendInput(entrypointAgentId, prompt, closeStdin);
  }

  private getRunningTask(): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'running' LIMIT 1")
      .get() as Record<string, unknown> | null;

    if (!row) return null;
    return this.taskScheduler.getTask(row.id as string);
  }

  private recordDaemonRun(): number {
    try {
      const result = this.db
        .prepare("INSERT INTO manager_runs (started_at) VALUES (datetime('now'))")
        .run();
      return Number(result.lastInsertRowid);
    } catch {
      return 0;
    }
  }

  private completeDaemonRun(
    runId: number,
    tasksProcessed: number,
    agentsChecked: number,
    errors: string[],
  ): void {
    if (runId === 0) return;
    try {
      this.db
        .prepare(
          `UPDATE manager_runs
           SET completed_at = datetime('now'),
               tasks_processed = ?,
               agents_checked = ?,
               errors = ?
           WHERE id = ?`,
        )
        .run(tasksProcessed, agentsChecked, JSON.stringify(errors), runId);
    } catch {
      // Ignore DB errors during run completion
    }
  }
}
