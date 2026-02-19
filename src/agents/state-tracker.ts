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

export class StateTracker {
  private db: Database;
  private agentManager: AgentManager;

  constructor(db: Database, agentManager: AgentManager) {
    this.db = db;
    this.agentManager = agentManager;
  }

  /**
   * For all agents with active PIDs, compute a screen fingerprint from recent
   * terminal output and compare it with the stored one. If the output has
   * changed, update heartbeat_at; otherwise leave it stale so that
   * getStuckCandidates() can identify the agent as a potential stuck candidate.
   */
  updateHeartbeats(): void {
    const agentRows = this.db
      .prepare("SELECT id FROM agents WHERE process_pid IS NOT NULL")
      .all() as { id: string }[];

    for (const { id: agentId } of agentRows) {
      const fingerprint = this.computeFingerprint(agentId);
      const state = this.getAgentState(agentId);

      if (!state) {
        // No state record yet — create one with heartbeat = now
        this.db
          .prepare(
            `INSERT INTO agent_states (agent_id, state, screen_fingerprint, heartbeat_at)
             VALUES (?, 'working', ?, datetime('now'))
             ON CONFLICT(agent_id) DO UPDATE SET
               screen_fingerprint = excluded.screen_fingerprint,
               heartbeat_at = datetime('now'),
               updated_at = datetime('now')`,
          )
          .run(agentId, fingerprint);
      } else if (state.screen_fingerprint !== fingerprint) {
        // Output changed → agent is active, refresh heartbeat and reset nudge count
        this.db
          .prepare(
            `UPDATE agent_states
             SET screen_fingerprint = ?, heartbeat_at = datetime('now'), nudge_count = 0, updated_at = datetime('now')
             WHERE agent_id = ?`,
          )
          .run(fingerprint, agentId);
      }
      // If fingerprint is unchanged → heartbeat stays old (no update)
    }
  }

  /**
   * Return agent IDs whose fingerprint heartbeat has been stale for over
   * STUCK_THRESHOLD_SECONDS. `last_signal_at` is intentionally NOT consulted
   * here — it is per-template, so a freshly-spawned instance inherits the
   * previous instance's signal age and triggers an immediate false positive
   * for long-running doer agents (Tester, Coder) that produce stdout but
   * don't emit orchestration signals on every turn. Genuinely-looping agents
   * still get caught because repetitive output produces an unchanged
   * fingerprint, which lets the heartbeat go stale.
   */
  getStuckCandidates(): string[] {
    const rows = this.db
      .prepare(
        `SELECT as_.agent_id
         FROM agent_states as_
         JOIN agents a ON a.id = as_.agent_id
         WHERE a.process_pid IS NOT NULL
           AND unixepoch(as_.heartbeat_at) < (unixepoch('now') - ?)
           AND as_.state NOT IN ('waiting_delegation', 'escalated', 'stopped')`,
      )
      .all(STUCK_THRESHOLD_SECONDS) as { agent_id: string }[];
    return rows
      .map((r) => r.agent_id)
      .filter((agentId) => !this.isActivelyWaitingOnDelegation(agentId));
  }

  /**
   * Secondary check: compare the live screen fingerprint against the stored
   * one. Returns true when the screen hasn't changed (confirming the agent is
   * stuck). Automatically skips waiting_delegation and escalated agents.
   * When the screen has changed it updates the stored fingerprint / heartbeat.
   */
  analyzeStuckAgent(agentId: string): boolean {
    const state = this.getAgentState(agentId);
    if (!state) return false;

    if (state.state === "waiting_delegation" || state.state === "escalated") {
      return false;
    }
    if (this.isActivelyWaitingOnDelegation(agentId)) {
      return false;
    }

    const currentFingerprint = this.computeFingerprint(agentId);

    if (currentFingerprint === state.screen_fingerprint) {
      // Screen unchanged → confirmed stuck
      this.logStuckDetection(agentId, "stuck", currentFingerprint, {
        heartbeat_at: state.heartbeat_at,
        nudge_count: state.nudge_count,
      });
      return true;
    }

    // Screen changed since last check → agent is active, reset heartbeat and nudge count
    this.db
      .prepare(
        `UPDATE agent_states
         SET screen_fingerprint = ?, heartbeat_at = datetime('now'), nudge_count = 0, updated_at = datetime('now')
         WHERE agent_id = ?`,
      )
      .run(currentFingerprint, agentId);
    return false;
  }

  /**
   * Handle a confirmed stuck agent: send a nudge (up to MAX_NUDGES times)
   * then auto-escalate when nudges are exhausted.
   */
  handleStuckAgent(agentId: string): void {
    const state = this.getAgentState(agentId);
    if (!state) return;
    if (this.isActivelyWaitingOnDelegation(agentId)) return;

    const currentFingerprint = this.computeFingerprint(agentId);
    const nudgeTargets = this.resolveLiveRuntimeIds(agentId);

    if (state.nudge_count < MAX_NUDGES) {
      if (nudgeTargets.length === 0) {
        this.logStuckDetection(agentId, "nudge_skipped", currentFingerprint, {
          reason: "no_live_runtime",
          nudge_count: state.nudge_count,
        });
        return;
      }

      const nudgeCount = state.nudge_count + 1;
      const nudgeMessage = `[SYSTEM] You appear to be idle. Please continue your work. (nudge ${nudgeCount}/${MAX_NUDGES})`;

      this.logStuckDetection(agentId, "nudged", currentFingerprint, {
        nudge_count: nudgeCount,
        runtime_ids: nudgeTargets,
      });

      // Attempt to send a nudge to each live runtime for this template agent.
      for (const runtimeId of nudgeTargets) {
        try {
          this.agentManager.sendInput(runtimeId, nudgeMessage);
        } catch (err) {
          logError(this.db, "state_tracker.send_nudge", { agentId, runtimeId }, err);
        }
      }

      // Increment nudge count and reset heartbeat so we don't immediately
      // re-nudge on the very next tick
      this.db
        .prepare(
          `UPDATE agent_states
           SET nudge_count = ?, heartbeat_at = datetime('now'), updated_at = datetime('now')
           WHERE agent_id = ?`,
        )
        .run(nudgeCount, agentId);
    } else {
      // Max nudges exhausted → escalate
      const agentRow = this.db
        .prepare("SELECT current_task_id FROM agents WHERE id = ?")
        .get(agentId) as { current_task_id: string | null } | null;

      if (!agentRow?.current_task_id) return;

      this.logStuckDetection(agentId, "escalated", currentFingerprint, {
        nudge_count: state.nudge_count,
        reason: "max nudges reached",
      });

      // Capture the runtime instance that was being nudged. nudgeTargets is
      // ordered most-recent-first; pick the first live one so the resolve flow
      // can resume the exact runtime that got stuck (otherwise injectResponse
      // falls back to a fresh spawn that loses the conversation context).
      const escalatingRuntimeId = nudgeTargets[0] ?? null;
      const escalationId = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO escalations (id, agent_id, runtime_agent_id, task_id, type, question, severity)
           VALUES (?, ?, ?, ?, 'stuck_agent', ?, 'high')`,
        )
        .run(
          escalationId,
          agentId,
          escalatingRuntimeId,
          agentRow.current_task_id,
          `Agent appears stuck after ${MAX_NUDGES} nudge attempts. Screen fingerprint has not changed.`,
        );

      // Mark agent state as escalated so we stop nudging
      this.db
        .prepare(
          `UPDATE agent_states
           SET state = 'escalated', updated_at = datetime('now')
           WHERE agent_id = ?`,
        )
        .run(agentId);

      eventBus.emit("escalation:created", {
        escalationId,
        agentId,
        taskId: agentRow.current_task_id,
        type: "stuck_agent",
        question: `Agent stuck after ${MAX_NUDGES} nudges`,
      });

      // Kill the stuck agent process. With an open escalation now in place,
      // handleAgentExit will mark the instance stopped and bail (it won't
      // fail the task or route to Skipper) — the task hangs until the
      // operator resolves the escalation, which resumes this runtime.
      try {
        this.agentManager.killAgent(agentId);
      } catch (err) {
        logError(this.db, "state_tracker.kill_stuck_agent", { agentId }, err);
      }
    }
  }

  /**
   * Record the time of the last meaningful orchestration signal for this agent.
   * Called whenever the agent emits a signal (note, delegate, escalate, etc.).
   * Used to detect agents that are active (producing output) but not making progress.
   */
  updateLastSignalAt(agentId: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO agent_states (agent_id, state, last_signal_at)
           VALUES (?, 'working', datetime('now'))
           ON CONFLICT(agent_id) DO UPDATE SET
             last_signal_at = datetime('now'),
             updated_at = datetime('now')`,
        )
        .run(agentId);
    } catch (err) {
      logError(this.db, "state_tracker.update_last_signal_at", { agentId }, err);
    }
  }

  // --- Private helpers ---

  private computeFingerprint(agentId: string): string {
    try {
      const sourceIds = this.resolveLiveRuntimeIds(agentId);
      if (sourceIds.length === 0) {
        return "";
      }

      const placeholders = sourceIds.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT data FROM terminal_outputs
           WHERE agent_id IN (${placeholders}) AND stream = 'stdout'
           ORDER BY id DESC LIMIT 20`,
        )
        .all(...sourceIds) as { data: string }[];
      const combined = rows
        .reverse()
        .map((r) => r.data)
        .join("");
      return combined.slice(-FINGERPRINT_CHARS);
    } catch (err) {
      logError(this.db, "state_tracker.compute_fingerprint", { agentId }, err);
      return "";
    }
  }

  private getAgentState(agentId: string): AgentStateRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM agent_states WHERE agent_id = ?")
        .get(agentId) as AgentStateRow | null) ?? null
    );
  }

  private logStuckDetection(
    agentId: string,
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
        .run(agentId, detectionType, fingerprint, JSON.stringify(details));
    } catch (err) {
      logError(this.db, "state_tracker.log_stuck_detection", { agentId, detectionType }, err);
    }
  }

  private resolveLiveRuntimeIds(agentId: string): string[] {
    const runtimeIds = this.db
      .prepare(
        `SELECT id
         FROM agent_instances
         WHERE template_agent_id = ?
           AND status IN ('running', 'waiting_delegation')
           AND process_pid IS NOT NULL
         ORDER BY created_at DESC`,
      )
      .all(agentId) as { id: string }[];

    const merged = [
      ...this.agentManager.getRunningInstancesForTemplate(agentId),
      ...runtimeIds.map((row) => row.id),
      agentId,
    ];

    const seen = new Set<string>();
    const resolved: string[] = [];
    for (const runtimeId of merged) {
      if (!runtimeId || seen.has(runtimeId)) continue;
      seen.add(runtimeId);
      resolved.push(runtimeId);
    }

    const delegatedRuntimeIds = resolved.filter((runtimeId) => runtimeId !== agentId);
    return delegatedRuntimeIds.length > 0 ? delegatedRuntimeIds : resolved;
  }

  /**
   * Return true when the template agent is intentionally blocked waiting on
   * active delegated children. This guards against stale agent_states rows
   * (e.g. state drift back to "working") causing false stuck nudges/escalations.
   */
  private isActivelyWaitingOnDelegation(agentId: string): boolean {
    // Check 1: agent has an instance in waiting_delegation with active child delegations
    const row = this.db
      .prepare(
        `SELECT ai.id
         FROM agent_instances ai
         WHERE ai.template_agent_id = ?
           AND ai.status = 'waiting_delegation'
           AND EXISTS (
             SELECT 1
             FROM delegations d
             WHERE d.parent_instance_id = ai.id
               AND d.status IN ('pending', 'running')
           )
         LIMIT 1`,
      )
      .get(agentId) as { id: string } | null;

    if (row) {
      // Reconcile stale state row to avoid repeated false positives.
      this.db
        .prepare(
          `UPDATE agent_states
           SET state = 'waiting_delegation',
               nudge_count = 0,
               updated_at = datetime('now')
           WHERE agent_id = ?`,
        )
        .run(agentId);
      return true;
    }

    // Check 2: agent's current task has other running/pending child instances.
    // This covers the entrypoint agent (e.g. skipper) which waits while delegated
    // children work — its stdout won't change but it's not stuck.
    const agentRow = this.db
      .prepare("SELECT current_task_id FROM agents WHERE id = ?")
      .get(agentId) as { current_task_id: string | null } | null;

    if (agentRow?.current_task_id) {
      const activeChild = this.db
        .prepare(
          `SELECT id FROM agent_instances
           WHERE task_id = ? AND template_agent_id != ?
             AND status IN ('running', 'pending')
           LIMIT 1`,
        )
        .get(agentRow.current_task_id, agentId) as { id: string } | null;

      if (activeChild) return true;
    }

    return false;
  }
}
