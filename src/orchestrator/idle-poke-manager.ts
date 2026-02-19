import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { TaskScheduler } from "../tasks/scheduler";
import type { EscalationManager } from "../escalations/manager";
import type { PromptBuilder } from "../agents/prompt-builder";
import { agentTypeUsesInlinePrompt, getAgentTypeDefinition } from "../agents/types";
import { logError } from "../logging";

const IDLE_SINCE_KEY_PREFIX = "idle_since:";
const IDLE_POKE_COUNT_KEY_PREFIX = "idle_poke_count:";
const IDLE_POKE_FIRED_AT_KEY_PREFIX = "idle_poke_fired_at:";
const RECOVERY_ATTEMPT_KEY_PREFIX = "recovery_attempt:";

const IDLE_POKE_DELAY_MS = 60_000;
const IDLE_POKE_MAX_COUNT = 2;
const RECOVERY_COLLIDE_WINDOW_MS = 60_000;

const POKE_PROMPT = [
  "[SYSTEM] [IDLE_POKE] You exited without an outstanding delegation, escalation, or phase decision. Review your task progress (notes, artifacts, recent delegation results) and choose your next move:",
  "  • Delegate the next piece of work (delegate / delegate_resume)",
  "  • Regress to an earlier phase if something needs redoing (regress_phase)",
  "  • Complete the current phase if all acceptance criteria are met (complete_phase)",
  "  • Complete the entire task if the final phase is done (complete_task)",
  "  • Escalate to the operator if you are blocked (create_escalation)",
  "Do exactly one of these.",
].join("\n");

const ESCALATION_QUESTION =
  "Skipper has been pinged twice with no decision (delegate / regress / complete / escalate). What should happen next on this task?";

export class IdlePokeManager {
  constructor(
    private readonly db: Database,
    private readonly agentManager: AgentManager,
    private readonly taskScheduler: TaskScheduler,
    private readonly teamManager: {
      getTeamForExecution: (teamId: string) => { entrypoint_agent_id: string } | null;
    },
    private readonly escalationManager: EscalationManager,
    private readonly getActiveDelegationForParent: (parentRuntimeId: string) => unknown,
    // Optional so existing tests that mock IdlePokeManager without a PromptBuilder
    // keep passing. When present, pokes are prefixed with unseen notes so an
    // operator note added during idle isn't deferred to the next phase / delegation.
    private readonly promptBuilder?: PromptBuilder,
  ) {}

  /** Mark a task as having become idle (Skipper exited cleanly with nothing in flight). */
  markIdle(taskId: string): void {
    try {
      this.db
        .prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)")
        .run(`${IDLE_SINCE_KEY_PREFIX}${taskId}`, String(Date.now()));
    } catch (err) {
      logError(this.db, "idle_poke_mark_idle", { taskId, method: "markIdle" }, err);
    }
  }

  /** Clear all idle/poke state for a task (Skipper is active again, or task terminated). */
  clearIdle(taskId: string): void {
    try {
      const stmt = this.db.prepare("DELETE FROM daemon_state WHERE key = ?");
      stmt.run(`${IDLE_SINCE_KEY_PREFIX}${taskId}`);
      stmt.run(`${IDLE_POKE_COUNT_KEY_PREFIX}${taskId}`);
      stmt.run(`${IDLE_POKE_FIRED_AT_KEY_PREFIX}${taskId}`);
    } catch (err) {
      logError(this.db, "idle_poke_clear", { taskId, method: "clearIdle" }, err);
    }
  }

  /** Tick-loop entrypoint. Returns the number of pokes/escalations dispatched. */
  async runIdlePokes(): Promise<number> {
    let acted = 0;
    let candidates: Array<{ task_id: string; idle_since: number }>;
    try {
      const rows = this.db
        .prepare(
          `SELECT substr(key, length(?) + 1) AS task_id, value
           FROM daemon_state
           WHERE key LIKE ?`,
        )
        .all(IDLE_SINCE_KEY_PREFIX, `${IDLE_SINCE_KEY_PREFIX}%`) as Array<{ task_id: string; value: string }>;
      candidates = rows
        .map((r) => ({ task_id: r.task_id, idle_since: Number(r.value) }))
        .filter((r) => Number.isFinite(r.idle_since));
    } catch (err) {
      logError(this.db, "idle_poke_scan", { method: "runIdlePokes" }, err);
      return 0;
    }

    const now = Date.now();
    for (const { task_id: taskId, idle_since: idleSince } of candidates) {
      try {
        if (now - idleSince < IDLE_POKE_DELAY_MS) continue;
        if (!this.shouldPoke(taskId)) continue;

        const count = this.readPokeCount(taskId);
        if (count >= IDLE_POKE_MAX_COUNT) {
          this.escalateNoOp(taskId);
          acted++;
          continue;
        }

        const ok = await this.pokeSkipper(taskId);
        if (ok) {
          this.writePokeCount(taskId, count + 1);
          this.db
            .prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)")
            .run(`${IDLE_POKE_FIRED_AT_KEY_PREFIX}${taskId}`, String(now));
          this.db
            .prepare("DELETE FROM daemon_state WHERE key = ?")
            .run(`${IDLE_SINCE_KEY_PREFIX}${taskId}`);
          this.emitRemediationEvent("idle_poke_fired", null, taskId, {
            pokeCount: count + 1,
            idleForMs: now - idleSince,
          });
          acted++;
        }
      } catch (err) {
        logError(this.db, "idle_poke_iteration", { taskId, method: "runIdlePokes" }, err);
      }
    }

    return acted;
  }

  private shouldPoke(taskId: string): boolean {
    const task = this.taskScheduler.getTask(taskId);
    if (!task || task.status !== "running") return false;
    if (task.task_type === "real_time") return false;
    if (task.needs_review) return false;
    if (!task.team_id) return false;

    // Don't double-spawn with recovery
    const recoveryRow = this.db
      .prepare("SELECT value FROM daemon_state WHERE key = ?")
      .get(`${RECOVERY_ATTEMPT_KEY_PREFIX}${taskId}`) as { value: string } | null;
    if (recoveryRow) {
      try {
        const parsed = JSON.parse(recoveryRow.value) as { attemptedAt?: string };
        if (parsed.attemptedAt) {
          const attemptedAtMs = Date.parse(parsed.attemptedAt);
          if (Number.isFinite(attemptedAtMs) && Date.now() - attemptedAtMs < RECOVERY_COLLIDE_WINDOW_MS) {
            return false;
          }
        }
      } catch {
        // ignore parse failure
      }
    }

    // Open escalation → operator is already in the loop
    const openEscalation = this.db
      .prepare("SELECT 1 FROM escalations WHERE task_id = ? AND status = 'open' LIMIT 1")
      .get(taskId) as { 1: number } | null;
    if (openEscalation) return false;

    const teamExec = this.teamManager.getTeamForExecution(task.team_id);
    if (!teamExec) return false;
    const entrypointAgentId = teamExec.entrypoint_agent_id;

    // Live entrypoint? Skipper is already running, nothing to poke
    if (this.agentManager.getRunningAgent(entrypointAgentId)) return false;

    // Any active delegation on this task — regardless of which Skipper instance
    // issued it — means a child agent is still in flight and Skipper must wait
    // for the result to be routed back. Looking up only the most recent
    // entrypoint instance misses the case where Skipper was respawned (e.g. by
    // a previous idle poke, phase regression, or recovery) while a child it
    // spawned is still running: the child's parent_instance_id points at an
    // older Skipper row, the "latest" row has no delegation, and the poke
    // would otherwise spawn a second Skipper while the tester (or any other
    // delegated phase agent) is still working.
    const activeChildDelegation = this.db
      .prepare(
        `SELECT 1 FROM delegations
         WHERE task_id = ? AND status IN ('pending', 'running') LIMIT 1`,
      )
      .get(taskId) as { 1: number } | null;
    if (activeChildDelegation) return false;

    // Final belt-and-braces: any running child agent_instance for this task
    // (covers consensus fan-out and any path that bypasses the delegations
    // table).
    const runningChild = this.db
      .prepare(
        `SELECT 1 FROM agent_instances
         WHERE task_id = ? AND template_agent_id != ? AND status IN ('running', 'waiting_delegation') LIMIT 1`,
      )
      .get(taskId, entrypointAgentId) as { 1: number } | null;
    if (runningChild) return false;

    return true;
  }

  private async pokeSkipper(taskId: string): Promise<boolean> {
    const task = this.taskScheduler.getTask(taskId);
    if (!task || !task.team_id) return false;
    const teamExec = this.teamManager.getTeamForExecution(task.team_id);
    if (!teamExec) return false;
    const entrypointAgentId = teamExec.entrypoint_agent_id;

    const agent = this.agentManager.getAgent(entrypointAgentId);
    if (!agent) return false;
    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    if (!typeDef) return false;

    const sessionId = this.agentManager.getEntrypointSessionIdForTask(taskId, entrypointAgentId);
    const canResume = (typeDef.supports_resume ?? false) && !!sessionId;
    const usesInlinePrompt = agentTypeUsesInlinePrompt(typeDef, canResume ? sessionId : null);
    const isStreaming = typeDef.supports_stdin ?? false;

    // Prepend any unseen operator/agent notes so a note added during idle
    // arrives in this poke instead of being deferred until the next phase
    // advance or delegation result. Receipts are keyed on the template
    // entrypoint id, matching how advanceAndRespawn / buildInitialPromptTracked
    // record them — keeps the "delivered" set consistent across paths.
    const notes = this.promptBuilder?.buildNotesEnrichmentBlock?.(taskId, entrypointAgentId)
      ?? { text: "", noteIds: [] };
    const promptWithNotes = notes.text ? `${notes.text}\n${POKE_PROMPT}` : POKE_PROMPT;

    if (this.agentManager.getRunningAgent(entrypointAgentId)) {
      this.agentManager.killAgent(entrypointAgentId);
      await this.agentManager.waitForExit(entrypointAgentId);
    }

    try {
      const workingDir = process.cwd();
      const spawnOpts = canResume
        ? { workingDir, taskId, sessionId: sessionId!, initialPrompt: usesInlinePrompt ? promptWithNotes : undefined }
        : { workingDir, taskId, initialPrompt: usesInlinePrompt ? promptWithNotes : undefined };
      await this.agentManager.spawnAgent(entrypointAgentId, spawnOpts);
    } catch (err) {
      logError(this.db, "idle_poke_spawn", { taskId, agentId: entrypointAgentId, method: "pokeSkipper" }, err);
      return false;
    }

    if (!this.agentManager.getRunningAgent(entrypointAgentId)) {
      logError(this.db, "idle_poke_spawn_unconfirmed", { taskId, agentId: entrypointAgentId, method: "pokeSkipper" }, new Error("Spawn did not result in a running agent"));
      return false;
    }

    this.db
      .prepare("UPDATE agents SET current_task_id = ? WHERE id = ?")
      .run(taskId, entrypointAgentId);

    if (!usesInlinePrompt) {
      const closeStdin = !isStreaming;
      try {
        this.agentManager.sendInput(entrypointAgentId, promptWithNotes, closeStdin);
      } catch (err) {
        logError(this.db, "idle_poke_send_input", { taskId, agentId: entrypointAgentId, method: "pokeSkipper" }, err);
        return false;
      }
    }

    // Record delivery only after the prompt has been handed to the agent (via
    // inline initialPrompt or sendInput). If the spawn/send path bailed
    // earlier, notes stay unread and will be re-injected next time.
    if (notes.noteIds.length > 0) {
      this.promptBuilder?.recordNoteDelivery?.(entrypointAgentId, notes.noteIds);
    }

    return true;
  }

  private escalateNoOp(taskId: string): void {
    const task = this.taskScheduler.getTask(taskId);
    if (!task || !task.team_id) return;
    const teamExec = this.teamManager.getTeamForExecution(task.team_id);
    if (!teamExec) return;

    try {
      this.escalationManager.createEscalation({
        agentId: teamExec.entrypoint_agent_id,
        runtimeAgentId: null,
        taskId,
        type: "idle_poke_exhausted",
        question: ESCALATION_QUESTION,
      });
    } catch (err) {
      logError(this.db, "idle_poke_escalate", { taskId, method: "escalateNoOp" }, err);
      return;
    }

    this.clearIdle(taskId);
    this.emitRemediationEvent("idle_poke_escalated", null, taskId, {});
  }

  private readPokeCount(taskId: string): number {
    try {
      const row = this.db
        .prepare("SELECT value FROM daemon_state WHERE key = ?")
        .get(`${IDLE_POKE_COUNT_KEY_PREFIX}${taskId}`) as { value: string } | null;
      const n = Number(row?.value ?? 0);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  private writePokeCount(taskId: string, count: number): void {
    try {
      this.db
        .prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)")
        .run(`${IDLE_POKE_COUNT_KEY_PREFIX}${taskId}`, String(count));
    } catch (err) {
      logError(this.db, "idle_poke_count_write", { taskId, count, method: "writePokeCount" }, err);
    }
  }

  private emitRemediationEvent(
    type: string,
    agentId: string | null,
    taskId: string | null,
    details: Record<string, unknown>,
  ): void {
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
}
