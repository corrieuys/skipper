import type { TaskOrchStep } from "./state";

export interface PendingRegression {
  targetPhase: number;
  reason: string;
}

export interface OrchestrationState {
  step: TaskOrchStep;
  last_checkpoint_ts: string | null;
  session_id: string | null;
  active_delegation_id: string | null;
  phase_guards: string[];
  pending_regression: PendingRegression | null;
  checkpoint_prompt_hash: string | null;
}

export interface TaskCheckpoint {
  id: number;
  task_id: string;
  sequence: number;
  checkpoint_type: string;
  session_id: string | null;
  context_snapshot: Record<string, unknown>;
  terminal_seq: number | null;
  created_at: string;
}
