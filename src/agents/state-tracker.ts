import type { Database } from "bun:sqlite";
import { AgentManager } from "./manager";
import { eventBus } from "../events/bus";
import { logError } from "../logging";

const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const STUCK_THRESHOLD_SECONDS = Math.floor(STUCK_THRESHOLD_MS / 1000);
const MAX_NUDGES = 3;
const FINGERPRINT_CHARS = 500;

interface AgentStateRow {
  agent_id: string;
  state: string;
  screen_fingerprint: string | null;
  heartbeat_at: string;
  nudge_count: number;
  last_signal_at: string | null;
}

interface InstanceRow {
  task_id: string;
  template_agent_id: string;
}

/**
 * Stuck detection per runtime instance. Every agent_states row this tracker
 * reads or writes is keyed by a runtime id (agent_instances.id), because one
 * template (above all the shared `skipper` root) runs in many tasks at once:
 * each runtime gets its own heartbeat, fingerprint, nudges and escalation.
 * Template-keyed agent_states rows still exist (the delegation and escalation
 * managers write them, and heartbeats were once stored there). They never
 * join to a live agent_instances row, so they are never candidates, nudged
 * or escalated.
 */
export class StateTracker {
  private db: Database;
  private agentManager: AgentManager;

  constructor(db: Database, agentManager: AgentManager) {
    this.db = db;
    this.agentManager = agentManager;
  }

  /**
   * For every live runtime (running or waiting on a delegation, with a pid),
   * compute a screen fingerprint from that runtime's own recent terminal
   * output and compare it with the stored one. If the output has changed,
   * update heartbeat_at; otherwise leave it stale so that getStuckCandidates()
   * can identify the runtime as a potential stuck candidate.
   */
  updateHeartbeats(): void {
    const runtimeRows = this.db
      .prepare(
        `SELECT id FROM agent_instances
         WHERE status IN ('running', 'waiting_delegation') AND process_pid IS NOT NULL`,
      )
      .all() as { id: string }[];

    for (const { id: runtimeId } of runtimeRows) {
      // Per runtime, so one failed write cannot stop the sweep for the rest
      // (the single-DB schema that tests use still points agent_states.agent_id
      // at agents(id), which a runtime id is not).
      try {
        const fingerprint = this.computeFingerprint(runtimeId);
        const state = this.getAgentState(runtimeId);

        if (!state) {
          // No state record yet: create one with heartbeat = now
          this.db
            .prepare(
              `INSERT INTO agent_states (agent_id, state, screen_fingerprint, heartbeat_at)
               VALUES (?, 'working', ?, datetime('now'))
               ON CONFLICT(agent_id) DO UPDATE SET
                 screen_fingerprint = excluded.screen_fingerprint,
                 heartbeat_at = datetime('now'),
                 updated_at = datetime('now')`,
            )
            .run(runtimeId, fingerprint);
        } else {
          this.rearmClearedGate(runtimeId, state.state);
          if (state.screen_fingerprint !== fingerprint) {
            // Output changed → runtime is active, refresh heartbeat and reset nudge count
            this.db
              .prepare(
                `UPDATE agent_states
                 SET screen_fingerprint = ?, heartbeat_at = datetime('now'), nudge_count = 0, updated_at = datetime('now')
                 WHERE agent_id = ?`,
              )
              .run(fingerprint, runtimeId);
          }
        }
        // If fingerprint is unchanged → heartbeat stays old (no update)
      } catch (err) {
        logError(this.db, "state_tracker.update_heartbeat", { runtimeId }, err);
      }
    }
  }

  /**
   * Return runtime ids whose fingerprint heartbeat has been stale for over
   * STUCK_THRESHOLD_SECONDS. The join to a live agent_instances row is what
   * keeps template-keyed rows out. `last_signal_at` is intentionally NOT
   * consulted here: doer agents (Tester, Coder) produce stdout for long
   * stretches without emitting an orchestration signal, so signal age alone
   * would flag them falsely. Genuinely-looping agents still get caught because
   * repetitive output produces an unchanged fingerprint, which lets the
   * heartbeat go stale.
   */
  getStuckCandidates(): string[] {
    const rows = this.db
      .prepare(
        `SELECT as_.agent_id
         FROM agent_states as_
         JOIN agent_instances ai ON ai.id = as_.agent_id
         WHERE ai.status IN ('running', 'waiting_delegation')
           AND ai.process_pid IS NOT NULL
           AND unixepoch(as_.heartbeat_at) < (unixepoch('now') - ?)
           AND as_.state NOT IN ('waiting_delegation', 'escalated', 'stopped')`,
      )
      .all(STUCK_THRESHOLD_SECONDS) as { agent_id: string }[];
    return rows
      .map((r) => r.agent_id)
      .filter((runtimeId) => !this.isActivelyWaitingOnDelegation(runtimeId) && !this.hasOpenEscalation(runtimeId));
  }

  /**
   * Secondary check: compare the runtime's live screen fingerprint against the
   * stored one. Returns true when the screen hasn't changed (confirming the
   * runtime is stuck). Automatically skips waiting_delegation and escalated
   * runtimes. When the screen has changed it updates the stored fingerprint / heartbeat.
   */
  analyzeStuckAgent(runtimeId: string): boolean {
    const state = this.getAgentState(runtimeId);
    if (!state) return false;

    if (state.state === "waiting_delegation" || state.state === "escalated") {
      return false;
    }
    if (this.isActivelyWaitingOnDelegation(runtimeId) || this.hasOpenEscalation(runtimeId)) {
      return false;
    }

    const currentFingerprint = this.computeFingerprint(runtimeId);

    if (currentFingerprint === state.screen_fingerprint) {
      // Before confirming stuck, check if the runtime's OS process has active
      // child processes (e.g. a test suite, build, or other long-running command).
      // A quiet parent with busy children is waiting, not stuck.
      if (this.hasActiveChildProcesses(runtimeId)) {
        this.db
          .prepare(
            `UPDATE agent_states
             SET heartbeat_at = datetime('now'), nudge_count = 0, updated_at = datetime('now')
             WHERE agent_id = ?`,
          )
          .run(runtimeId);
        this.logStuckDetection(runtimeId, "skipped_active_children", currentFingerprint, {
          heartbeat_at: state.heartbeat_at,
        });
        return false;
      }

      // Screen unchanged → confirmed stuck
      this.logStuckDetection(runtimeId, "stuck", currentFingerprint, {
        heartbeat_at: state.heartbeat_at,
        nudge_count: state.nudge_count,
      });
      return true;
    }

    // Screen changed since last check → runtime is active, reset heartbeat and nudge count
    this.db
      .prepare(
        `UPDATE agent_states
         SET screen_fingerprint = ?, heartbeat_at = datetime('now'), nudge_count = 0, updated_at = datetime('now')
         WHERE agent_id = ?`,
      )
      .run(currentFingerprint, runtimeId);
    return false;
  }

  /**
   * Handle a confirmed stuck runtime: send it a nudge (up to MAX_NUDGES times)
   * then auto-escalate when nudges are exhausted. Only this runtime is nudged,
   * escalated and killed; the other live instances of its template belong to
   * other tasks or delegations and are checked on their own rows.
   */
  handleStuckAgent(runtimeId: string): void {
    const state = this.getAgentState(runtimeId);
    if (!state) return;
    if (this.isActivelyWaitingOnDelegation(runtimeId)) return;

    const currentFingerprint = this.computeFingerprint(runtimeId);
    // A template-keyed row, or a runtime that is no longer live, has none:
    // it is never nudged or escalated.
    const instance = this.getLiveInstance(runtimeId);

    if (state.nudge_count < MAX_NUDGES) {
      if (!instance) {
        this.logStuckDetection(runtimeId, "nudge_skipped", currentFingerprint, {
          reason: "no_live_runtime",
          nudge_count: state.nudge_count,
        });
        return;
      }

      const nudgeCount = state.nudge_count + 1;
      const nudgeMessage = `[SYSTEM] You appear to be idle. Please continue your work. (nudge ${nudgeCount}/${MAX_NUDGES})`;

      this.logStuckDetection(runtimeId, "nudged", currentFingerprint, {
        nudge_count: nudgeCount,
      });

      try {
        this.agentManager.sendInput(runtimeId, nudgeMessage);
      } catch (err) {
        logError(this.db, "state_tracker.send_nudge", { agentId: instance.template_agent_id, runtimeId }, err);
      }

      // Increment nudge count and reset heartbeat so we don't immediately
      // re-nudge on the very next tick
      this.db
        .prepare(
          `UPDATE agent_states
           SET nudge_count = ?, heartbeat_at = datetime('now'), updated_at = datetime('now')
           WHERE agent_id = ?`,
        )
        .run(nudgeCount, runtimeId);
    } else {
      // Max nudges exhausted → escalate. The escalation is filed on this
      // runtime's own task, keeps the template as agent_id and carries this
      // runtime as runtime_agent_id, so the resolve flow resumes the exact
      // runtime that got stuck (otherwise injectResponse falls back to a fresh
      // spawn that loses the conversation context).
      if (!instance) return;
      const { task_id: taskId, template_agent_id: templateAgentId } = instance;

      this.logStuckDetection(runtimeId, "escalated", currentFingerprint, {
        nudge_count: state.nudge_count,
        reason: "max nudges reached",
      });

      const escalationId = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO escalations (id, agent_id, runtime_agent_id, task_id, type, question, severity)
           VALUES (?, ?, ?, ?, 'stuck_agent', ?, 'high')`,
        )
        .run(
          escalationId,
          templateAgentId,
          runtimeId,
          taskId,
          `Agent appears stuck after ${MAX_NUDGES} nudge attempts. Screen fingerprint has not changed.`,
        );

      // Mark the runtime's state as escalated so we stop nudging
      this.db
        .prepare(
          `UPDATE agent_states
           SET state = 'escalated', updated_at = datetime('now')
           WHERE agent_id = ?`,
        )
        .run(runtimeId);

      eventBus.emit("escalation:created", {
        escalationId,
        agentId: templateAgentId,
        taskId,
        type: "stuck_agent",
        question: `Agent stuck after ${MAX_NUDGES} nudges`,
      });

      // Kill the stuck runtime itself. With an open escalation now in place
      // on its task, handleAgentExit will mark the instance stopped and bail
      // (it won't fail the task or route to Skipper); the task hangs until the
      // operator resolves the escalation, which resumes this runtime.
      try {
        this.agentManager.killAgent(runtimeId);
      } catch (err) {
        logError(this.db, "state_tracker.kill_stuck_agent", { agentId: templateAgentId, runtimeId }, err);
      }
    }
  }

  /**
   * Record the time of the last meaningful orchestration signal for this
   * runtime. Called with the runtime id carried by each signal the agent
   * emits (note, delegate, escalate, etc.).
   */
  updateLastSignalAt(runtimeId: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO agent_states (agent_id, state, last_signal_at)
           VALUES (?, 'working', datetime('now'))
           ON CONFLICT(agent_id) DO UPDATE SET
             last_signal_at = datetime('now'),
             updated_at = datetime('now')`,
        )
        .run(runtimeId);
    } catch (err) {
      logError(this.db, "state_tracker.update_last_signal_at", { runtimeId }, err);
    }
  }

  // --- Private helpers ---

  /** Fingerprint of this runtime's own stdout, never merged with its siblings'. */
  private computeFingerprint(runtimeId: string): string {
    try {
      const rows = this.db
        .prepare(
          `SELECT data FROM terminal_outputs
           WHERE agent_id = ? AND stream = 'stdout'
           ORDER BY id DESC LIMIT 20`,
        )
        .all(runtimeId) as { data: string }[];
      const combined = rows
        .reverse()
        .map((r) => r.data)
        .join("");
      return combined.slice(-FINGERPRINT_CHARS);
    } catch (err) {
      logError(this.db, "state_tracker.compute_fingerprint", { runtimeId }, err);
      return "";
    }
  }

  /**
   * The runtime's own instance row while it is live, by the same rule
   * updateHeartbeats and getStuckCandidates use. Null for a template id.
   */
  private getLiveInstance(runtimeId: string): InstanceRow | null {
    return (
      (this.db
        .prepare(
          `SELECT task_id, template_agent_id FROM agent_instances
           WHERE id = ? AND status IN ('running', 'waiting_delegation') AND process_pid IS NOT NULL`,
        )
        .get(runtimeId) as InstanceRow | null) ?? null
    );
  }

  private getAgentState(agentId: string): AgentStateRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM agent_states WHERE agent_id = ?")
        .get(agentId) as AgentStateRow | null) ?? null
    );
  }

  private logStuckDetection(
    runtimeId: string,
    detectionType: string,
    fingerprint: string | null,
    details: Record<string, unknown>,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO stuck_detection_logs (agent_id, detection_type, screen_fingerprint, details)
           VALUES (?, ?, ?, ?)`,
        )
        .run(runtimeId, detectionType, fingerprint, JSON.stringify(details));
    } catch (err) {
      logError(this.db, "state_tracker.log_stuck_detection", { runtimeId, detectionType }, err);
    }
  }

  /**
   * Only this tracker parks a runtime's row in 'waiting_delegation' or
   * 'escalated': the delegation and escalation managers reset the TEMPLATE
   * row when the wait or the escalation ends. Put the runtime back to
   * 'working' once its own wait or escalation is over, or it would never be
   * checked again.
   */
  private rearmClearedGate(runtimeId: string, state: string): void {
    const cleared =
      (state === "waiting_delegation" && !this.isWaitingOnOwnDelegations(runtimeId)) ||
      (state === "escalated" && !this.hasOpenEscalation(runtimeId));
    if (!cleared) return;
    this.db
      .prepare(
        `UPDATE agent_states
         SET state = 'working', updated_at = datetime('now')
         WHERE agent_id = ?`,
      )
      .run(runtimeId);
  }

  /**
   * True while an escalation raised by or for this runtime is open: its own
   * `escalate` call or an earlier stuck escalation. The escalation manager
   * marks only the TEMPLATE row 'escalated', so this is what keeps a runtime
   * that is waiting on the operator from being nudged. Both kinds are filed on
   * the runtime's own task, which keeps the lookup on the task/status index.
   */
  private hasOpenEscalation(runtimeId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM escalations
         WHERE task_id = (SELECT task_id FROM agent_instances WHERE id = ?)
           AND runtime_agent_id = ? AND status = 'open'
         LIMIT 1`,
      )
      .get(runtimeId, runtimeId);
    return !!row;
  }

  /**
   * Return true when this runtime is intentionally blocked waiting on active
   * delegated children. This guards against stale agent_states rows
   * (e.g. state drift back to "working") causing false stuck nudges/escalations.
   */
  private isActivelyWaitingOnDelegation(runtimeId: string): boolean {
    // Check 1: the runtime is in waiting_delegation with active child delegations of its own
    if (this.isWaitingOnOwnDelegations(runtimeId)) {
      // Reconcile stale state row to avoid repeated false positives.
      this.db
        .prepare(
          `UPDATE agent_states
           SET state = 'waiting_delegation',
               nudge_count = 0,
               updated_at = datetime('now')
           WHERE agent_id = ?`,
        )
        .run(runtimeId);
      return true;
    }

    // Check 2: the runtime's own task has other running/pending child instances.
    // This covers the entrypoint agent (e.g. skipper) which waits while delegated
    // children work: its stdout won't change but it's not stuck. The task comes
    // from the runtime's instance row, not agents.current_task_id, which is one
    // slot shared by every task running the template. Roots only: a delegated
    // child waits on its own delegations through check 1, and letting it take
    // this check made two silent sibling children shield each other forever.
    const instance = this.db
      .prepare("SELECT task_id, template_agent_id, parent_instance_id FROM agent_instances WHERE id = ?")
      .get(runtimeId) as (InstanceRow & { parent_instance_id: string | null }) | null;

    if (instance && instance.parent_instance_id === null) {
      const activeChild = this.db
        .prepare(
          `SELECT id FROM agent_instances
           WHERE task_id = ? AND template_agent_id != ?
             AND status IN ('running', 'pending')
           LIMIT 1`,
        )
        .get(instance.task_id, instance.template_agent_id) as { id: string } | null;

      if (activeChild) return true;
    }

    return false;
  }

  /** Check 1 of isActivelyWaitingOnDelegation, without its reconcile write. */
  private isWaitingOnOwnDelegations(runtimeId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT ai.id
         FROM agent_instances ai
         WHERE ai.id = ?
           AND ai.status = 'waiting_delegation'
           AND EXISTS (
             SELECT 1
             FROM delegations d
             WHERE d.parent_instance_id = ai.id
               AND d.status IN ('pending', 'running')
           )
         LIMIT 1`,
      )
      .get(runtimeId) as { id: string } | null;
    return !!row;
  }

  /**
   * Check whether the runtime's own OS process has active child processes.
   * When an agent spawns a long-running subprocess (test suite, build, etc.)
   * the agent's stdout goes quiet while the child runs. This prevents false
   * stuck detection for agents legitimately waiting on subprocesses. The pid
   * is the runtime's own, not agents.process_pid, which is one slot holding
   * the pid of one of the template's live instances, possibly another task's.
   */
  private hasActiveChildProcesses(runtimeId: string): boolean {
    const row = this.db
      .prepare("SELECT process_pid FROM agent_instances WHERE id = ?")
      .get(runtimeId) as { process_pid: number | null } | null;

    if (!row?.process_pid) return false;
    return this.pidHasChildren(row.process_pid);
  }

  private pidHasChildren(pid: number): boolean {
    try {
      const result = Bun.spawnSync({
        cmd: ["pgrep", "-P", String(pid)],
        stdout: "pipe",
        stderr: "ignore",
      });
      // pgrep exits 0 if matches found, 1 if none
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }
}
