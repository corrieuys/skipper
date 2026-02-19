import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { TaskScheduler } from "../tasks/scheduler";
import type { StateTracker } from "../agents/state-tracker";
import { logError } from "../logging";
import { eventBus } from "../events/bus";

const EXIT_CODE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const EXIT_CODE_CLUSTER_THRESHOLD = 3;

interface ExitCodeEntry {
  agentId: string;
  code: number;
  timestamp: number;
}

export interface WhyStuckDiagnostic {
  taskId: string;
  taskStatus: string;
  orchestrationStep: string | null;
  assignedAgent: { id: string; pid: number | null; status: string } | null;
  liveInstances: Array<{ id: string; status: string; pid: number | null }>;
  activeDelegations: Array<{ id: string; status: string; childInstanceId: string | null }>;
  openEscalations: Array<{ id: string; question: string }>;
  recentErrors: Array<{ category: string; message: string; created_at: string }>;
  likely_reasons: string[];
}

export class HealthMonitor {
  private exitCodeWindow: ExitCodeEntry[] = [];

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
      const directRuntime = this.agentManager.getRunningAgent(agent.id);
      const pidTrackedRuntime = this.findRunningRuntimeByPid(agent.process_pid);
      const memTracked = !!directRuntime || !!pidTrackedRuntime;

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
   * Check agent_instances rows with non-null PIDs for liveness.
   * Kills orphan processes and cleans up DB state for dead instances.
   */
  checkInstanceProcessHealth(): void {
    const instances = this.db
      .prepare(
        "SELECT id, template_agent_id, process_pid, task_id, status FROM agent_instances WHERE process_pid IS NOT NULL AND status IN ('running', 'waiting_delegation')",
      )
      .all() as Array<{ id: string; template_agent_id: string; process_pid: number; task_id: string; status: string }>;

    for (const inst of instances) {
      const memTracked = !!this.agentManager.getRunningAgent(inst.id);

      let osAlive = false;
      try {
        process.kill(inst.process_pid, 0);
        osAlive = true;
      } catch {
        osAlive = false;
      }

      if (memTracked && osAlive) continue;

      if (osAlive && !memTracked) {
        try {
          process.kill(inst.process_pid, 9);
        } catch (err) {
          logError(this.db, "instance_orphan_kill", { instanceId: inst.id, pid: inst.process_pid }, err);
        }
      }

      this.db
        .prepare("UPDATE agent_instances SET status = 'failed', process_pid = NULL, updated_at = datetime('now') WHERE id = ?")
        .run(inst.id);

      this.emitRemediationEvent("instance_process_dead", inst.template_agent_id, inst.task_id, {
        instanceId: inst.id,
        pid: inst.process_pid,
      });
    }
  }

  /**
   * Find instances in waiting_delegation status with no live children.
   * Force-fail orphaned delegation groups and emit remediation events.
   */
  checkDelegationOrphans(): void {
    const waitingInstances = this.db
      .prepare(
        "SELECT id, template_agent_id, task_id FROM agent_instances WHERE status = 'waiting_delegation'",
      )
      .all() as Array<{ id: string; template_agent_id: string; task_id: string }>;

    for (const inst of waitingInstances) {
      const childDelegations = this.db
        .prepare(
          "SELECT id, child_instance_id, delegation_group_id FROM delegations WHERE parent_instance_id = ? AND status IN ('pending', 'running')",
        )
        .all(inst.id) as Array<{ id: string; child_instance_id: string | null; delegation_group_id: string | null }>;

      if (childDelegations.length === 0) {
        // No delegation records at all — orphaned waiting state
        this.db
          .prepare("UPDATE agent_instances SET status = 'failed', updated_at = datetime('now') WHERE id = ?")
          .run(inst.id);
        this.emitRemediationEvent("waiting_delegation_no_children", inst.template_agent_id, inst.task_id, {
          instanceId: inst.id,
        });
        continue;
      }

      // Check if any child has a live runtime
      let anyLiveChild = false;
      for (const del of childDelegations) {
        if (del.child_instance_id) {
          const childRunning = this.agentManager.getRunningAgent(del.child_instance_id);
          if (childRunning) {
            anyLiveChild = true;
            break;
          }
        }
      }

      if (!anyLiveChild) {
        // Force-fail all pending/running delegations
        for (const del of childDelegations) {
          this.db
            .prepare(
              "UPDATE delegations SET status = 'failed', result = 'Child process died (orphan cleanup)', completed_at = datetime('now') WHERE id = ?",
            )
            .run(del.id);
        }

        // Complete any running delegation groups
        const groupIds = new Set(childDelegations.map((d) => d.delegation_group_id).filter(Boolean) as string[]);
        for (const groupId of groupIds) {
          this.db
            .prepare(
              "UPDATE delegation_groups SET status = 'completed', settled_count = expected_count, failed_count = expected_count, completed_at = datetime('now') WHERE id = ? AND status = 'running'",
            )
            .run(groupId);
        }

        this.db
          .prepare("UPDATE agent_instances SET status = 'failed', updated_at = datetime('now') WHERE id = ?")
          .run(inst.id);

        this.emitRemediationEvent("delegation_orphan_cleanup", inst.template_agent_id, inst.task_id, {
          instanceId: inst.id,
          failedDelegations: childDelegations.length,
        });
      }
    }
  }

  /**
   * Find tasks in running status with no live runtime anywhere.
   * Emits remediation events so recovery can pick them up next tick.
   */
  checkOrphanedTasks(): void {
    const runningTasks = this.db
      .prepare("SELECT id FROM tasks WHERE status = 'running' AND task_type != 'real_time'")
      .all() as Array<{ id: string }>;

    for (const task of runningTasks) {
      // Check if any agent is assigned
      const assignedAgent = this.db
        .prepare("SELECT id, process_pid FROM agents WHERE current_task_id = ?")
        .get(task.id) as { id: string; process_pid: number | null } | null;

      if (assignedAgent) {
        const inMemory = this.agentManager.getRunningAgent(assignedAgent.id);
        if (inMemory) continue;
        if (assignedAgent.process_pid) {
          try {
            process.kill(assignedAgent.process_pid, 0);
            continue;
          } catch {
            // Dead process
          }
        }
      }

      // Check if any live instances exist for the task
      const liveInstances = this.db
        .prepare(
          "SELECT id, process_pid FROM agent_instances WHERE task_id = ? AND status IN ('running', 'waiting_delegation')",
        )
        .all(task.id) as Array<{ id: string; process_pid: number | null }>;

      let anyLive = false;
      for (const inst of liveInstances) {
        const inMemory = this.agentManager.getRunningAgent(inst.id);
        if (inMemory) { anyLive = true; break; }
        if (inst.process_pid) {
          try {
            process.kill(inst.process_pid, 0);
            anyLive = true;
            break;
          } catch {
            // Dead
          }
        }
      }

      if (!anyLive) {
        this.emitRemediationEvent("orphaned_task", null, task.id, {
          hadAssignedAgent: !!assignedAgent,
          liveInstanceCount: 0,
        });
      }
    }
  }

  /**
   * Track agent exit codes for cluster detection.
   * If a non-zero exit code appears 3+ times within 5 minutes,
   * creates an incident event and escalation.
   */
  trackExitCode(agentId: string, code: number): void {
    const now = Date.now();
    this.exitCodeWindow.push({ agentId, code, timestamp: now });

    // Prune old entries
    const cutoff = now - EXIT_CODE_WINDOW_MS;
    this.exitCodeWindow = this.exitCodeWindow.filter((e) => e.timestamp > cutoff);

    if (code === 0) return;

    // Count occurrences of this non-zero code
    const count = this.exitCodeWindow.filter((e) => e.code === code).length;
    if (count >= EXIT_CODE_CLUSTER_THRESHOLD) {
      this.emitIncidentEvent("exit_code_cluster", {
        code,
        count,
        windowMs: EXIT_CODE_WINDOW_MS,
        agents: [...new Set(this.exitCodeWindow.filter((e) => e.code === code).map((e) => e.agentId))],
      });

      // Find the task affected
      const agentRow = this.db
        .prepare("SELECT current_task_id FROM agents WHERE id = ?")
        .get(agentId) as { current_task_id: string | null } | null;

      if (agentRow?.current_task_id) {
        try {
          const escalationId = crypto.randomUUID();
          const question = `Repeated exit code ${code} detected ${count} times in 5 minutes. Agents affected: ${[...new Set(this.exitCodeWindow.filter((e) => e.code === code).map((e) => e.agentId))].join(", ")}`;
          this.db
            .prepare(
              `INSERT INTO escalations (id, agent_id, task_id, type, question, severity)
               VALUES (?, ?, ?, 'incident', ?, 'high')`,
            )
            .run(
              escalationId,
              agentId,
              agentRow.current_task_id,
              question,
            );

          eventBus.emit("escalation:created", {
            escalationId,
            agentId,
            taskId: agentRow.current_task_id,
            type: "incident",
            question,
          });
        } catch (err) {
          logError(this.db, "exit_code_cluster_escalation", { code, count }, err);
        }
      }

      // Clear the window for this code to avoid repeated alerts
      this.exitCodeWindow = this.exitCodeWindow.filter((e) => e.code !== code);
    }
  }

  /**
   * Generate a structured diagnostic for a stuck/problematic task.
   */
  generateWhyStuckDiagnostic(taskId: string): WhyStuckDiagnostic | null {
    const task = this.taskScheduler.getTask(taskId);
    if (!task) return null;

    let orchestrationStep: string | null = null;
    try {
      const orchRow = this.db
        .prepare("SELECT orchestration_state FROM tasks WHERE id = ?")
        .get(taskId) as { orchestration_state: string } | null;
      if (orchRow) {
        const parsed = JSON.parse(orchRow.orchestration_state);
        orchestrationStep = parsed.step ?? null;
      }
    } catch { /* ignore */ }

    const assignedAgentRow = this.db
      .prepare("SELECT id, process_pid, status FROM agents WHERE current_task_id = ?")
      .get(taskId) as { id: string; process_pid: number | null; status: string } | null;

    const liveInstances = this.db
      .prepare(
        "SELECT id, status, process_pid FROM agent_instances WHERE task_id = ? AND status IN ('running', 'waiting_delegation', 'pending')",
      )
      .all(taskId) as Array<{ id: string; status: string; process_pid: number | null }>;

    const activeDelegations = this.db
      .prepare(
        "SELECT id, status, child_instance_id FROM delegations WHERE task_id = ? AND status IN ('pending', 'running')",
      )
      .all(taskId) as Array<{ id: string; status: string; child_instance_id: string | null }>;

    const openEscalations = this.db
      .prepare(
        "SELECT id, question FROM escalations WHERE task_id = ? AND status = 'open'",
      )
      .all(taskId) as Array<{ id: string; question: string }>;

    const recentErrors = this.db
      .prepare(
        "SELECT category, message, created_at FROM error_log WHERE context LIKE ? ORDER BY created_at DESC LIMIT 5",
      )
      .all(`%${taskId}%`) as Array<{ category: string; message: string; created_at: string }>;

    // Build likely reasons
    const likely_reasons: string[] = [];

    if (task.status !== "running") {
      likely_reasons.push(`Task is in ${task.status} state, not running`);
    }

    if (!assignedAgentRow) {
      likely_reasons.push("No agent assigned to this task");
    } else if (!assignedAgentRow.process_pid) {
      likely_reasons.push("Assigned agent has no process PID (not running)");
    } else {
      try {
        process.kill(assignedAgentRow.process_pid, 0);
      } catch {
        likely_reasons.push(`Assigned agent process (PID ${assignedAgentRow.process_pid}) is dead`);
      }
    }

    if (openEscalations.length > 0) {
      likely_reasons.push(`${openEscalations.length} unresolved escalation(s) blocking progress`);
    }

    if (activeDelegations.length > 0) {
      const pendingCount = activeDelegations.filter((d) => d.status === "pending").length;
      if (pendingCount > 0) {
        likely_reasons.push(`${pendingCount} delegation(s) still pending spawn`);
      }
      const noLiveChild = activeDelegations.filter((d) => {
        if (!d.child_instance_id) return true;
        return !this.agentManager.getRunningAgent(d.child_instance_id);
      });
      if (noLiveChild.length > 0) {
        likely_reasons.push(`${noLiveChild.length} active delegation(s) with no live child process`);
      }
    }

    if (liveInstances.length === 0 && task.status === "running") {
      likely_reasons.push("No live instances for this running task");
    }

    if (recentErrors.length > 0) {
      likely_reasons.push(`${recentErrors.length} recent error(s) related to this task`);
    }

    if (likely_reasons.length === 0) {
      likely_reasons.push("No obvious issues detected — task may be making progress");
    }

    return {
      taskId,
      taskStatus: task.status,
      orchestrationStep,
      assignedAgent: assignedAgentRow,
      liveInstances,
      activeDelegations,
      openEscalations,
      recentErrors,
      likely_reasons,
    };
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

  private emitRemediationEvent(type: string, agentId: string | null, taskId: string | null, details: Record<string, unknown>): void {
    try {
      this.db
        .prepare(
          "INSERT INTO events (type, payload, source_agent_id, task_id) VALUES (?, ?, ?, ?)",
        )
        .run(`remediation:${type}`, JSON.stringify(details), agentId, taskId);
    } catch (err) {
      logError(this.db, "remediation_event_emit", { type, agentId, taskId }, err);
    }
  }

  private emitIncidentEvent(type: string, details: Record<string, unknown>): void {
    try {
      this.db
        .prepare(
          "INSERT INTO events (type, payload) VALUES (?, ?)",
        )
        .run(`incident:${type}`, JSON.stringify(details));
    } catch (err) {
      logError(this.db, "incident_event_emit", { type }, err);
    }
  }

  private findRunningRuntimeByPid(pid: number): { id: string } | null {
    for (const runtime of this.agentManager.getRunningAgents().values()) {
      if (runtime.process.pid === pid) {
        return { id: runtime.id };
      }
    }
    return null;
  }
}
