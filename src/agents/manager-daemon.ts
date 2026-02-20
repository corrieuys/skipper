import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { AgentManager } from "./manager";
import { PromptBuilder } from "./prompt-builder";
import type { AgentInfo, PhaseInfo } from "./prompt-builder";
import { TaskScheduler } from "../tasks/scheduler";
import type { Task } from "../tasks/scheduler";
import { TeamManager } from "../teams/manager";
import { StateTracker } from "./state-tracker";
import { getAgentTypeDefinition } from "./types";
import { eventBus } from "../events/bus";
import type { AgentExitEvent } from "../events/bus";

const DAEMON_INTERVAL_MS = 30_000;
const STREAMS_DRAIN_TIMEOUT_MS = 5_000;
const MAX_REGRESSIONS = 3;
const MAX_DELEGATION_DEPTH = 3;
const DELEGATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const STUCK_HEARTBEAT_MS = 5 * 60 * 1000; // 5 minutes

interface PendingRegression {
  targetPhase: number;
  reason: string;
}

export interface OrchestrationState {
  step: "AGENT_RUNNING" | "WAITING_DELEGATION" | "ADVANCING_PHASE" | "REGRESSION" | "IDLE";
  last_checkpoint_ts: string | null;
  session_id: string | null;
  active_delegation_id: string | null;
  phase_guards: string[];
  pending_regression: PendingRegression | null;
  checkpoint_prompt_hash: string | null;
}

export interface TaskCheckpoint {
  id: number;
  task_id: string;
  sequence: number;
  checkpoint_type: string;
  session_id: string | null;
  context_snapshot: Record<string, unknown>;
  terminal_seq: number | null;
  created_at: string;
}

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

export class ManagerDaemon {
  private db: Database;
  private agentManager: AgentManager;
  private promptBuilder: PromptBuilder;
  private taskScheduler: TaskScheduler;
  private teamManager: TeamManager;
  private stateTracker: StateTracker;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private exitHandlerRegistered = false;
  private phaseCompleteHandled: Set<string> = new Set(); // "taskId:phase" dedup
  private pendingRegressions: Map<string, PendingRegression> = new Map(); // agentId -> regression

  constructor(db?: Database) {
    this.db = db ?? getDb();
    this.agentManager = new AgentManager(this.db);
    this.promptBuilder = new PromptBuilder(this.db);
    this.taskScheduler = new TaskScheduler(this.db);
    this.teamManager = new TeamManager(this.db);
    this.stateTracker = new StateTracker(this.db, this.agentManager);
    this.registerExitHandler();
  }

  // Expose for testing
  getAgentManager(): AgentManager {
    return this.agentManager;
  }

  getTaskScheduler(): TaskScheduler {
    return this.taskScheduler;
  }

  getStateTracker(): StateTracker {
    return this.stateTracker;
  }

  start(): void {
    if (this.intervalId) return;

    this.cleanupStaleState();
    this.tick();
    this.intervalId = setInterval(() => this.tick(), DAEMON_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getStatus(): { state: "running" | "paused" | "stopped"; uptime: number } {
    const state = this.intervalId ? "running" : "stopped";
    return { state, uptime: process.uptime() };
  }

  pause(): void {
    // Stub: full cooperative pause will be implemented in STORY-R03
    this.stop();
  }

  resume(): void {
    // Stub: full cooperative resume will be implemented in STORY-R03
    this.start();
  }

  async tick(): Promise<void> {
    const runId = this.recordDaemonRun();
    let tasksProcessed = 0;
    let agentsChecked = 0;
    const errors: string[] = [];

    // 1. Recover stale tasks (running tasks with no live agent)
    try {
      await this.recoverAllStaleTasks();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    // 2. Process task queue (pick up new approved tasks)
    try {
      const result = await this.processTaskQueue();
      tasksProcessed = result.processed;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    // 3. Check stale delegations
    try {
      this.checkStaleDelegations();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    // 4. Check agent count
    try {
      agentsChecked = this.agentManager.getRunningAgents().size;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    // 5. Persist checkpoints for running tasks
    try {
      this.persistCheckpoints();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    try {
      this.checkProcessHealth();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    try {
      this.runStuckDetection();
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
      await this.agentManager.waitForExit(entrypointAgentId);
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

    // Persist orchestration state and checkpoint
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

  // --- Health checks ---

  /**
   * For every agent that has a recorded PID:
   * - Skip agents currently being respawned.
   * - Check both in-memory tracking AND OS liveness (process.kill(pid, 0)).
   * - Kill OS-level orphan processes (have a PID but are not tracked in memory).
   * - Clean up DB state for dead agents.
   * - Fail any running task owned by a dead agent, unless it has an active
   *   child delegation (in which case the child result will arrive later).
   */
  checkProcessHealth(): void {
    const agentRows = this.db
      .prepare("SELECT id, process_pid, current_task_id FROM agents WHERE process_pid IS NOT NULL")
      .all() as { id: string; process_pid: number; current_task_id: string | null }[];

    for (const agent of agentRows) {
      // Skip agents that are mid-respawn — they will be healthy once the new
      // process has been spawned.
      if (this.agentManager.isRespawning(agent.id)) continue;

      const memTracked = !!this.agentManager.getRunningAgent(agent.id);

      let osAlive = false;
      try {
        process.kill(agent.process_pid, 0);
        osAlive = true;
      } catch {
        osAlive = false;
      }

      if (memTracked && osAlive) {
        // Healthy — nothing to do
        continue;
      }

      // Orphan or dead process — clean up

      // If the OS process exists but is not tracked in memory, it is an
      // orphan left over from a previous daemon run. Kill it.
      if (osAlive && !memTracked) {
        try {
          process.kill(agent.process_pid, 9);
        } catch {
          // Already exited between the liveness check and the kill attempt
        }
      }

      // Clear PID / status in DB
      this.db
        .prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = ?")
        .run(agent.id);

      // Fail the running task if the agent had one, unless a child delegation
      // is still active (the child may still deliver a result).
      if (agent.current_task_id) {
        const task = this.taskScheduler.getTask(agent.current_task_id);
        if (task && task.status === "running") {
          const activeDelegation = this.getActiveDelegationForChild(agent.id);
          if (!activeDelegation) {
            try {
              this.taskScheduler.failTask(
                agent.current_task_id,
                "Agent process died unexpectedly",
              );
            } catch {
              // Task may already be in a terminal state
            }
            this.db
              .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
              .run(agent.id);
          }
        }
      }
    }
  }

  /**
   * Update terminal-output fingerprints / heartbeats for all active agents,
   * then detect and handle any that appear stuck.
   */
  private runStuckDetection(): void {
    this.stateTracker.updateHeartbeats();

    const candidates = this.stateTracker.getStuckCandidates();
    for (const agentId of candidates) {
      const isStuck = this.stateTracker.analyzeStuckAgent(agentId);
      if (isStuck) {
        this.stateTracker.handleStuckAgent(agentId);
      }
    }
  }

  private registerExitHandler(): void {
    if (this.exitHandlerRegistered) return;
    this.exitHandlerRegistered = true;

    eventBus.on("agent:exit", (event: AgentExitEvent) => {
      // Wait for streams to finish draining, then handle exit
      this.agentManager.waitForStreamsDrained(event.agentId, STREAMS_DRAIN_TIMEOUT_MS)
        .then(() => this.handleAgentExit(event));
    });
  }

  private handleAgentExit(event: AgentExitEvent): void {
    // Skip respawn exits
    if (event.isRespawn) return;

    // Skip if delegation system handles it
    if (event.hasDelegation) return;

    try {
      // Check if this agent is a child in an active delegation
      const activeDelegation = this.getActiveDelegationForChild(event.agentId);
      if (activeDelegation) {
        this.handleChildExit(activeDelegation, event);
        return;
      }

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
        this.handleSuccessfulExit(task, event.agentId);
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

  private handleSuccessfulExit(task: Task, agentId: string): void {
    // Check for pending regression (exec-mode agents)
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
        );
      }
      return;
    }

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

    // Update orchestration state and checkpoint
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

  // --- Delegation Management ---

  async handleDelegation(
    parentAgentId: string,
    childAgentId: string,
    delegationPrompt: string,
  ): Promise<Delegation | null> {
    // 1. Validate parent has an active task
    const parentRow = this.db
      .prepare("SELECT current_task_id FROM agents WHERE id = ?")
      .get(parentAgentId) as { current_task_id: string | null } | null;

    if (!parentRow?.current_task_id) return null;

    const taskId = parentRow.current_task_id;
    const task = this.taskScheduler.getTask(taskId);
    if (!task || task.status !== "running") return null;

    // 2. Check parent supports receiving results (stdin or resume)
    const parentAgent = this.agentManager.getAgent(parentAgentId);
    if (!parentAgent) return null;
    const parentTypeDef = getAgentTypeDefinition(parentAgent.type, this.db);
    if (!parentTypeDef || (!parentTypeDef.supports_stdin && !parentTypeDef.supports_resume)) {
      return null;
    }

    // 3. Validate child exists
    const childAgent = this.agentManager.getAgent(childAgentId);
    if (!childAgent) return null;

    // 4. Validate both in same team
    if (!this.agentsInSameTeam(parentAgentId, childAgentId)) return null;

    // 5. Check delegation depth (max 3)
    const depth = this.getDelegationDepth(parentAgentId, taskId);
    if (depth >= MAX_DELEGATION_DEPTH) return null;

    // 6. Check no active delegation for this parent
    const existingDelegation = this.getActiveDelegationForParent(parentAgentId);
    if (existingDelegation) return null;

    // 7. Create delegation record
    const delegationId = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO delegations (id, parent_agent_id, child_agent_id, task_id, prompt, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
      )
      .run(delegationId, parentAgentId, childAgentId, taskId, delegationPrompt);

    // 8. Kill child if running, spawn fresh
    if (this.agentManager.getRunningAgent(childAgentId)) {
      this.agentManager.killAgent(childAgentId);
      await this.agentManager.waitForExit(childAgentId);
    }

    try {
      const workingDir = process.cwd();
      await this.agentManager.spawnAgent(childAgentId, { workingDir });
    } catch {
      this.db
        .prepare("UPDATE delegations SET status = 'failed', completed_at = datetime('now') WHERE id = ?")
        .run(delegationId);
      return null;
    }

    // 9. Assign same task to child
    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(taskId, childAgentId);

    // 10. Build delegation prompt
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

    // 11. Send prompt to child
    const closeStdin = !isStreaming;
    this.agentManager.sendInput(childAgentId, prompt, closeStdin);

    // 12. Update delegation to running
    this.db
      .prepare("UPDATE delegations SET status = 'running' WHERE id = ?")
      .run(delegationId);

    // 13. Notify parent
    try {
      this.agentManager.sendInput(
        parentAgentId,
        `[SYSTEM] Delegated to agent ${childAgentId}. Waiting for results...`,
      );
    } catch {
      // Parent may not have open stdin
    }

    // 14. Set parent state to waiting_delegation
    this.setAgentState(parentAgentId, "waiting_delegation", { delegation_id: delegationId });

    // 15. Update orchestration state
    this.updateOrchestrationState(taskId, {
      step: "WAITING_DELEGATION",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: this.agentManager.getSessionId(parentAgentId),
      active_delegation_id: delegationId,
      phase_guards: Array.from(this.phaseCompleteHandled).filter((k) => k.startsWith(`${taskId}:`)),
      pending_regression: null,
      checkpoint_prompt_hash: null,
    });

    return this.getDelegation(delegationId);
  }

  handleDelegateComplete(childAgentId: string, result: string): void {
    try {
      const delegation = this.getActiveDelegationForChild(childAgentId);
      if (!delegation) return;

      // Update delegation record
      this.db
        .prepare(
          "UPDATE delegations SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?",
        )
        .run(result, delegation.id);

      // Kill child agent
      this.agentManager.killAgent(childAgentId);

      // Clear child task assignment
      this.db
        .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
        .run(childAgentId);

      // Route result to parent
      this.routeResultToParent(delegation.parent_agent_id, childAgentId, result);

      // Reset parent state to working
      this.setAgentState(delegation.parent_agent_id, "working");

      // Update orchestration state and write checkpoint
      this.updateOrchestrationState(delegation.task_id, {
        step: "AGENT_RUNNING",
        last_checkpoint_ts: new Date().toISOString(),
        session_id: this.agentManager.getSessionId(delegation.parent_agent_id),
        active_delegation_id: null,
        phase_guards: Array.from(this.phaseCompleteHandled).filter((k) => k.startsWith(`${delegation.task_id}:`)),
        pending_regression: null,
        checkpoint_prompt_hash: null,
      });
      this.writeCheckpoint(delegation.task_id, "DELEGATION_COMPLETE", {
        delegation_id: delegation.id,
        child_agent_id: childAgentId,
      });
    } catch {
      // DB may be closed during shutdown
    }
  }

  private handleChildExit(delegation: Delegation, event: AgentExitEvent): void {
    try {
      if (event.code === 0) {
        // Gather terminal output as result
        const result = this.gatherTerminalOutput(event.agentId);

        // Update delegation
        this.db
          .prepare(
            "UPDATE delegations SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?",
          )
          .run(result, delegation.id);

        // Clear child task assignment
        this.db
          .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
          .run(event.agentId);

        // Route result to parent
        this.routeResultToParent(delegation.parent_agent_id, event.agentId, result);

        // Reset parent state
        this.setAgentState(delegation.parent_agent_id, "working");
      } else {
        // Child failed
        this.db
          .prepare(
            "UPDATE delegations SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?",
          )
          .run(`Child agent exited with code ${event.code}`, delegation.id);

        // Clear child task assignment
        this.db
          .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
          .run(event.agentId);

        // Notify parent of failure
        this.routeResultToParent(
          delegation.parent_agent_id,
          event.agentId,
          `[DELEGATION_FAILED] Agent exited with code ${event.code}`,
        );

        // Reset parent state
        this.setAgentState(delegation.parent_agent_id, "working");
      }
    } catch {
      // DB may be closed during shutdown
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
        // Fail the delegation
        this.db
          .prepare(
            "UPDATE delegations SET status = 'failed', result = 'Delegation timed out', completed_at = datetime('now') WHERE id = ?",
          )
          .run(delegation.id);

        // Kill child agent
        this.agentManager.killAgent(delegation.child_agent_id);

        // Clear child task assignment
        this.db
          .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ?")
          .run(delegation.child_agent_id);

        // Notify parent
        this.routeResultToParent(
          delegation.parent_agent_id,
          delegation.child_agent_id,
          `[DELEGATION_FAILED] Delegation timed out after 10 minutes`,
        );

        // Reset parent state
        this.setAgentState(delegation.parent_agent_id, "working");
      } catch {
        // Ignore individual delegation timeout errors
      }
    }

    return stale.length;
  }

  private routeResultToParent(
    parentAgentId: string,
    childAgentId: string,
    result: string,
  ): void {
    const message = `[DELEGATION_RESULT from:${childAgentId}]\n${result}\n[END_DELEGATION_RESULT]`;

    // Try stdin first (parent still running with open stdin)
    const runningParent = this.agentManager.getRunningAgent(parentAgentId);
    if (runningParent) {
      try {
        this.agentManager.sendInput(parentAgentId, message);
        return;
      } catch {
        // Stdin may be closed
      }
    }

    // Try resume (parent supports --resume)
    const parentAgent = this.agentManager.getAgent(parentAgentId);
    if (!parentAgent) return;

    const typeDef = getAgentTypeDefinition(parentAgent.type, this.db);
    if (typeDef?.supports_resume) {
      this.agentManager.sendResumeMessage(parentAgentId, message).catch(() => {
        // Resume failed — result lost
      });
    }
  }

  private gatherTerminalOutput(agentId: string): string {
    try {
      const rows = this.db
        .prepare(
          "SELECT data FROM terminal_outputs WHERE agent_id = ? AND stream = 'stdout' ORDER BY sequence",
        )
        .all(agentId) as { data: string }[];
      return rows.map((r) => r.data).join("");
    } catch {
      return "";
    }
  }

  getDelegation(id: string): Delegation | null {
    try {
      const row = this.db
        .prepare("SELECT * FROM delegations WHERE id = ?")
        .get(id) as Delegation | null;
      return row ?? null;
    } catch {
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
    } catch {
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
    } catch {
      return null;
    }
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

  private getDelegationDepth(agentId: string, taskId: string): number {
    // Use recursive CTE to find delegation chain depth
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

  private setAgentState(
    agentId: string,
    state: string,
    metadata?: Record<string, unknown>,
  ): void {
    try {
      const metadataJson = metadata ? JSON.stringify(metadata) : "{}";
      this.db
        .prepare(
          `INSERT INTO agent_states (agent_id, state, state_metadata)
           VALUES (?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             state = ?,
             state_metadata = ?,
             updated_at = datetime('now')`,
        )
        .run(agentId, state, metadataJson, state, metadataJson);

      eventBus.emit("agent:state_changed", {
        agentId,
        previousState: "",
        newState: state,
      });
    } catch {
      // Ignore state update errors
    }
  }

  // --- Phase Management ---

  handlePhaseComplete(agentId: string): void {
    // Find the task this agent is working on
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
      // Last phase or no phases — complete the task
      try {
        this.taskScheduler.completeTask(task.id);
      } catch {
        // Task may already be complete
      }
    } else {
      // More phases — advance and send next prompt
      const advanced = this.taskScheduler.advancePhase(task.id);
      const nextPhase = advanced.current_phase;
      const entrypointAgentId = teamExec!.entrypoint_agent_id;

      const agent = this.agentManager.getAgent(entrypointAgentId);
      if (!agent) return;

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

      const typeDef = getAgentTypeDefinition(agent.type, this.db);
      const isStreaming = typeDef?.supports_stdin ?? false;

      const prompt = this.promptBuilder.buildInitialPrompt({
        agent: agentInfo,
        task: { id: task.id, title: task.title, description: task.description ?? undefined },
        phase: phaseInfo,
        isStreaming,
      });

      // For streaming agents, send directly to existing stdin
      this.agentManager.sendInput(entrypointAgentId, prompt);

      // Persist phase advance checkpoint
      this.writeCheckpoint(task.id, "PHASE_START", { phase: nextPhase });
    }
  }

  handlePhaseRegression(agentId: string, targetPhaseOneIndexed: number, reason: string): void {
    // Find the task this agent is working on
    const agentRow = this.db
      .prepare("SELECT current_task_id FROM agents WHERE id = ?")
      .get(agentId) as { current_task_id: string | null } | null;

    if (!agentRow?.current_task_id) return;

    const taskId = agentRow.current_task_id;
    const task = this.taskScheduler.getTask(taskId);
    if (!task || task.status !== "running") return;

    // Convert 1-indexed to 0-indexed
    const targetPhase = targetPhaseOneIndexed - 1;

    // Validate target phase
    if (targetPhase < 0 || targetPhase >= task.current_phase) return;

    // Record regression in audit table
    this.recordPhaseRegression(taskId, agentId, task.current_phase, targetPhase, reason);

    // Store reason as task note for future agents
    try {
      const noteId = crypto.randomUUID();
      this.db
        .prepare(
          "INSERT INTO task_notes (id, task_id, agent_id, content) VALUES (?, ?, ?, ?)",
        )
        .run(noteId, taskId, agentId, `[PHASE REGRESSION to phase ${targetPhaseOneIndexed}] ${reason}`);
    } catch {
      // Ignore note creation errors
    }

    // Check regression limit
    if (task.regression_count >= MAX_REGRESSIONS) {
      this.autoEscalateRegression(task, agentId, reason);
      return;
    }

    // Perform the regression
    this.taskScheduler.regressPhase(taskId, targetPhase);

    // Clear phase dedup guards for target phase and all later phases
    for (let i = targetPhase; i <= task.current_phase; i++) {
      this.phaseCompleteHandled.delete(`${taskId}:${i}`);
    }

    // Write regression checkpoint
    this.writeCheckpoint(taskId, "REGRESSION", {
      from_phase: task.current_phase,
      to_phase: targetPhase,
      reason,
    });

    // Get team and phases
    const teamExec = task.team_id
      ? this.teamManager.getTeamForExecution(task.team_id)
      : null;
    if (!teamExec) return;
    const phases = (teamExec.team.phases as { name: string; prompt: string }[]) ?? [];

    // Check if agent is streaming or exec-mode
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) return;
    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    const isStreaming = typeDef?.supports_stdin ?? false;

    if (isStreaming) {
      // Streaming agent: respawn immediately
      this.respawnForRegression(task, teamExec.entrypoint_agent_id, phases, targetPhase, reason);
    } else {
      // Exec-mode agent: store pending regression for exit handler
      this.pendingRegressions.set(agentId, { targetPhase, reason });
    }
  }

  private async respawnForRegression(
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

    // Get session ID for resume before killing
    const sessionId = this.agentManager.getSessionId(entrypointAgentId) ?? undefined;

    // Kill current process if running
    if (this.agentManager.getRunningAgent(entrypointAgentId)) {
      this.agentManager.killAgent(entrypointAgentId);
      await this.agentManager.waitForExit(entrypointAgentId);
    }

    // Spawn fresh (with resume if supported)
    try {
      const workingDir = process.cwd();
      await this.agentManager.spawnAgent(entrypointAgentId, { workingDir, sessionId });
    } catch {
      try {
        this.taskScheduler.failTask(task.id, "Failed to respawn agent for regression");
      } catch {
        // DB may be closed during shutdown
      }
      return;
    }

    // Assign task
    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(task.id, entrypointAgentId);

    // Build phase prompt with regression context
    const agentInfo: AgentInfo = {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      goal: agent.config.goal,
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
    this.agentManager.sendInput(entrypointAgentId, prompt, closeStdin);
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
    } catch {
      // Ignore escalation creation errors
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
    } catch {
      // Ignore audit logging errors
    }
  }

  // Expose for testing
  getPendingRegression(agentId: string): PendingRegression | undefined {
    return this.pendingRegressions.get(agentId);
  }

  getPhaseCompleteHandled(): Set<string> {
    return this.phaseCompleteHandled;
  }

  // --- Recovery & Resilience ---

  cleanupStaleState(): void {
    try {
      // 1. Kill stale OS processes for agents that have PIDs but aren't tracked in memory
      const agentsWithPids = this.db
        .prepare("SELECT id, process_pid FROM agents WHERE process_pid IS NOT NULL")
        .all() as { id: string; process_pid: number }[];

      for (const row of agentsWithPids) {
        const inMemory = this.agentManager.getRunningAgent(row.id);
        if (!inMemory) {
          // Agent has PID in DB but not tracked in memory — kill orphan
          try {
            process.kill(row.process_pid, 0); // Check if alive
            process.kill(row.process_pid, 9); // Kill it
          } catch {
            // Process already dead — that's fine
          }

          // Clear PID and reset status
          this.db
            .prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = ?")
            .run(row.id);
        }
      }

      // 2. Clean up dead agents (tracked in memory but process no longer alive)
      for (const [agentId, running] of this.agentManager.getRunningAgents()) {
        try {
          process.kill(running.process.pid, 0); // Check alive
        } catch {
          // Process is dead — clean up
          this.agentManager.getRunningAgents().delete(agentId);
          this.db
            .prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = ?")
            .run(agentId);
        }
      }

      // 3. Clear task assignments for agents with no live process
      this.db
        .prepare(
          `UPDATE agents SET current_task_id = NULL
           WHERE current_task_id IS NOT NULL
           AND process_pid IS NULL
           AND id NOT IN (SELECT id FROM agents WHERE process_pid IS NOT NULL)`,
        )
        .run();
    } catch {
      // Ignore cleanup errors on startup
    }
  }

  async recoverAllStaleTasks(): Promise<number> {
    let recovered = 0;

    try {
      // Find running tasks
      const runningTasks = this.db
        .prepare("SELECT * FROM tasks WHERE status = 'running'")
        .all() as Array<Record<string, unknown>>;

      for (const row of runningTasks) {
        const taskId = row.id as string;
        const task = this.taskScheduler.getTask(taskId);
        if (!task) continue;

        // Check if there's a live agent working on this task
        const assignedAgent = this.db
          .prepare("SELECT id, process_pid FROM agents WHERE current_task_id = ?")
          .get(taskId) as { id: string; process_pid: number | null } | null;

        if (!assignedAgent) {
          // No agent assigned — need to recover
          const didRecover = await this.recoverTask(taskId);
          if (didRecover) recovered++;
          continue;
        }

        // Agent is assigned — check if it's actually alive
        const inMemory = this.agentManager.getRunningAgent(assignedAgent.id);
        if (inMemory) continue; // Agent is alive and tracked

        if (assignedAgent.process_pid) {
          try {
            process.kill(assignedAgent.process_pid, 0); // Check alive
            continue; // Still alive, skip
          } catch {
            // Process is dead
          }
        }

        // Agent is dead — check for active child delegations before recovering
        const activeDelegation = this.getActiveDelegationForParent(assignedAgent.id);
        if (activeDelegation) {
          // Parent is waiting for delegation — check if child is alive
          const childRunning = this.agentManager.getRunningAgent(activeDelegation.child_agent_id);
          if (childRunning) continue; // Child still working, skip recovery
        }

        // Agent is dead with no active child — recover the task
        const didRecover = await this.recoverTask(taskId);
        if (didRecover) recovered++;
      }
    } catch {
      // Ignore recovery errors
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

    // Load orchestration state
    const orchState = task.orchestration_state as Partial<OrchestrationState>;

    // Load latest checkpoint
    const checkpoint = this.getLatestCheckpoint(taskId);

    // Restore in-memory structures from orchestration state
    if (orchState.phase_guards) {
      for (const guard of orchState.phase_guards) {
        this.phaseCompleteHandled.add(guard);
      }
    }
    if (orchState.pending_regression) {
      this.pendingRegressions.set(entrypointAgentId, orchState.pending_regression);
    }

    // Restore active delegation state
    if (orchState.active_delegation_id) {
      const delegation = this.getDelegation(orchState.active_delegation_id);
      if (delegation && (delegation.status === "pending" || delegation.status === "running")) {
        // Delegation still active — set parent state and skip respawn
        this.setAgentState(entrypointAgentId, "waiting_delegation", {
          delegation_id: orchState.active_delegation_id,
        });
        return true;
      }
    }

    // Determine resume vs full respawn
    const sessionId =
      orchState.session_id ??
      (checkpoint?.session_id || null) ??
      this.agentManager.getSessionId(entrypointAgentId);

    const canResume = typeDef.supports_resume && !!sessionId;

    // Kill existing process if any
    if (this.agentManager.getRunningAgent(entrypointAgentId)) {
      this.agentManager.killAgent(entrypointAgentId);
      await this.agentManager.waitForExit(entrypointAgentId);
    }

    // Spawn agent
    try {
      const workingDir = process.cwd();
      const spawnOpts = canResume
        ? { workingDir, sessionId: sessionId! }
        : { workingDir };
      await this.agentManager.spawnAgent(entrypointAgentId, spawnOpts);
    } catch {
      return false;
    }

    // Assign task
    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(taskId, entrypointAgentId);

    // Build recovery prompt
    const isStreaming = typeDef.supports_stdin ?? false;
    const phases = (teamExec.team.phases as { name: string; prompt: string }[]) ?? [];
    const currentPhase = task.current_phase;

    const agentInfo: AgentInfo = {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      goal: agent.config.goal,
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

    // Check for pending regression context
    const pendingReg = this.pendingRegressions.get(entrypointAgentId);

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

    // Update orchestration state
    this.updateOrchestrationState(taskId, {
      step: "AGENT_RUNNING",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: canResume ? sessionId : null,
      active_delegation_id: null,
      phase_guards: Array.from(this.phaseCompleteHandled).filter((k) => k.startsWith(`${taskId}:`)),
      pending_regression: pendingReg ?? null,
      checkpoint_prompt_hash: null,
    });

    return true;
  }

  // --- Orchestration State & Checkpoints ---

  updateOrchestrationState(taskId: string, state: OrchestrationState): void {
    try {
      this.db
        .prepare(
          "UPDATE tasks SET orchestration_state = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(JSON.stringify(state), taskId);
    } catch {
      // Ignore state update errors
    }
  }

  getOrchestrationState(taskId: string): OrchestrationState | null {
    try {
      const row = this.db
        .prepare("SELECT orchestration_state FROM tasks WHERE id = ?")
        .get(taskId) as { orchestration_state: string } | null;
      if (!row) return null;
      const parsed = JSON.parse(row.orchestration_state);
      // Return null for empty/default state
      if (!parsed.step) return null;
      return parsed as OrchestrationState;
    } catch {
      return null;
    }
  }

  writeCheckpoint(
    taskId: string,
    checkpointType: string,
    contextSnapshot: Record<string, unknown> = {},
  ): void {
    try {
      // Get next sequence number
      const seqRow = this.db
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq FROM task_checkpoints WHERE task_id = ?",
        )
        .get(taskId) as { next_seq: number };

      // Get current session ID from agent if available
      const agentRow = this.db
        .prepare("SELECT id FROM agents WHERE current_task_id = ?")
        .get(taskId) as { id: string } | null;
      const sessionId = agentRow
        ? this.agentManager.getSessionId(agentRow.id)
        : null;

      // Get latest terminal sequence
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
    } catch {
      // Ignore checkpoint errors
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
    } catch {
      return null;
    }
  }

  private persistCheckpoints(): void {
    // Persist periodic checkpoints for any running task
    const runningTask = this.getRunningTask();
    if (!runningTask) return;

    // Update orchestration state with current in-memory structures
    const agentRow = this.db
      .prepare("SELECT id FROM agents WHERE current_task_id = ?")
      .get(runningTask.id) as { id: string } | null;

    if (!agentRow) return;

    const sessionId = this.agentManager.getSessionId(agentRow.id);
    const activeDelegation = this.getActiveDelegationForParent(agentRow.id);
    const pendingReg = this.pendingRegressions.get(agentRow.id);

    const state: OrchestrationState = {
      step: activeDelegation ? "WAITING_DELEGATION" : "AGENT_RUNNING",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: sessionId,
      active_delegation_id: activeDelegation?.id ?? null,
      phase_guards: Array.from(this.phaseCompleteHandled).filter((k) =>
        k.startsWith(`${runningTask.id}:`),
      ),
      pending_regression: pendingReg ?? null,
      checkpoint_prompt_hash: null,
    };

    this.updateOrchestrationState(runningTask.id, state);
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
