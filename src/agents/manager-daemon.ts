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
const MAX_REGRESSIONS = 3;
const MAX_DELEGATION_DEPTH = 3;
const DELEGATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface PendingRegression {
  targetPhase: number;
  reason: string;
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

    try {
      this.checkStaleDelegations();
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
      await new Promise((r) => setTimeout(r, 200));
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
      await new Promise((r) => setTimeout(r, 200));
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
