import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { AgentManager } from "../agents/manager";
import { eventBus } from "../events/bus";
import { logError } from "../logging";

export interface Escalation {
  id: string;
  agent_id: string;
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

  constructor(db?: Database, agentManager?: AgentManager) {
    const resolvedDb = db ?? getDb();
    this.db = resolvedDb;
    this.agentManager = agentManager ?? new AgentManager(resolvedDb);
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
    taskId: string;
    type: string;
    question: string;
    severity?: string;
  }): Escalation {
    const id = crypto.randomUUID();
    const severity = input.severity ?? "normal";

    this.db
      .prepare(
        `INSERT INTO escalations (id, agent_id, task_id, type, question, severity)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.agentId, input.taskId, input.type, input.question, severity);

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

    // Inject response into agent (try runtime instances first, then template agent)
    await this.injectResponse(escalation.agent_id, escalation.task_id, response);

    // Reset agent state to working
    this.setAgentState(escalation.agent_id, "working");

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
  private async injectResponse(agentId: string, taskId: string, response: string): Promise<void> {
    const message = `[USER_RESPONSE] ${response}`;

    // Try to find any running instance for this template agent on this task
    for (const [runtimeId, running] of this.agentManager.getRunningAgents()) {
      if (running.templateAgentId === agentId && running.taskId === taskId) {
        try {
          this.agentManager.sendInput(runtimeId, message);
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
        this.agentManager.sendInput(agentId, message);
        return;
      } catch (err) {
        logError(this.db, "escalation.inject_stdin_direct", { agentId }, err);
      }
    }

    // Agent not running — try resume
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) return;

    try {
      await this.agentManager.sendResumeMessage(agentId, message);
    } catch (err) {
      logError(this.db, "escalation.inject_response", { agentId }, err);
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
