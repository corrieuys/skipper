import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { AgentManager } from "../agents/manager";
import { eventBus } from "../events/bus";
import { logError } from "../db/log-error";

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

  handleEscalation(agentId: string, question: string): Escalation | null {
    // Validate agent has an active task
    const agentRow = this.db
      .prepare("SELECT current_task_id FROM agents WHERE id = ?")
      .get(agentId) as { current_task_id: string | null } | null;

    if (!agentRow?.current_task_id) return null;

    const taskId = agentRow.current_task_id;

    // Verify task is running
    const task = this.db
      .prepare("SELECT id, status FROM tasks WHERE id = ?")
      .get(taskId) as { id: string; status: string } | null;

    if (!task || task.status !== "running") return null;

    // Create escalation record
    const escalation = this.createEscalation({
      agentId,
      taskId,
      type: "agent_request",
      question,
    });

    // Set agent state to escalated
    this.setAgentState(agentId, "escalated");

    // Emit escalation:created event
    eventBus.emit("escalation:created", {
      escalationId: escalation.id,
      agentId,
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

    // Inject response into agent
    await this.injectResponse(escalation.agent_id, response);

    // Reset agent state to working
    this.setAgentState(escalation.agent_id, "working");

    // Emit escalation:resolved event
    eventBus.emit("escalation:resolved", {
      escalationId,
      agentId: escalation.agent_id,
      taskId: escalation.task_id,
      response,
    });

    return this.getEscalation(escalationId)!;
  }

  private async injectResponse(agentId: string, response: string): Promise<void> {
    const message = `[USER_RESPONSE] ${response}`;

    // Try stdin first if agent is still running
    const runningAgent = this.agentManager.getRunningAgent(agentId);
    if (runningAgent) {
      this.agentManager.sendInput(agentId, message);
      return;
    }

    // Agent not running — try resume
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) return;

    try {
      await this.agentManager.sendResumeMessage(agentId, message);
    } catch (err) {
      logError(this.db, "escalation_inject_response_failed", { agentId }, err);
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
      logError(this.db, "state_update_failed", { agentId }, err);
    }
  }
}
