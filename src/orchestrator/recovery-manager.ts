import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { PromptBuilder, AgentInfo, PhaseInfo } from "../agents/prompt-builder";
import type { TaskScheduler } from "../tasks/scheduler";
import type { TeamManager, Phase } from "../teams/manager";
import { agentTypeUsesInlinePrompt, getAgentTypeDefinition } from "../agents/types";
import { TaskStateMachine } from "./state";
import { logError } from "../logging";
import { getTaskTemplateId, resolvePhaseConfig } from "../templates/helpers";
import type { OrchestrationState, TaskCheckpoint } from "./types";

const RECOVERY_ATTEMPT_KEY_PREFIX = "recovery_attempt:";
const ORPHAN_RECOVERY_SEEN_KEY_PREFIX = "orphan_recovery_seen:";
const ORPHAN_RECOVERY_GRACE_MS = 15_000;
interface RecoveryAttemptState {
  attemptedAt: string;
  phase: number;
  checkpointSeq: number;
}

export class RecoveryManager {
  constructor(
    private readonly db: Database,
    private readonly agentManager: AgentManager,
    private readonly promptBuilder: PromptBuilder,
    private readonly taskScheduler: TaskScheduler,
    private readonly teamManager: TeamManager,
    private readonly getPhaseCompleteHandled: () => Set<string>,
    private readonly setAgentState: (agentId: string, state: string, metadata?: Record<string, unknown>) => void,
  ) {}

  /**
   * Clean up stale agent process state on startup.
   * Also checks agent_instances with non-null PIDs.
   */
  cleanupStaleState(): void {
    try {
      const agentsWithPids = this.db
        .prepare("SELECT id, process_pid FROM agents WHERE process_pid IS NOT NULL")
        .all() as { id: string; process_pid: number }[];

      for (const row of agentsWithPids) {
        const inMemory = this.agentManager.getRunningAgent(row.id);
        if (!inMemory) {
          try {
            process.kill(row.process_pid, 0);
            process.kill(row.process_pid, 9);
          } catch (err) {
            logError(this.db, "cleanup_kill_orphan", { agentId: row.id, pid: row.process_pid, method: "cleanupStaleState" }, err);
          }

          this.db
            .prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = ?")
            .run(row.id);

          this.emitRemediationEvent("startup_agent_cleanup", row.id, null, { pid: row.process_pid });
        }
      }

      for (const [agentId, running] of this.agentManager.getRunningAgents()) {
        try {
          process.kill(running.process.pid, 0);
        } catch (err) {
          logError(this.db, "cleanup_dead_agent", { agentId, method: "cleanupStaleState" }, err);
          this.agentManager.getRunningAgents().delete(agentId);
          this.db
            .prepare("UPDATE agents SET process_pid = NULL, status = 'idle' WHERE id = ?")
            .run(agentId);
        }
      }

      // Startup reconciliation: check agent_instances with PIDs not tracked in memory
      const instancesWithPids = this.db
        .prepare(
          "SELECT id, template_agent_id, process_pid, task_id FROM agent_instances WHERE process_pid IS NOT NULL AND status IN ('running', 'waiting_delegation')",
        )
        .all() as Array<{ id: string; template_agent_id: string; process_pid: number; task_id: string }>;

      for (const inst of instancesWithPids) {
        const tracked = this.agentManager.getRunningAgent(inst.id);
        if (!tracked) {
          try {
            process.kill(inst.process_pid, 0);
            process.kill(inst.process_pid, 9);
          } catch { /* already dead */ }

          this.db
            .prepare("UPDATE agent_instances SET status = 'failed', process_pid = NULL, updated_at = datetime('now') WHERE id = ?")
            .run(inst.id);

          this.emitRemediationEvent("startup_instance_cleanup", inst.template_agent_id, inst.task_id, {
            instanceId: inst.id,
            pid: inst.process_pid,
          });
        }
      }
    } catch (err) {
      logError(this.db, "cleanup_stale_state", { method: "cleanupStaleState" }, err);
    }
  }

  /**
   * True if the task has any escalation still awaiting human response. When this is
   * the case, the task is intentionally parked — the original agent will be respawned
   * by EscalationManager.injectResponse when the user resolves. Recovering here would
   * spawn a second skipper alongside the one that injectResponse will revive.
   */
  private hasOpenEscalation(taskId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM escalations WHERE task_id = ? AND status = 'open' LIMIT 1")
      .get(taskId);
    return !!row;
  }

  async recoverAllStaleTasks(): Promise<number> {
    let recovered = 0;

    try {
      const runningTasks = this.db
        .prepare("SELECT * FROM tasks WHERE status = 'running' AND task_type != 'real_time'")
        .all() as Array<Record<string, unknown>>;

      for (const row of runningTasks) {
        const taskId = row.id as string;
        const task = this.taskScheduler.getTask(taskId);
        if (!task) continue;
        if (task.needs_review) continue; // Intentionally paused for human review — not orphaned
        if (this.hasOpenEscalation(taskId)) continue; // Parked awaiting human response — see injectResponse

        const assignedAgent = this.db
          .prepare("SELECT id, process_pid FROM agents WHERE current_task_id = ?")
          .get(taskId) as { id: string; process_pid: number | null } | null;

        if (!assignedAgent) {
          if (!this.shouldAttemptOrphanRecovery(taskId)) {
            continue;
          }
          const didRecover = await this.recoverTask(taskId);
          if (didRecover) recovered++;
          continue;
        }

        const inMemory = this.agentManager.getRunningAgent(assignedAgent.id);
        if (inMemory) {
          this.clearOrphanRecoverySeen(taskId);
          continue;
        }

        if (assignedAgent.process_pid) {
          try {
            process.kill(assignedAgent.process_pid, 0);
            this.clearOrphanRecoverySeen(taskId);
            continue;
          } catch (err) {
            logError(this.db, "recovery_liveness_check", { agentId: assignedAgent.id, pid: assignedAgent.process_pid, method: "recoverAllStaleTasks" }, err);
          }
        }

        const activeDelegation = this.getActiveDelegationForParent(assignedAgent.id);
        if (activeDelegation) {
          const childRuntimeId = activeDelegation.child_instance_id ?? activeDelegation.child_agent_id;
          const childRunning = this.agentManager.getRunningAgent(childRuntimeId);
          if (childRunning) {
            this.clearOrphanRecoverySeen(taskId);
            continue;
          }
        }

        if (!this.shouldAttemptOrphanRecovery(taskId)) {
          continue;
        }

        const didRecover = await this.recoverTask(taskId);
        if (didRecover) {
          this.emitRemediationEvent("task_recovered", assignedAgent.id, taskId, { method: "recoverAllStaleTasks" });
          recovered++;
        }
      }
    } catch (err) {
      logError(this.db, "recovery_error", { method: "recoverAllStaleTasks" }, err);
    }

    return recovered;
  }

  async recoverTask(taskId: string): Promise<boolean> {
    const task = this.taskScheduler.getTask(taskId);
    if (!task || task.status !== "running") return false;
    if (task.needs_review) return false; // Not a recovery candidate — waiting for human review
    if (task.task_type === "real_time") return false;
    if (!task.team_id) return false;
    if (this.hasOpenEscalation(taskId)) return false; // Awaiting human escalation response

    const latestCheckpoint = this.getLatestCheckpoint(taskId);
    const currentPhase = task.current_phase ?? 0;
    const currentCheckpointSeq = latestCheckpoint?.sequence ?? 0;

    // One-shot recovery policy: check if we've already tried to recover this task
    const recoveryKey = `${RECOVERY_ATTEMPT_KEY_PREFIX}${taskId}`;
    const existingAttempt = this.db
      .prepare("SELECT value FROM daemon_state WHERE key = ?")
      .get(recoveryKey) as { value: string } | null;

    if (existingAttempt) {
      const parsedAttempt = this.parseRecoveryAttempt(existingAttempt.value);
      const madeProgress =
        currentPhase > parsedAttempt.phase ||
        currentCheckpointSeq > parsedAttempt.checkpointSeq;

      if (!madeProgress) {
        // Already recovered once with no forward progress. Don't loop forever,
        // but don't terminally fail either — pause for human review so the
        // user can click Resume (which preserves notes/artifacts/checkpoints)
        // and continue from where things left off.
        const pauseReason =
          "Recovery paused — Skipper died unexpectedly twice in a row and the daemon stopped retrying to avoid an infinite loop. Notes, artifacts, escalations, and checkpoints are all intact. Click Resume to continue from the current phase.";
        try {
          this.taskScheduler.failTask(taskId, pauseReason);
          // failTask resets needs_review=0; re-arm it AFTER so the UI knows
          // this is a recoverable pause, not a permanent failure.
          // We can't use setNeedsReview here because it gates on
          // status='running', and we just flipped status to 'failed'.
          // Direct UPDATE is fine — the flag is just a UI marker on a
          // failed task and doesn't need the scheduler's invariants.
          this.db
            .prepare("UPDATE tasks SET needs_review = 1, updated_at = datetime('now') WHERE id = ?")
            .run(taskId);
          // Attribute a system note to the team entrypoint so the resumed
          // Skipper sees it in NOTES FROM PREVIOUS AGENTS.
          const noteAgentRow = this.db.prepare(
            `SELECT COALESCE(t.entrypoint_agent_id, (SELECT agent_id FROM team_agents WHERE team_id = t.id LIMIT 1)) AS agent_id
             FROM teams t WHERE t.id = (SELECT team_id FROM tasks WHERE id = ?)`,
          ).get(taskId) as { agent_id: string | null } | null;
          if (noteAgentRow?.agent_id) {
            this.db.prepare(
              `INSERT INTO task_notes (id, task_id, agent_id, content, created_at)
               VALUES (?, ?, ?, ?, datetime('now'))`,
            ).run(
              crypto.randomUUID(),
              taskId,
              noteAgentRow.agent_id,
              `[system] Recovery paused at phase ${currentPhase} after one-shot recovery exhausted. The daemon detected the prior run died without forward progress. User Resume continues from this checkpoint.`,
            );
          }
        } catch (err) {
          logError(this.db, "one_shot_recovery_fail", { taskId, method: "recoverTask" }, err);
        }
        this.emitRemediationEvent("one_shot_recovery_exhausted", null, taskId, {
          previousAttempt: existingAttempt.value,
          phase: currentPhase,
          checkpointSeq: currentCheckpointSeq,
        });
        // Clean up the recovery key
        this.db.prepare("DELETE FROM daemon_state WHERE key = ?").run(recoveryKey);
        return false;
      }

      // Progress was made since last recovery — allow one more recovery attempt from new baseline.
      this.emitRemediationEvent("one_shot_recovery_reset_progress", null, taskId, {
        previousAttempt: existingAttempt.value,
        phase: currentPhase,
        checkpointSeq: currentCheckpointSeq,
      });
    }

    // Record recovery attempt
    const recoveryState: RecoveryAttemptState = {
      attemptedAt: new Date().toISOString(),
      phase: currentPhase,
      checkpointSeq: currentCheckpointSeq,
    };
    this.db
      .prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)")
      .run(recoveryKey, JSON.stringify(recoveryState));

    const teamExec = this.teamManager.getTeamForExecution(task.team_id);
    if (!teamExec) return false;

    const entrypointAgentId = teamExec.entrypoint_agent_id;
    const agent = this.agentManager.getAgent(entrypointAgentId);
    if (!agent) return false;

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    if (!typeDef) return false;

    const orchState = (task.orchestration_state ?? {}) as Partial<OrchestrationState>;
    if (!orchState || typeof orchState !== "object") return false;

    const checkpoint = latestCheckpoint;

    if (orchState.phase_guards) {
      for (const guard of orchState.phase_guards) {
        this.getPhaseCompleteHandled().add(guard);
      }
    }

    const activeGroupId = orchState.active_delegation_group_id;
    if (activeGroupId) {
      const group = this.db
        .prepare("SELECT status FROM delegation_groups WHERE id = ?")
        .get(activeGroupId) as { status: string } | null;
      if (group && group.status === "running") {
        this.setAgentState(entrypointAgentId, "waiting_delegation", {
          delegation_id: activeGroupId,
        });
        return true;
      }
    }

    const sessionId =
      orchState.session_id ??
      (checkpoint?.session_id || null) ??
      this.agentManager.getEntrypointSessionIdForTask(taskId, entrypointAgentId);
    const canResume = typeDef.supports_resume && !!sessionId;

    const isStreaming = typeDef.supports_stdin ?? false;
    const phases = (teamExec.team.phases as Phase[]) ?? [];
    const phaseCursor = task.current_phase;

    const agentInfo: AgentInfo = {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      instruction: agent.config.instruction,
    };

    let phaseInfo: PhaseInfo | undefined;
    if (phases.length > 0 && phaseCursor < phases.length) {
      const templateId = getTaskTemplateId(task.task_config);
      const resolved = resolvePhaseConfig(this.db, phases[phaseCursor], templateId, task.task_config as Record<string, unknown>);
      phaseInfo = {
        name: resolved.name,
        prompt: resolved.prompt,
        index: phaseCursor,
        total: phases.length,
      };
    }

    const prompt = this.promptBuilder.buildInitialPrompt({
      agent: agentInfo,
      task: { id: taskId, title: task.title, description: task.description ?? undefined, workingDirectory: task.working_directory },
      phase: phaseInfo,
      isStreaming,
    });

    const recoveryPrefix = canResume
      ? "[SYSTEM] Session recovered. Continuing from last checkpoint.\n\n"
      : "[SYSTEM] Task recovered after agent restart. Resuming from current phase.\n\n";
    const fullPrompt = recoveryPrefix + prompt;
    const usesInlinePrompt = agentTypeUsesInlinePrompt(typeDef, canResume ? sessionId : null);

    if (this.agentManager.getRunningAgent(entrypointAgentId)) {
      this.agentManager.killAgent(entrypointAgentId);
      await this.agentManager.waitForExit(entrypointAgentId);
    }

    try {
      const workingDir = process.cwd(); // Agents spawn in orchestrator cwd
      const spawnOpts = canResume
        ? { workingDir, taskId, sessionId: sessionId!, initialPrompt: usesInlinePrompt ? fullPrompt : undefined }
        : { workingDir, taskId, initialPrompt: usesInlinePrompt ? fullPrompt : undefined };
      await this.agentManager.spawnAgent(entrypointAgentId, spawnOpts);
    } catch (err) {
      logError(this.db, "recovery_spawn", { taskId, agentId: entrypointAgentId, method: "recoverTask" }, err);
      return false;
    }

    if (!this.agentManager.getRunningAgent(entrypointAgentId)) {
      logError(this.db, "recovery_spawn_unconfirmed", { taskId, agentId: entrypointAgentId, method: "recoverTask" }, new Error("Spawn did not result in a running agent"));
      return false;
    }

    this.db
      .prepare("UPDATE agents SET current_task_id = NULL WHERE current_task_id = ? AND id != ?")
      .run(taskId, entrypointAgentId);

    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(taskId, entrypointAgentId);

    const closeStdin = !isStreaming;
    try {
      if (!usesInlinePrompt) {
        this.agentManager.sendInput(entrypointAgentId, fullPrompt, closeStdin);
      }
    } catch (err) {
      logError(this.db, "recovery_send_input", { taskId, agentId: entrypointAgentId, method: "recoverTask" }, err);
      return false;
    }

    this.emitRemediationEvent("task_recovery_spawned", entrypointAgentId, taskId, {
      canResume,
      sessionId: canResume ? sessionId : null,
    });

    this.updateOrchestrationState(taskId, {
      step: "AGENT_RUNNING",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: canResume ? sessionId : null,
      active_delegation_group_id: null,
      active_delegation_child_count: 0,
      active_delegation_settled_count: 0,
      phase_guards: Array.from(this.getPhaseCompleteHandled()).filter((k) => k.startsWith(`${taskId}:`)),
      pending_regression: null,
      checkpoint_prompt_hash: null,
    });

    this.clearOrphanRecoverySeen(taskId);

    return true;
  }

  /**
   * Clean up all runtime state when a task reaches a terminal state.
   * Clears agent assignments, fails active instances, kills live processes.
   */
  cleanupTerminalTaskState(taskId: string): void {
    try {
      // Clear agent assignments for this task
      this.db
        .prepare("UPDATE agents SET current_task_id = NULL, process_pid = NULL WHERE current_task_id = ?")
        .run(taskId);

      // Fail any non-terminal instances
      const activeInstances = this.db
        .prepare(
          "SELECT id, process_pid FROM agent_instances WHERE task_id = ? AND status IN ('running', 'waiting_delegation', 'pending')",
        )
        .all(taskId) as Array<{ id: string; process_pid: number | null }>;

      for (const inst of activeInstances) {
        if (inst.process_pid) {
          try {
            process.kill(inst.process_pid, 9);
          } catch { /* already dead */ }
        }
        this.agentManager.killAgent(inst.id);
      }

      this.db
        .prepare(
          "UPDATE agent_instances SET status = 'failed', process_pid = NULL, updated_at = datetime('now') WHERE task_id = ? AND status IN ('running', 'waiting_delegation', 'pending')",
        )
        .run(taskId);

      // Clean up the recovery attempt key
      this.db
        .prepare("DELETE FROM daemon_state WHERE key = ?")
        .run(`${RECOVERY_ATTEMPT_KEY_PREFIX}${taskId}`);
      this.clearOrphanRecoverySeen(taskId);

      // Clean up any idle-poke bookkeeping for this terminated task
      const idleKeys = [
        `idle_since:${taskId}`,
        `idle_poke_count:${taskId}`,
        `idle_poke_fired_at:${taskId}`,
      ];
      const delStmt = this.db.prepare("DELETE FROM daemon_state WHERE key = ?");
      for (const key of idleKeys) delStmt.run(key);
    } catch (err) {
      logError(this.db, "terminal_task_cleanup", { taskId, method: "cleanupTerminalTaskState" }, err);
    }
  }

  private shouldAttemptOrphanRecovery(taskId: string): boolean {
    const key = `${ORPHAN_RECOVERY_SEEN_KEY_PREFIX}${taskId}`;
    const now = Date.now();
    const row = this.db
      .prepare("SELECT value FROM daemon_state WHERE key = ?")
      .get(key) as { value: string } | null;

    if (!row) {
      this.db
        .prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)")
        .run(key, String(now));
      this.emitRemediationEvent("orphan_recovery_grace_started", null, taskId, {
        graceMs: ORPHAN_RECOVERY_GRACE_MS,
      });
      return false;
    }

    const seenAt = Number(row.value);
    if (!Number.isFinite(seenAt) || (now - seenAt) >= ORPHAN_RECOVERY_GRACE_MS) {
      return true;
    }
    return false;
  }

  private clearOrphanRecoverySeen(taskId: string): void {
    this.db
      .prepare("DELETE FROM daemon_state WHERE key = ?")
      .run(`${ORPHAN_RECOVERY_SEEN_KEY_PREFIX}${taskId}`);
  }

  updateOrchestrationState(taskId: string, state: OrchestrationState): void {
    try {
      const sm = new TaskStateMachine(taskId, this.db);
      sm.transitionTo(state.step);

      this.db
        .prepare(
          "UPDATE tasks SET orchestration_state = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(JSON.stringify(state), taskId);
    } catch (err) {
      logError(this.db, "orchestration_state_update", { taskId, step: state.step, method: "updateOrchestrationState" }, err);
    }
  }

  getOrchestrationState(taskId: string): OrchestrationState | null {
    try {
      const row = this.db
        .prepare("SELECT orchestration_state FROM tasks WHERE id = ?")
        .get(taskId) as { orchestration_state: string } | null;
      if (!row) return null;
      const parsed = JSON.parse(row.orchestration_state);
      if (!parsed.step) return null;
      return parsed as OrchestrationState;
    } catch (err) {
      logError(this.db, "orchestration_state_read", { taskId, method: "getOrchestrationState" }, err);
      return null;
    }
  }

  writeCheckpoint(
    taskId: string,
    checkpointType: string,
    contextSnapshot: Record<string, unknown> = {},
  ): void {
    try {
      const seqRow = this.db
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq FROM task_checkpoints WHERE task_id = ?",
        )
        .get(taskId) as { next_seq: number };

      // Prefer per-task instance lookup over template-keyed agents row to
      // avoid cross-task session collision when parallel tasks share a template.
      const instanceForSession = this.db
        .prepare(
          `SELECT id, template_agent_id FROM agent_instances
           WHERE task_id = ? AND status IN ('running','waiting_delegation')
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(taskId) as { id: string; template_agent_id: string } | null;
      const agentRow = instanceForSession
        ? { id: instanceForSession.id, template_agent_id: instanceForSession.template_agent_id }
        : this.db.prepare("SELECT id FROM agents WHERE current_task_id = ?").get(taskId) as { id: string } | null;
      const sessionId = agentRow
        ? this.agentManager.getSessionId(agentRow.id)
        : null;

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
    } catch (err) {
      logError(this.db, "checkpoint_write", { taskId, checkpointType, method: "writeCheckpoint" }, err);
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
    } catch (err) {
      logError(this.db, "checkpoint_read", { taskId, method: "getLatestCheckpoint" }, err);
      return null;
    }
  }

  persistCheckpoints(
    getActiveDelegationForParent: (agentId: string) => { id: string } | null,
  ): void {
    const runningTasks = this.getRunningTasks();
    for (const runningTask of runningTasks) {
      // Pull the runtime INSTANCE id (UUID), not the template id. With parallel
      // tasks both using the same template (e.g. "skipper"), looking up by
      // template id would collide across tasks and stomp session_id between
      // them — corrupting orchestration_state.session_id and causing resumes
      // to pull a sibling task's claude conversation.
      const instanceRow = this.db
        .prepare(
          `SELECT id AS instance_id, template_agent_id FROM agent_instances
           WHERE task_id = ? AND status IN ('running', 'waiting_delegation')
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(runningTask.id) as { instance_id: string; template_agent_id: string } | null;

      // Fallback for legacy/template-runtime rows that don't have an
      // agent_instances entry — use the agents row keyed by current_task_id.
      // Session lookups still need to work, but only for the single-task case;
      // with parallel tasks the instance path above is the correct one.
      const fallbackTemplateRow = !instanceRow
        ? this.db.prepare("SELECT id FROM agents WHERE current_task_id = ?").get(runningTask.id) as { id: string } | null
        : null;

      const runtimeId = instanceRow?.instance_id ?? fallbackTemplateRow?.id ?? null;
      const templateForState = instanceRow?.template_agent_id ?? fallbackTemplateRow?.id ?? null;
      if (!runtimeId || !templateForState) continue;

      const sessionId = this.agentManager.getSessionId(runtimeId);
      const activeDelegation = getActiveDelegationForParent(runtimeId);

      const state: OrchestrationState = {
        step: activeDelegation ? "WAITING_DELEGATION" : "AGENT_RUNNING",
        last_checkpoint_ts: new Date().toISOString(),
        session_id: sessionId,
        active_delegation_group_id: activeDelegation?.delegation_group_id ?? null,
        active_delegation_child_count: activeDelegation?.expected_count ?? 0,
        active_delegation_settled_count: activeDelegation?.settled_count ?? 0,
        phase_guards: Array.from(this.getPhaseCompleteHandled()).filter((k) =>
          k.startsWith(`${runningTask.id}:`),
        ),
        pending_regression: null,
        checkpoint_prompt_hash: null,
      };

      this.updateOrchestrationState(runningTask.id, state);
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

  private parseRecoveryAttempt(raw: string): RecoveryAttemptState {
    try {
      const parsed = JSON.parse(raw) as Partial<RecoveryAttemptState>;
      return {
        attemptedAt: typeof parsed.attemptedAt === "string" ? parsed.attemptedAt : raw,
        phase: typeof parsed.phase === "number" ? parsed.phase : 0,
        checkpointSeq: typeof parsed.checkpointSeq === "number" ? parsed.checkpointSeq : 0,
      };
    } catch {
      // Backward compatibility for old plain-ISO string values.
      return {
        attemptedAt: raw,
        phase: 0,
        checkpointSeq: 0,
      };
    }
  }

  private getRunningTasks(): import("../tasks/scheduler").Task[] {
    const rows = this.db
      .prepare("SELECT id FROM tasks WHERE status = 'running' AND task_type != 'real_time'")
      .all() as Array<{ id: string }>;

    return rows
      .map((r) => this.taskScheduler.getTask(r.id))
      .filter((t): t is import("../tasks/scheduler").Task => t !== null);
  }

  private getActiveDelegationForParent(parentAgentId: string): {
    child_agent_id: string;
    child_instance_id: string | null;
    delegation_group_id: string | null;
    expected_count: number | null;
    settled_count: number | null;
  } | null {
    try {
      const row = this.db
        .prepare(
          `SELECT d.child_agent_id,
                  d.child_instance_id,
                  d.delegation_group_id,
                  dg.expected_count,
                  dg.settled_count
           FROM delegations d
           LEFT JOIN delegation_groups dg ON dg.id = d.delegation_group_id
           WHERE d.parent_instance_id = ? AND d.status IN ('pending', 'running')
           LIMIT 1`,
        )
        .get(parentAgentId) as {
        child_agent_id: string;
        child_instance_id: string | null;
        delegation_group_id: string | null;
        expected_count: number | null;
        settled_count: number | null;
      } | null;
      return row ?? null;
    } catch (err) {
      logError(this.db, "get_active_delegation_parent", { parentAgentId, method: "getActiveDelegationForParent" }, err);
      return null;
    }
  }
}
