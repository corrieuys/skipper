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
  /** Set when this task is a run of a recurring task; null for standalone tasks.
   * Lets clients present recurring runs separately (like the main UI, which
   * keeps non-active recurring runs out of the Active/Teams lists). */
  source_scheduled_task_id: string | null;
}

/** One run of a recurring task, for the recurring series' run strip. */
export interface RecurringRunItem {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

/** A recurring task (series) plus its most recent runs. `recurring/list`. */
export interface RecurringSeriesItem {
  id: string;
  title: string;
  description: string | null;
  teamId: string | null;
  teamName: string | null;
  scheduleUnit: string | null;
  scheduleAmount: number | null;
  scheduleMatrix: string | null;
  status: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runs: RecurringRunItem[];
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

/**
 * Operator message projection (agent → human progress update). Shares NoteItem's
 * shape but is a distinct register: messages are operator-only and never fed back
 * into any agent prompt. Carried by the `task:message_posted` fat event and the
 * `messages/list` resource.
 */
export interface MessageItem {
  id: string;
  taskId: string;
  agentName: string | null;
  content: string;
  /** Body format: 'text' | 'markdown' | 'html'. Null on legacy rows (= text). */
  format: string | null;
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
  /** Body format: 'html' | 'markdown' | 'text'. Null on legacy rows (heuristic). */
  format: string | null;
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
  /** True when a task-title generator agent is configured, so a remote client
   *  may create a task with a blank title (the daemon fills it in async). */
  titleGeneratorConfigured: boolean;
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
  // `backfill: true` marks the one-shot history frame sent immediately on
  // subscribe (recent terminal output up to the subscribe point); live frames
  // that follow omit it. Lets the integrator seed a task's timeline from a
  // single subscribe with no separate read and no read-then-subscribe gap.
  | { type: "output_batch"; taskId: string; seq: number; entries: OutputBatchEntry[]; backfill?: boolean }
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
