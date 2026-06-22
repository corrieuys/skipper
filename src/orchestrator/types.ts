import type { TaskOrchStep } from "./state";

export interface PendingRegression {
  targetPhase: number;
  reason: string;
}

// Everything spawnAgentInstance/spawnAgent needs to respawn a paused agent with
// --resume <session>. Persisted in OrchestrationState.paused_snapshots while a
// task is paused so resume survives a server restart.
export interface PausedAgentSnapshot {
  runtimeId: string; // == agent_instances.id
  templateAgentId: string;
  taskId: string;
  parentInstanceId: string | null;
  rootInstanceId: string | null;
  sessionId: string | null;
  attempt: number;
  isTemplateRuntime: boolean; // runtimeId === templateAgentId → spawnAgent vs spawnAgentInstance
}

export interface OrchestrationState {
  step: TaskOrchStep;
  last_checkpoint_ts: string | null;
  session_id: string | null;
  active_delegation_group_id: string | null;
  active_delegation_child_count: number;
  active_delegation_settled_count: number;
  phase_guards: string[];
  pending_regression: PendingRegression | null;
  checkpoint_prompt_hash: string | null;
  paused_snapshots?: PausedAgentSnapshot[]; // present only while step is PAUSED/PAUSING
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
