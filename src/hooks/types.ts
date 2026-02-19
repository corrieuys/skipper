export interface HookDefinition {
  event: HookEventName;
  type: "curl";
  template: string;
  name?: string;
  disabled?: boolean;
}

export type HookEventName =
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "escalation.created"
  | "escalation.resolved"
  | "phase.review_pending";

export interface HookEventPayload {
  task_id: string;
  task_title?: string;
  team_id?: string;
  status?: string;
  error?: string;
  escalation_id?: string;
  body?: string;
  type?: string;
  agent_id?: string;
  response?: string;
  phase_name?: string;
  phase_index?: string;
}
