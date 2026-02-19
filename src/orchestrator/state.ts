import type { Database } from "bun:sqlite";
import { logError } from "../logging";

export type TaskOrchStep =
  | "IDLE"
  | "AGENT_RUNNING"
  | "WAITING_DELEGATION"
  | "WAITING_CONSENSUS"
  | "ADVANCING_PHASE"
  | "REGRESSION"
  | "WAITING_ESCALATION"
  | "PAUSING"
  | "PAUSED"
  | "RECOVERING";

export const TRANSITIONS: Record<TaskOrchStep, readonly TaskOrchStep[]> = {
  IDLE: ["AGENT_RUNNING", "RECOVERING"],
  AGENT_RUNNING: ["WAITING_DELEGATION", "WAITING_CONSENSUS", "ADVANCING_PHASE", "REGRESSION", "WAITING_ESCALATION", "PAUSING", "IDLE"],
  WAITING_DELEGATION: ["AGENT_RUNNING", "WAITING_ESCALATION", "IDLE"],
  WAITING_CONSENSUS: ["AGENT_RUNNING", "WAITING_ESCALATION", "IDLE"],
  ADVANCING_PHASE: ["AGENT_RUNNING", "WAITING_ESCALATION", "IDLE"],
  REGRESSION: ["AGENT_RUNNING", "WAITING_ESCALATION", "IDLE"],
  WAITING_ESCALATION: ["AGENT_RUNNING", "IDLE"],
  PAUSING: ["PAUSED"],
  PAUSED: ["RECOVERING", "IDLE"],
  RECOVERING: ["AGENT_RUNNING", "IDLE"],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TaskOrchStep,
    public readonly to: TaskOrchStep,
    public readonly taskId: string,
  ) {
    super(`Invalid state transition for task ${taskId}: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function transition(from: TaskOrchStep, to: TaskOrchStep, taskId: string): TaskOrchStep {
  if (from === to) return to; // Self-transitions are always valid (state refresh)
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(from, to, taskId);
  }
  return to;
}

export class TaskStateMachine {
  constructor(
    private readonly taskId: string,
    private readonly db: Database,
  ) {}

  getCurrentStep(): TaskOrchStep {
    const row = this.db
      .prepare("SELECT orchestration_state FROM tasks WHERE id = ?")
      .get(this.taskId) as { orchestration_state: string } | null;

    if (!row) return "IDLE";

    try {
      const parsed = JSON.parse(row.orchestration_state);
      if (!parsed.step) return "IDLE";
      return parsed.step as TaskOrchStep;
    } catch (err) {
      logError(this.db, "orchestrator.state.parse", { taskId: this.taskId }, err);
      return "IDLE";
    }
  }

  transitionTo(newStep: TaskOrchStep): TaskOrchStep {
    const currentStep = this.getCurrentStep();
    const validatedStep = transition(currentStep, newStep, this.taskId);

    if (currentStep !== validatedStep) {
      this.logTransition(currentStep, validatedStep);
    }

    return validatedStep;
  }

  private logTransition(from: TaskOrchStep, to: TaskOrchStep): void {
    try {
      this.db
        .prepare(
          "INSERT INTO events (type, payload, task_id) VALUES (?, ?, ?)",
        )
        .run(
          "orchestration:transition",
          JSON.stringify({ from, to }),
          this.taskId,
        );
    } catch (err) {
      logError(this.db, "orchestrator.state.log_transition", { taskId: this.taskId, from, to }, err);
    }
  }
}
