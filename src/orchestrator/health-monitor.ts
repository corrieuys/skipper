import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { TaskScheduler } from "../tasks/scheduler";
import type { StateTracker } from "../agents/state-tracker";
import { logError } from "../logging";

export class HealthMonitor {
  constructor(
    private readonly db: Database,
    private readonly agentManager: AgentManager,
    private readonly taskScheduler: TaskScheduler,
    private readonly stateTracker: StateTracker,
    private readonly getActiveDelegationForChild: (childAgentId: string) => { id: string } | null,
  ) {}

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
      if (this.agentManager.isRespawning(agent.id)) continue;

      const memTracked = !!this.agentManager.getRunningAgent(agent.id);

      let osAlive = false;
      try {
        process.kill(agent.process_pid, 0);
        osAlive = true;
      } catch (err) {
        logError(this.db, "process_liveness_check", { agentId: agent.id, pid: agent.process_pid }, err);
        osAlive = false;
      }

      if (memTracked && osAlive) {
        continue;
      }

      if (osAlive && !memTracked) {
        try {
          process.kill(agent.process_pid, 9);
        } catch (err) {
          logError(this.db, "orphan_process_kill", { agentId: agent.id, pid: agent.process_pid }, err);
        }
      }

      this.db
        .prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = ?")
        .run(agent.id);

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
            } catch (err) {
              logError(this.db, "health_check_fail_task", { agentId: agent.id, taskId: agent.current_task_id }, err);
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
  runStuckDetection(): void {
    this.stateTracker.updateHeartbeats();

    const candidates = this.stateTracker.getStuckCandidates();
    for (const agentId of candidates) {
      const isStuck = this.stateTracker.analyzeStuckAgent(agentId);
      if (isStuck) {
        this.stateTracker.handleStuckAgent(agentId);
      }
    }
  }
}
