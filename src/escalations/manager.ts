import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { AgentManager } from "../agents/manager";
import type { PromptBuilder } from "../agents/prompt-builder";
import { agentTypeUsesInlinePrompt, getAgentTypeDefinition } from "../agents/types";
import { eventBus } from "../events/bus";
import { logError } from "../logging";

export interface Escalation {
  id: string;
  agent_id: string;
  runtime_agent_id: string | null;
  task_id: string;
  type: string;
  question: string;
  response: string | null;
  severity: string;
  status: "open" | "resolved";
  created_at: string;
  resolved_at: string | null;
}

export class EscalationManager {
  private db: Database;
  private agentManager: AgentManager;
  // Optional so tests that construct EscalationManager without a PromptBuilder
  // keep passing. When present, injectResponse prepends any unseen notes the
  // operator added alongside the escalation response so they land in the same
  // turn instead of being deferred until the next phase/delegation event.
  private promptBuilder: PromptBuilder | undefined;

  constructor(db?: Database, agentManager?: AgentManager, promptBuilder?: PromptBuilder) {
    const resolvedDb = db ?? getDb();
    this.db = resolvedDb;
    this.agentManager = agentManager ?? new AgentManager(resolvedDb);
    this.promptBuilder = promptBuilder;
  }

  /**
   * Handle an escalation signal from an agent.
   * The agentId may be a runtime instance ID or a template agent ID.
   * We resolve the task from either the agent_instances table or the agents table.
   */
  handleEscalation(agentId: string, question: string): Escalation | null {
    const resolved = this.resolveAgentAndTask(agentId);
    if (!resolved) return null;

    const { templateAgentId, taskId } = resolved;

    // Verify task is running
    const task = this.db
      .prepare("SELECT id, status FROM tasks WHERE id = ?")
      .get(taskId) as { id: string; status: string } | null;

    if (!task || task.status !== "running") return null;

    // Store the template agent ID in the escalation so resolution works correctly
    const escalation = this.createEscalation({
      agentId: templateAgentId,
      runtimeAgentId: agentId,
      taskId,
      type: "agent_request",
      question,
    });

    // Set agent state to escalated using the template agent ID
    this.setAgentState(templateAgentId, "escalated");

    eventBus.emit("escalation:created", {
      escalationId: escalation.id,
      agentId: templateAgentId,
      taskId,
      type: "agent_request",
      question,
    });

    return escalation;
  }

  createEscalation(input: {
    agentId: string;
    runtimeAgentId?: string | null;
    taskId: string;
    type: string;
    question: string;
    severity?: string;
  }): Escalation {
    const id = crypto.randomUUID();
    const severity = input.severity ?? "normal";

    this.db
      .prepare(
        `INSERT INTO escalations (id, agent_id, runtime_agent_id, task_id, type, question, severity)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.agentId, input.runtimeAgentId ?? null, input.taskId, input.type, input.question, severity);

    return this.getEscalation(id)!;
  }

  getEscalation(id: string): Escalation | null {
    const row = this.db
      .prepare("SELECT * FROM escalations WHERE id = ?")
      .get(id) as Escalation | null;
    return row ?? null;
  }

  listEscalations(status?: "open" | "resolved"): Escalation[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM escalations WHERE status = ? ORDER BY created_at DESC")
        .all(status) as Escalation[];
    }
    return this.db
      .prepare("SELECT * FROM escalations ORDER BY created_at DESC")
      .all() as Escalation[];
  }

  reconcileOpenEscalationsForInactiveTasks(): number {
    const result = this.db
      .prepare(
        `UPDATE escalations
         SET status = 'resolved',
             response = COALESCE(response, 'Auto-resolved: task is no longer running.'),
             resolved_at = datetime('now')
         WHERE status = 'open'
           AND task_id IN (
             SELECT id FROM tasks WHERE status != 'running'
           )`,
      )
      .run();

    return Number(result.changes ?? 0);
  }

  dismissEscalation(escalationId: string): Escalation {
    const escalation = this.getEscalation(escalationId);
    if (!escalation) {
      throw new Error(`Escalation not found: ${escalationId}`);
    }
    if (escalation.status !== "open") {
      throw new Error(`Can only dismiss open escalations, current status: ${escalation.status}`);
    }

    this.db
      .prepare(
        "UPDATE escalations SET response = ?, status = 'resolved', resolved_at = datetime('now') WHERE id = ?",
      )
      .run("Dismissed by operator.", escalationId);

    // Reset agent state back to working
    this.setAgentState(escalation.agent_id, "working");

    eventBus.emit("escalation:resolved", {
      escalationId,
      agentId: escalation.agent_id,
      taskId: escalation.task_id,
      response: "Dismissed by operator.",
    });

    return this.getEscalation(escalationId)!;
  }

  async resolveEscalation(escalationId: string, response: string): Promise<Escalation> {
    const escalation = this.getEscalation(escalationId);
    if (!escalation) {
      throw new Error(`Escalation not found: ${escalationId}`);
    }
    if (escalation.status === "resolved") {
      throw new Error(`Escalation already resolved: ${escalationId}`);
    }

    // Update escalation record
    this.db
      .prepare(
        "UPDATE escalations SET response = ?, status = 'resolved', resolved_at = datetime('now') WHERE id = ?",
      )
      .run(response, escalationId);

    // If the task is no longer running, do not revive any agent — just mark the
    // escalation resolved. injectResponse has a fallback that spawns a fresh
    // process when no runtime/resume path matches; without this guard, resolving
    // a stale escalation on a completed/failed/cancelled task would resurrect it.
    const taskRow = this.db
      .prepare("SELECT status FROM tasks WHERE id = ?")
      .get(escalation.task_id) as { status: string } | null;
    const taskTerminal = !taskRow || taskRow.status === "completed" || taskRow.status === "failed";

    if (!taskTerminal) {
      // Inject response into agent (try runtime instances first, then template agent)
      await this.injectResponse(escalation.agent_id, escalation.runtime_agent_id, escalation.task_id, response);

      // Reset agent state to working
      this.setAgentState(escalation.agent_id, "working");
    }

    eventBus.emit("escalation:resolved", {
      escalationId,
      agentId: escalation.agent_id,
      taskId: escalation.task_id,
      response,
    });

    return this.getEscalation(escalationId)!;
  }

  /**
   * Resolve the template agent ID and task ID from a runtime instance ID or template agent ID.
   */
  private resolveAgentAndTask(agentId: string): { templateAgentId: string; taskId: string } | null {
    // First try: runtime instance lookup via AgentManager
    const templateId = this.agentManager.getTemplateAgentId(agentId);
    if (templateId) {
      const running = this.agentManager.getRunningAgent(agentId);
      if (running?.taskId) {
        return { templateAgentId: templateId, taskId: running.taskId };
      }
    }

    // Second try: agent_instances table (instance may have exited but record persists)
    const instanceRow = this.db
      .prepare(
        `SELECT template_agent_id, task_id FROM agent_instances WHERE id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(agentId) as { template_agent_id: string; task_id: string } | null;

    if (instanceRow) {
      return { templateAgentId: instanceRow.template_agent_id, taskId: instanceRow.task_id };
    }

    // Third try: template agents table (for non-instance agents or legacy compatibility)
    const agentRow = this.db
      .prepare("SELECT id, current_task_id FROM agents WHERE id = ?")
      .get(agentId) as { id: string; current_task_id: string | null } | null;

    if (agentRow?.current_task_id) {
      return { templateAgentId: agentRow.id, taskId: agentRow.current_task_id };
    }

    return null;
  }

  /**
   * Inject an escalation response back to the agent.
   * Tries: running instance for the task → resume via template agent.
   */
  private async injectResponse(agentId: string, runtimeAgentId: string | null, taskId: string, response: string): Promise<void> {
    // Prefix any unseen notes so operator-added context lands in the same turn
    // as the response itself. Receipts are keyed on the template agent id
    // (matching advanceAndRespawn / poke behaviour) — recorded only after a
    // successful inject so failures here don't silently drop notes.
    const notes = this.promptBuilder?.buildNotesEnrichmentBlock?.(taskId, agentId)
      ?? { text: "", noteIds: [] };
    const baseMessage = `[USER_RESPONSE] ${response}`;
    const message = notes.text ? `${notes.text}\n${baseMessage}` : baseMessage;
    const markNotesDelivered = (): void => {
      if (notes.noteIds.length > 0) {
        this.promptBuilder?.recordNoteDelivery?.(agentId, notes.noteIds);
      }
    };

    // First try to continue the exact runtime instance that escalated.
    if (runtimeAgentId) {
      const escalatingRuntime = this.agentManager.getRunningAgent(runtimeAgentId);
      if (escalatingRuntime) {
        try {
          this.agentManager.sendInput(runtimeAgentId, message);
          markNotesDelivered();
          return;
        } catch (err) {
          logError(this.db, "escalation.inject_runtime_stdin", { agentId, runtimeAgentId }, err);
        }
      }

      try {
        const templateAgent = this.agentManager.getAgent(agentId);
        const typeDef = templateAgent ? getAgentTypeDefinition(templateAgent.type, this.db) : null;
        const closeStdin = !(typeDef?.supports_stdin ?? false);
        await this.agentManager.sendResumeMessage(runtimeAgentId, message, closeStdin);
        markNotesDelivered();
        return;
      } catch (err) {
        logError(this.db, "escalation.inject_runtime_resume", { agentId, runtimeAgentId }, err);
      }

      try {
        const templateAgent = this.agentManager.getAgent(agentId);
        if (templateAgent) {
          const typeDef = getAgentTypeDefinition(templateAgent.type, this.db);
          const usesInlinePrompt = typeDef ? agentTypeUsesInlinePrompt(typeDef) : false;
          await this.agentManager.spawnAgentInstance(agentId, runtimeAgentId, {
            workingDir: process.cwd(),
            taskId,
            parentInstanceId: null,
            rootInstanceId: runtimeAgentId,
            attempt: 1,
            initialPrompt: usesInlinePrompt ? message : undefined,
          });
          if (!usesInlinePrompt) {
            const closeStdin = !(typeDef?.supports_stdin ?? false);
            this.agentManager.sendInput(runtimeAgentId, message, closeStdin);
          }
          markNotesDelivered();
          return;
        }
      } catch (err) {
        logError(this.db, "escalation.inject_runtime_spawn", { agentId, runtimeAgentId, taskId }, err);
      }
    }

    // Try to find any running instance for this template agent on this task
    for (const [runtimeId, running] of this.agentManager.getRunningAgents()) {
      if (running.templateAgentId === agentId && running.taskId === taskId) {
        try {
          this.agentManager.sendInput(runtimeId, message);
          markNotesDelivered();
          return;
        } catch (err) {
          logError(this.db, "escalation.inject_stdin", { agentId, runtimeId }, err);
        }
      }
    }

    // No running instance — try direct runtime ID lookup (legacy path)
    const runningAgent = this.agentManager.getRunningAgent(agentId);
    if (runningAgent) {
      try {
        // Use the resolved runtime id — sendInput(agentId) would re-resolve the
        // template to an arbitrary sibling instance under parallel same-team runs.
        this.agentManager.sendInput(runningAgent.id, message);
        markNotesDelivered();
        return;
      } catch (err) {
        logError(this.db, "escalation.inject_stdin_direct", { agentId }, err);
      }
    }

    // Agent not running — try resume
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) return;

    try {
      const typeDef = getAgentTypeDefinition(agent.type, this.db);
      const closeStdin = !(typeDef?.supports_stdin ?? false);
      await this.agentManager.sendResumeMessage(agentId, message, closeStdin);
      markNotesDelivered();
      return;
    } catch (err) {
      logError(this.db, "escalation.inject_response", { agentId }, err);
    }

    // Resume not available/failed — spawn a fresh process and inject the response.
    // Must pass taskId so spawnRuntimeAgent can create the agent_instances row.
    // Without taskId the spawn now throws (orphan-prevention guard); the
    // escalation already has the taskId in scope so always pass it through.
    try {
      const typeDef = getAgentTypeDefinition(agent.type, this.db);
      const usesInlinePrompt = typeDef ? agentTypeUsesInlinePrompt(typeDef) : false;
      const spawned = await this.agentManager.spawnAgent(agentId, {
        workingDir: process.cwd(),
        taskId,
        initialPrompt: usesInlinePrompt ? message : undefined,
      });
      const closeStdin = !(typeDef?.supports_stdin ?? false);
      if (!usesInlinePrompt) {
        // Target the runtime instance just spawned, not the template id —
        // sendInput(templateId) misroutes to a sibling same-team task's stdin.
        this.agentManager.sendInput(spawned.id, message, closeStdin);
      }
      markNotesDelivered();
    } catch (err) {
      logError(this.db, "escalation.inject_fresh_spawn", { agentId, taskId }, err);
    }
  }

  private setAgentState(agentId: string, state: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO agent_states (agent_id, state)
           VALUES (?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             state = ?,
             updated_at = datetime('now')`,
        )
        .run(agentId, state, state);

      eventBus.emit("agent:state_changed", {
        agentId,
        previousState: "",
        newState: state,
      });
    } catch (err) {
      logError(this.db, "escalation.set_agent_state", { agentId, state }, err);
    }
  }
}
