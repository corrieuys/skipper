import type { Database } from "bun:sqlite";
import { AgentManager } from "./manager";
import { eventBus } from "../events/bus";
import { logError } from "../db/log-error";

const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const MAX_NUDGES = 3;
const FINGERPRINT_CHARS = 500;

interface AgentStateRow {
  agent_id: string;
  state: string;
  screen_fingerprint: string | null;
  heartbeat_at: string;
  nudge_count: number;
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
        // Output changed → agent is active, refresh heartbeat
        this.db
          .prepare(
            `UPDATE agent_states
             SET screen_fingerprint = ?, heartbeat_at = datetime('now'), updated_at = datetime('now')
             WHERE agent_id = ?`,
          )
          .run(fingerprint, agentId);
      }
      // If fingerprint is unchanged → heartbeat stays old (no update)
    }
  }

  /**
   * Return agent IDs whose heartbeat has not been updated in over 5 minutes
   * and whose state is not one of the states that should be skipped.
   */
  getStuckCandidates(): string[] {
    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString();
    const rows = this.db
      .prepare(
        `SELECT as_.agent_id
         FROM agent_states as_
         JOIN agents a ON a.id = as_.agent_id
         WHERE a.process_pid IS NOT NULL
           AND as_.heartbeat_at < ?
           AND as_.state NOT IN ('waiting_delegation', 'escalated', 'stopped')`,
      )
      .all(cutoff) as { agent_id: string }[];
    return rows.map((r) => r.agent_id);
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

    const currentFingerprint = this.computeFingerprint(agentId);

    if (currentFingerprint === state.screen_fingerprint) {
      // Screen unchanged → confirmed stuck
      this.logStuckDetection(agentId, "stuck", currentFingerprint, {
        heartbeat_at: state.heartbeat_at,
        nudge_count: state.nudge_count,
      });
      return true;
    }

    // Screen changed since last check → agent is active, reset heartbeat
    this.db
      .prepare(
        `UPDATE agent_states
         SET screen_fingerprint = ?, heartbeat_at = datetime('now'), updated_at = datetime('now')
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

    const currentFingerprint = this.computeFingerprint(agentId);

    if (state.nudge_count < MAX_NUDGES) {
      const nudgeCount = state.nudge_count + 1;

      this.logStuckDetection(agentId, "nudged", currentFingerprint, {
        nudge_count: nudgeCount,
      });

      // Attempt to send a nudge via stdin
      try {
        this.agentManager.sendInput(
          agentId,
          `[SYSTEM] You appear to be idle. Please continue your work. (nudge ${nudgeCount}/${MAX_NUDGES})`,
        );
      } catch (err) {
        logError(this.db, "stuck_agent_nudge_failed", { agentId }, err);
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

      const escalationId = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO escalations (id, agent_id, task_id, type, question, severity)
           VALUES (?, ?, ?, 'stuck_agent', ?, 'high')`,
        )
        .run(
          escalationId,
          agentId,
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
    }
  }

  // --- Private helpers ---

  private computeFingerprint(agentId: string): string {
    try {
      const rows = this.db
        .prepare(
          `SELECT data FROM terminal_outputs
           WHERE agent_id = ? AND stream = 'stdout'
           ORDER BY sequence DESC LIMIT 20`,
        )
        .all(agentId) as { data: string }[];
      const combined = rows
        .reverse()
        .map((r) => r.data)
        .join("");
      return combined.slice(-FINGERPRINT_CHARS);
    } catch (err) {
      logError(this.db, "fingerprint_compute_failed", { agentId }, err);
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
      logError(this.db, "stuck_detection_log_failed", { agentId }, err);
    }
  }
}
