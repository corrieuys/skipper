/**
 * Bumped when the connect protocol gains capabilities. Advertised to the
 * integrator via the `connect:capabilities` event and in state snapshots.
 * v2: fat events (embedded entity projections), state/snapshot resource.
 */
export const CONNECT_PROTOCOL_VERSION = 2;

/**
 * Task projection embedded in fat events and snapshots. Keeps the snake_case
 * keys the integrator web app already reads from REST task rows, and never
 * includes heavy fields (result, orchestration_state, description, task_config).
 */
export interface TaskListItem {
  id: string;
  title: string;
  status: string;
  task_type: string;
  team_id: string | null;
  team_name: string | null;
  current_phase: number;
  phase_count: number | null;
  needs_review: boolean;
  created_at: string;
  updated_at: string | null;
}

export interface EscalationItem {
  id: string;
  taskId: string;
  agentId: string;
  agentName: string | null;
  type: string;
  status: string;
  question: string;
  response: string | null;
  createdAt: string;
}

export interface NoteItem {
  id: string;
  taskId: string;
  agentName: string | null;
  content: string;
  createdAt: string;
}

/** Artifact projection without the body. */
export interface ArtifactItem {
  id: string;
  taskId: string;
  name: string;
  kind: string;
  version: number;
  description: string | null;
  createdAt: string;
  publishedAt: string | null;
  publicUrl: string | null;
}

export interface StateSnapshot {
  protocolVersion: number;
  ts: string;
  tasks: TaskListItem[];
  escalations: EscalationItem[];
  reviews: TaskListItem[];
  counts: { openEscalations: number; pendingReviews: number };
}

/** One coalesced agent-output line inside an output_batch frame. */
export interface OutputBatchEntry {
  agentId: string;
  agentName: string | null;
  stream: "stdout" | "stderr";
  data: string;
  ts: string;
}

export type ClientMessage =
  | { type: "result"; id: string; ok: boolean; data?: unknown; error?: string }
  | { type: "response"; id: string; ok: boolean; data?: unknown; error?: string }
  | { type: "event"; event: string; payload: unknown; ts: string; source: "skipper" }
  // Coalesced live output for one task; only sent while the server reports
  // at least one subscribed consumer (see output-tail.ts). seq is
  // per-connection and informational (gap hint), not for reassembly.
  | { type: "output_batch"; taskId: string; seq: number; entries: OutputBatchEntry[] }
  | { type: "pong" };

export type ServerMessage =
  | { type: "auth_ok" }
  | { type: "auth_error"; message: string }
  | { type: "command"; id: string; tool: ConnectTool; args: Record<string, unknown> }
  | { type: "request"; id: string; resource: string; action: string; params: Record<string, unknown> }
  // Integrator-side consumer demand for a task's live output tail. Sent on
  // 0→1 / 1→0 subscriber transitions; older servers never send these.
  | { type: "output_subscribe"; taskId: string }
  | { type: "output_unsubscribe"; taskId: string }
  | { type: "ping" };

export const CONNECT_TOOLS = [
  "create-task",
  "delete-task",
  "list-draft-tasks",
  "approve-task",
  "run-recurring-task",
] as const;

export type ConnectTool = (typeof CONNECT_TOOLS)[number];
